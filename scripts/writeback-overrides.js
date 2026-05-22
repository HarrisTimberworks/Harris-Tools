// B6 — Manual Overrides board writeback.
//
// Sibling module to scripts/validate-overrides.js. Writes validation
// decisions back to the Manual Overrides board: flips Status (Pending
// → Applied or Conflict), populates Conflict Reason for conflicts,
// stamps Last Run.
//
// Spec-deviation rationale: the design spec puts writeback inside
// Step 4 (commit / --execute), but Phase 1 fires writeback at --plan
// time instead. Operator UX is much better when conflicts surface on
// the board immediately after validation instead of waiting for a
// separate --execute. Validation is the dry-run in Phase 1 vocabulary;
// writing Status back is metadata, not schedule application. Re-running
// --plan with no board edits is idempotent (same overrides → same
// decisions → same writeback values), so doing it twice causes no
// observable churn. Phase 3 (cloud automation) may revisit this
// timing if a notification surface wants to fire only on transitions
// rather than every re-evaluation — that's a Phase 3 problem.
//
// Two pure helpers + one async writer, all dependency-injected so the
// test harness (scripts/test-writeback-overrides.js) verifies behavior
// without monday I/O.

// Column IDs on the Manual Overrides board (board 18413101550), captured in
// docs/htw-cross-training-matrix.md §13. Exported so the test harness can
// build expected mutation shapes against the same constants the writer uses.
const BOARD_OVERRIDES = 18413101550;
const COL = Object.freeze({
  status:         'color_mm3aqx5g',
  conflictReason: 'long_text_mm3a99d0',
  lastRun:        'date_mm3axrbq',
});

// Pure. Maps each row in (accepted ∪ conflicts) to a per-row mutation
// payload, partitioning rows missing rowId into `omitted` so the writer
// can count them as skipped without attempting the call. The decision
// tag rides along on each mutation for logging/diagnostic purposes; the
// real signal monday consumes is the Status column-value label.
//
// Conflict Reason uses {text: ''} on accepted rows to actively clear any
// stale reason left over from a previous Conflict decision on the same
// row — re-running --plan against a row that flipped from Conflict to
// Accepted shouldn't leave stale text visible to the operator.
function buildWritebackMutations(validationResults, today) {
  const mutations = [];
  const omitted = [];

  const push = (row, decision) => {
    if (!row.rowId) {
      omitted.push({ ...row, reason: 'missing rowId — cannot target item without a monday item id' });
      return;
    }
    mutations.push({
      itemId: String(row.rowId),
      decision,
      columnValues: {
        [COL.status]:         { label: decision === 'accepted' ? 'Applied' : 'Conflict' },
        [COL.conflictReason]: { text: decision === 'conflict' ? (row.reason || '') : '' },
        [COL.lastRun]:        { date: today },
      },
    });
  };

  for (const a of validationResults.accepted || []) push(a, 'accepted');
  for (const c of validationResults.conflicts || []) push(c, 'conflict');

  return { mutations, omitted };
}

// Pure. JSON-encodes the column_values object for monday's
// change_multiple_column_values argument. monday accepts column_values
// as a JSON string (the GraphQL JSON scalar serializes to/from string),
// so this is just JSON.stringify — exposed as a named helper so callers
// don't litter their code with the same JSON.stringify call.
function serializeColumnValues(columnValues) {
  return JSON.stringify(columnValues);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Async. Iterates the mutation list, calls gqlFn per row, rate-limits
// between calls. Errors from one row do not abort the loop — each row
// is independent metadata, and surfacing all problems at once is more
// useful than failing on the first.
//
// Returns { written, skipped, errors }:
//   - written:  actual mutations that landed
//   - skipped:  dry-run-skipped rows + missing-rowId rows from buildWritebackMutations
//   - errors:   [{ rowId, error }] for gqlFn rejections
//
// Dependencies are injectable for tests:
//   - gqlFn: async (query, variables) → result. Required unless dryRun.
//   - sleep: async (ms). Default = real setTimeout-based delay.
//   - today: 'YYYY-MM-DD' string passed through to buildWritebackMutations.
//   - dryRun: bool. Skips every gqlFn call AND every sleep (no I/O to pace).
//   - rateLimitMs: number, default 150 (matches validate-cross-training.js
//     precedent). 0 disables the inter-call sleep.
//   - logger: { log } — defaults to global console. Used for dry-run line
//     items and error summaries.
async function writeRowDecisions(validationResults, opts = {}) {
  const {
    gqlFn,
    today,
    dryRun = false,
    rateLimitMs = 150,
    sleep = defaultSleep,
    logger = console,
  } = opts;

  const { mutations, omitted } = buildWritebackMutations(validationResults, today);
  let written = 0;
  let skipped = omitted.length;
  const errors = [];

  for (const o of omitted) {
    logger.log(`  ⚠️  omitted row ${o.rowId === undefined ? '(undefined)' : 'null'}: ${o.reason}`);
  }

  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];

    if (dryRun) {
      logger.log(`  [DRY RUN] would update item ${m.itemId} → Status=${m.decision === 'accepted' ? 'Applied' : 'Conflict'}`);
      skipped++;
      continue;
    }

    const cvString = serializeColumnValues(m.columnValues);
    const query = `mutation ($itemId: ID!, $boardId: ID!, $cv: JSON!) {
      change_multiple_column_values(item_id: $itemId, board_id: $boardId, column_values: $cv) { id }
    }`;
    try {
      await gqlFn(query, {
        itemId: String(m.itemId),
        boardId: String(BOARD_OVERRIDES),
        cv: cvString,
      });
      written++;
    } catch (e) {
      errors.push({ rowId: m.itemId, error: e.message || String(e) });
      logger.log(`  ✗ writeback failed for row ${m.itemId}: ${e.message || e}`);
    }

    if (i < mutations.length - 1 && rateLimitMs > 0) {
      await sleep(rateLimitMs);
    }
  }

  return { written, skipped, errors };
}

module.exports = {
  buildWritebackMutations,
  serializeColumnValues,
  writeRowDecisions,
  COL,
  BOARD_OVERRIDES,
};
