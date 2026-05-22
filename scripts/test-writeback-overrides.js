#!/usr/bin/env node
/**
 * B6 — Manual Overrides board writeback.
 *
 * Tests:
 *   - buildWritebackMutations(validationResults, today) → { mutations, omitted }
 *       Pure. Maps each accepted row to a Status='Applied' mutation, each
 *       conflict row to a Status='Conflict' mutation with conflictReason
 *       populated. Rows missing rowId go to `omitted` instead of `mutations`.
 *   - serializeColumnValues(cv) → string
 *       Pure. JSON-encodes the column-values object for the change_multiple_
 *       column_values mutation's `column_values: String!` argument.
 *   - writeRowDecisions(validationResults, opts) → { written, skipped, errors }
 *       Side-effectful (calls gqlFn). Iterates mutations, rate-limits with
 *       injected sleep, captures per-row errors without aborting the loop.
 *       dryRun mode skips all gqlFn calls.
 *
 * Synthetic fixtures only — no MONDAY_API_TOKEN, no real monday I/O.
 */

const {
  buildWritebackMutations,
  serializeColumnValues,
  writeRowDecisions,
  COL,
  BOARD_OVERRIDES,
} = require('./writeback-overrides.js');

const failures = [];
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}: ${detail}`);
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

const TODAY = '2026-05-22';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCEPTED_ROW = (overrides = {}) => ({
  rowId: '101',
  decision: 'accepted',
  jobMpmId: 'MPM-A', jobId: 'PL-A',
  fromCrew: null, fromWeek: null,
  toCrew: 'Ian', toWeek: '2026-05-25',
  hours: 8,
  ...overrides,
});

const CONFLICT_ROW = (overrides = {}) => ({
  rowId: '201',
  decision: 'conflict',
  reason: 'pin week 2026-06-08 is past job Quince delivery 2026-05-29',
  ...overrides,
});

// ---------------------------------------------------------------------------

(async () => {

  // ==========================================================================
  // buildWritebackMutations
  // ==========================================================================

  console.log('Test 1: buildWritebackMutations — empty input returns empty buckets');
  {
    const out = buildWritebackMutations({ accepted: [], conflicts: [] }, TODAY);
    check('mutations is []', Array.isArray(out.mutations) && out.mutations.length === 0, JSON.stringify(out));
    check('omitted is []', Array.isArray(out.omitted) && out.omitted.length === 0, JSON.stringify(out));
  }

  console.log('\nTest 2: buildWritebackMutations — all-accepted batch maps Status=Applied with empty Conflict Reason');
  {
    const out = buildWritebackMutations({
      accepted: [ACCEPTED_ROW({ rowId: '101' }), ACCEPTED_ROW({ rowId: '102' })],
      conflicts: [],
    }, TODAY);
    check('2 mutations produced', out.mutations.length === 2, JSON.stringify(out.mutations));
    check('all itemIds present',
      out.mutations.every(m => m.itemId === '101' || m.itemId === '102'),
      JSON.stringify(out.mutations.map(m => m.itemId)));
    const m = out.mutations[0];
    check('status column set with label=Applied',
      m.columnValues?.[COL.status]?.label === 'Applied',
      JSON.stringify(m.columnValues));
    check('conflictReason column is empty text',
      m.columnValues?.[COL.conflictReason]?.text === '',
      JSON.stringify(m.columnValues));
    check('lastRun column set to today ISO date',
      m.columnValues?.[COL.lastRun]?.date === TODAY,
      JSON.stringify(m.columnValues));
    check('decision tag = accepted', m.decision === 'accepted', JSON.stringify(m));
  }

  console.log('\nTest 3: buildWritebackMutations — all-conflict batch maps Status=Conflict with populated Conflict Reason');
  {
    const out = buildWritebackMutations({
      accepted: [],
      conflicts: [
        CONFLICT_ROW({ rowId: '201', reason: 'reason-A' }),
        CONFLICT_ROW({ rowId: '202', reason: 'reason-B' }),
      ],
    }, TODAY);
    check('2 mutations produced', out.mutations.length === 2, JSON.stringify(out.mutations));
    const byId = Object.fromEntries(out.mutations.map(m => [m.itemId, m]));
    check('item 201 has Status=Conflict + reason-A',
      byId['201']?.columnValues?.[COL.status]?.label === 'Conflict'
      && byId['201']?.columnValues?.[COL.conflictReason]?.text === 'reason-A',
      JSON.stringify(byId['201']?.columnValues));
    check('item 202 has Status=Conflict + reason-B',
      byId['202']?.columnValues?.[COL.status]?.label === 'Conflict'
      && byId['202']?.columnValues?.[COL.conflictReason]?.text === 'reason-B',
      JSON.stringify(byId['202']?.columnValues));
    check('both decisions tagged "conflict"',
      out.mutations.every(m => m.decision === 'conflict'),
      JSON.stringify(out.mutations.map(m => m.decision)));
  }

  console.log('\nTest 4: buildWritebackMutations — mixed batch keeps both groups in mutation order');
  {
    const out = buildWritebackMutations({
      accepted: [ACCEPTED_ROW({ rowId: '301' })],
      conflicts: [CONFLICT_ROW({ rowId: '302' })],
    }, TODAY);
    check('2 mutations produced', out.mutations.length === 2, JSON.stringify(out.mutations));
    check('first is accepted (301)', out.mutations[0]?.itemId === '301' && out.mutations[0]?.decision === 'accepted', JSON.stringify(out.mutations[0]));
    check('second is conflict (302)', out.mutations[1]?.itemId === '302' && out.mutations[1]?.decision === 'conflict', JSON.stringify(out.mutations[1]));
  }

  console.log('\nTest 5: buildWritebackMutations — rows missing rowId go to omitted, not mutations');
  {
    const out = buildWritebackMutations({
      accepted: [ACCEPTED_ROW({ rowId: '401' }), ACCEPTED_ROW({ rowId: null })],
      conflicts: [CONFLICT_ROW({ rowId: undefined, reason: 'still bad' })],
    }, TODAY);
    check('1 mutation (the row with rowId)', out.mutations.length === 1, JSON.stringify(out.mutations));
    check('the valid row is the one that landed in mutations', out.mutations[0]?.itemId === '401', JSON.stringify(out.mutations));
    check('2 omitted entries', out.omitted.length === 2, JSON.stringify(out.omitted));
    check('every omitted has a reason mentioning rowId', out.omitted.every(o => /rowId/i.test(o.reason || '')), JSON.stringify(out.omitted));
  }

  // ==========================================================================
  // serializeColumnValues
  // ==========================================================================

  console.log('\nTest 6: serializeColumnValues — returns JSON-encoded string');
  {
    const cv = {
      [COL.status]: { label: 'Applied' },
      [COL.conflictReason]: { text: '' },
      [COL.lastRun]: { date: TODAY },
    };
    const out = serializeColumnValues(cv);
    check('returns a string', typeof out === 'string', `typeof=${typeof out}`);
    check('parses back to the original object', JSON.stringify(JSON.parse(out)) === JSON.stringify(cv), out);
    check('contains the Applied label', /Applied/.test(out), out);
    check('contains the lastRun date', out.includes(TODAY), out);
  }

  console.log('\nTest 7: serializeColumnValues — conflict shape encodes reason inside text key');
  {
    const cv = {
      [COL.status]: { label: 'Conflict' },
      [COL.conflictReason]: { text: 'pin week past delivery' },
      [COL.lastRun]: { date: TODAY },
    };
    const parsed = JSON.parse(serializeColumnValues(cv));
    check('Conflict label preserved', parsed[COL.status]?.label === 'Conflict', JSON.stringify(parsed));
    check('conflictReason.text preserved', parsed[COL.conflictReason]?.text === 'pin week past delivery', JSON.stringify(parsed));
  }

  // ==========================================================================
  // writeRowDecisions
  // ==========================================================================

  console.log('\nTest 8: writeRowDecisions — calls gqlFn once per mutation in order, rate-limit between');
  {
    const calls = [];
    let sleepCalls = 0;
    const stubGql = async (q, vars) => {
      calls.push({ query: q, variables: vars });
      return { change_multiple_column_values: { id: vars.itemId } };
    };
    const stubSleep = async (ms) => { sleepCalls++; };
    const out = await writeRowDecisions(
      { accepted: [ACCEPTED_ROW({ rowId: '801' }), ACCEPTED_ROW({ rowId: '802' }), ACCEPTED_ROW({ rowId: '803' })],
        conflicts: [] },
      { gqlFn: stubGql, today: TODAY, dryRun: false, rateLimitMs: 150, sleep: stubSleep },
    );
    check('written = 3', out.written === 3, JSON.stringify(out));
    check('skipped = 0', out.skipped === 0, JSON.stringify(out));
    check('errors = []', out.errors.length === 0, JSON.stringify(out));
    check('gqlFn called 3 times', calls.length === 3, JSON.stringify(calls.map(c => c.variables?.itemId)));
    check('call order: 801, 802, 803',
      calls[0]?.variables?.itemId === '801'
      && calls[1]?.variables?.itemId === '802'
      && calls[2]?.variables?.itemId === '803',
      JSON.stringify(calls.map(c => c.variables?.itemId)));
    check('sleep called (n-1) = 2 times', sleepCalls === 2, `sleepCalls=${sleepCalls}`);
    // Verify each variables object has the right shape for the gqlFn call.
    const v0 = calls[0]?.variables;
    check('variables include boardId, itemId, cv (string)',
      String(v0?.boardId) === String(BOARD_OVERRIDES)
      && typeof v0?.itemId === 'string'
      && typeof v0?.cv === 'string',
      JSON.stringify(v0));
    check('cv string contains Applied label', v0?.cv.includes('Applied'), v0?.cv);
  }

  console.log('\nTest 9: writeRowDecisions — dry-run mode does not call gqlFn but counts in skipped');
  {
    const calls = [];
    const stubGql = async () => { calls.push('called'); };
    let sleepCalls = 0;
    const stubSleep = async () => { sleepCalls++; };
    const out = await writeRowDecisions(
      { accepted: [ACCEPTED_ROW({ rowId: '901' }), ACCEPTED_ROW({ rowId: '902' })],
        conflicts: [CONFLICT_ROW({ rowId: '903' })] },
      { gqlFn: stubGql, today: TODAY, dryRun: true, rateLimitMs: 150, sleep: stubSleep },
    );
    check('written = 0', out.written === 0, JSON.stringify(out));
    check('skipped = 3', out.skipped === 3, JSON.stringify(out));
    check('errors = []', out.errors.length === 0, JSON.stringify(out));
    check('gqlFn never called', calls.length === 0, JSON.stringify(calls));
    check('sleep not called in dry-run (no I/O to rate-limit)', sleepCalls === 0, `sleepCalls=${sleepCalls}`);
  }

  console.log('\nTest 10: writeRowDecisions — gqlFn rejection captured in errors, loop continues');
  {
    const calls = [];
    const stubGql = async (q, vars) => {
      calls.push(vars.itemId);
      if (vars.itemId === '1002') throw new Error('synthetic monday rate-limit');
      return { change_multiple_column_values: { id: vars.itemId } };
    };
    const stubSleep = async () => {};
    const out = await writeRowDecisions(
      { accepted: [
          ACCEPTED_ROW({ rowId: '1001' }),
          ACCEPTED_ROW({ rowId: '1002' }),
          ACCEPTED_ROW({ rowId: '1003' }),
        ], conflicts: [] },
      { gqlFn: stubGql, today: TODAY, sleep: stubSleep },
    );
    check('written = 2 (1001 + 1003)', out.written === 2, JSON.stringify(out));
    check('errors has 1 entry', out.errors.length === 1, JSON.stringify(out.errors));
    check('error entry references rowId 1002', out.errors[0]?.rowId === '1002', JSON.stringify(out.errors[0]));
    check('error captures the message', /rate-limit/.test(out.errors[0]?.error || ''), out.errors[0]?.error);
    check('all 3 rows attempted (loop did not abort)', calls.length === 3 && calls.includes('1003'), JSON.stringify(calls));
  }

  console.log('\nTest 11: writeRowDecisions — empty input → no-op, zero counts');
  {
    let gqlCalls = 0, sleepCalls = 0;
    const out = await writeRowDecisions(
      { accepted: [], conflicts: [] },
      { gqlFn: async () => { gqlCalls++; }, today: TODAY, sleep: async () => { sleepCalls++; } },
    );
    check('written = 0', out.written === 0, JSON.stringify(out));
    check('skipped = 0', out.skipped === 0, JSON.stringify(out));
    check('errors = []', out.errors.length === 0, JSON.stringify(out));
    check('gqlFn never called', gqlCalls === 0, `gqlCalls=${gqlCalls}`);
    check('sleep never called', sleepCalls === 0, `sleepCalls=${sleepCalls}`);
  }

  console.log('\nTest 12: writeRowDecisions — missing-rowId entries counted as skipped (omitted from mutations)');
  {
    let gqlCalls = 0;
    const stubGql = async () => { gqlCalls++; };
    const out = await writeRowDecisions(
      { accepted: [ACCEPTED_ROW({ rowId: '1201' }), ACCEPTED_ROW({ rowId: null })],
        conflicts: [CONFLICT_ROW({ rowId: undefined, reason: 'oops' })] },
      { gqlFn: stubGql, today: TODAY, sleep: async () => {} },
    );
    check('written = 1', out.written === 1, JSON.stringify(out));
    check('skipped = 2 (the two missing-rowId rows)', out.skipped === 2, JSON.stringify(out));
    check('gqlFn called once', gqlCalls === 1, `gqlCalls=${gqlCalls}`);
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All B6 writeback-overrides tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
