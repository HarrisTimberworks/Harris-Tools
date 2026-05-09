#!/usr/bin/env node
/**
 * A3 test — finishing-cycle reporting + execute gate.
 *
 * Asserts the pure functions added in A3:
 *   - checkFinishingCycleValid(job, windows) → {valid, errors} — non-throwing
 *   - assertFinishingCycleValid(job, windows) — wrapper still throws (A2 contract)
 *   - buildFinishingCycleRow(job, windows) → row data for the report table
 *   - checkExecuteGate(plan, opts) → {block, invalidRows, bypassed?}
 *
 * Synthetic windows inputs, no live monday calls.
 */

const {
  checkFinishingCycleValid,
  assertFinishingCycleValid,
  buildFinishingCycleRow,
  checkExecuteGate,
} = require('./rebalance-schedule.js');

let checks = 0;
const failures = [];
function check(label, cond, detail) {
  checks++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}: ${detail}`);
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

// ---------- fixtures ----------

// A 10-finishing-day cycle that satisfies A2's invariants exactly:
//   prefin.end (Fri 5/15) + 1 BD = Mon 5/18 = finishDrop ✓
//   finishReturn = 5/18 + 10 BD = Fri 5/29 ≤ postfin.start Mon 6/01 ✓
function validWindows() {
  return {
    eng:    { start: '2026-04-13', end: '2026-04-17' },
    panel:  { start: '2026-04-20', end: '2026-04-24' },
    bench:  { start: '2026-04-27', end: '2026-05-01' },
    prefin: { start: '2026-05-04', end: '2026-05-15' },
    finishDrop:   '2026-05-18',
    finishReturn: '2026-05-29',
    postfin: { start: '2026-06-01', end: '2026-06-12' },
    packShip: { start: '2026-06-15', end: '2026-06-19' },
  };
}

function validJob() {
  return { id: '1', name: 'Test Job', delivery: '2026-06-15', finishingDays: 10, pLam: false };
}

// ---------- tests ----------

console.log('Test 1: checkFinishingCycleValid — valid input → {valid: true, errors: []}');
{
  const r = checkFinishingCycleValid(validJob(), validWindows());
  check('valid === true', r.valid === true, JSON.stringify(r));
  check('errors is empty array', Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors));
}

console.log('\nTest 2: checkFinishingCycleValid — pLam job is treated as valid (skipped)');
{
  const r = checkFinishingCycleValid({ ...validJob(), pLam: true }, validWindows());
  check('pLam → valid: true', r.valid === true, JSON.stringify(r));
  check('pLam → no errors', r.errors.length === 0, JSON.stringify(r.errors));
}

console.log('\nTest 3: checkFinishingCycleValid — finishingDays === 0 is treated as valid');
{
  const r = checkFinishingCycleValid({ ...validJob(), finishingDays: 0 }, validWindows());
  check('zero finishing → valid: true', r.valid === true, JSON.stringify(r));
}

console.log('\nTest 4: checkFinishingCycleValid — Pre-Fin still in progress at Finish Drop → invalid');
{
  // finishDrop pulled back to prefin.end itself; prefin.end+1BD (5/18) > 5/15 finishDrop
  const w = { ...validWindows(), finishDrop: '2026-05-15' };
  const r = checkFinishingCycleValid(validJob(), w);
  check('valid: false', r.valid === false, JSON.stringify(r));
  check('error mentions Pre-Fin', r.errors.some(e => /Pre-Fin/.test(e)), JSON.stringify(r.errors));
}

console.log('\nTest 5: checkFinishingCycleValid — Finish Return after Post-Fin start → invalid');
{
  // postfin.start = 6/01; nudge return past it
  const w = { ...validWindows(), finishReturn: '2026-06-08' };
  const r = checkFinishingCycleValid(validJob(), w);
  check('valid: false', r.valid === false, JSON.stringify(r));
  check('error mentions Finish Return', r.errors.some(e => /Finish Return/.test(e)), JSON.stringify(r.errors));
}

console.log('\nTest 6: checkFinishingCycleValid — both invariants fail → 2 errors reported');
{
  const w = { ...validWindows(), finishDrop: '2026-05-15', finishReturn: '2026-06-08' };
  const r = checkFinishingCycleValid(validJob(), w);
  check('valid: false', r.valid === false, JSON.stringify(r));
  check('two errors reported', r.errors.length === 2, JSON.stringify(r.errors));
}

console.log('\nTest 7: assertFinishingCycleValid — does not throw on valid (A2 contract)');
{
  let threw = false;
  try { assertFinishingCycleValid(validJob(), validWindows()); }
  catch (e) { threw = true; }
  check('valid input does not throw', !threw, threw ? 'unexpectedly threw' : 'OK');
}

console.log('\nTest 8: assertFinishingCycleValid — throws on invalid (A2 defense preserved)');
{
  const w = { ...validWindows(), finishDrop: '2026-05-15' };
  let err = null;
  try { assertFinishingCycleValid(validJob(), w); }
  catch (e) { err = e; }
  check('invalid input throws', err !== null, 'did not throw');
  check('error has [finishing-cycle] prefix', /\[finishing-cycle\]/.test(err?.message || ''), err?.message);
  check('error includes job name', /Test Job/.test(err?.message || ''), err?.message);
}

console.log('\nTest 9: buildFinishingCycleRow — valid job → complete row with all fields');
{
  const row = buildFinishingCycleRow(validJob(), validWindows());
  check('kind === "row"', row.kind === 'row', JSON.stringify(row));
  check('valid: true', row.valid === true, JSON.stringify(row));
  check('jobName === "Test Job"', row.jobName === 'Test Job', JSON.stringify(row));
  check('finishingDays === 10', row.finishingDays === 10, JSON.stringify(row));
  check('prefinEnd === 2026-05-15', row.prefinEnd === '2026-05-15', JSON.stringify(row));
  check('postfinStart === 2026-06-01', row.postfinStart === '2026-06-01', JSON.stringify(row));
  check('gap is a number ≥ 10', typeof row.gap === 'number' && row.gap >= 10, `gap=${row.gap}`);
  check('errors is empty array', Array.isArray(row.errors) && row.errors.length === 0, JSON.stringify(row.errors));
}

console.log('\nTest 10: buildFinishingCycleRow — pLam → skipped');
{
  const row = buildFinishingCycleRow({ ...validJob(), pLam: true }, validWindows());
  check('kind === "skipped"', row.kind === 'skipped', JSON.stringify(row));
  check('reason set', typeof row.reason === 'string' && row.reason.length > 0, JSON.stringify(row));
}

console.log('\nTest 11: buildFinishingCycleRow — finishingDays === 0 → skipped');
{
  const row = buildFinishingCycleRow({ ...validJob(), finishingDays: 0 }, validWindows());
  check('kind === "skipped"', row.kind === 'skipped', JSON.stringify(row));
}

console.log('\nTest 12: buildFinishingCycleRow — null windows → skipped');
{
  const row = buildFinishingCycleRow(validJob(), null);
  check('kind === "skipped"', row.kind === 'skipped', JSON.stringify(row));
}

console.log('\nTest 13: buildFinishingCycleRow — invalid cycle → row with valid:false and errors');
{
  const w = { ...validWindows(), finishDrop: '2026-05-15' };
  const row = buildFinishingCycleRow(validJob(), w);
  check('kind === "row"', row.kind === 'row', JSON.stringify(row));
  check('valid: false', row.valid === false, JSON.stringify(row));
  check('errors non-empty', row.errors.length > 0, JSON.stringify(row.errors));
}

console.log('\nTest 14: checkExecuteGate — null/empty plan → not blocked');
{
  check('null plan → not blocked', checkExecuteGate(null).block === false, '');
  check('plan with no finishingCycleReport → not blocked', checkExecuteGate({}).block === false, '');
  const empty = { finishingCycleReport: { rows: [], invalidCount: 0 } };
  check('empty fcr → not blocked', checkExecuteGate(empty).block === false, '');
}

console.log('\nTest 15: checkExecuteGate — invalid rows blocks unless force=true');
{
  const plan = {
    finishingCycleReport: {
      rows: [
        { jobName: 'BadJob', valid: false, errors: ['cycle broken'] },
        { jobName: 'GoodJob', valid: true, errors: [] },
      ],
      invalidCount: 1,
    },
  };
  const r1 = checkExecuteGate(plan, { force: false });
  check('blocked when invalid present', r1.block === true, JSON.stringify(r1));
  check('invalidRows length === 1', r1.invalidRows?.length === 1, JSON.stringify(r1));
  check('invalidRows[0] is BadJob', r1.invalidRows?.[0]?.jobName === 'BadJob', JSON.stringify(r1));

  const r2 = checkExecuteGate(plan, { force: true });
  check('not blocked when force=true', r2.block === false, JSON.stringify(r2));
  check('bypassed === true', r2.bypassed === true, JSON.stringify(r2));
  check('invalidRows still surfaced when bypassed', r2.invalidRows?.length === 1, JSON.stringify(r2));
}

console.log();
if (failures.length > 0) {
  console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✅ All A3 tests passed (${checks} checks).`);
