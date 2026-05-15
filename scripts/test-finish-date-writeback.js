#!/usr/bin/env node
/**
 * A5 test — Finish Drop / Finish Return writeback to Production Load Board.
 *
 * Asserts the pure functions added in A5:
 *   - buildFinishDateWriteback(job, windows) → per-job writeback entry
 *       { jobId, jobName, plItemId, finishDrop, finishReturn }
 *     pLam/finishingDays=0/missing windows → finishDrop & finishReturn null.
 *   - buildFinishDateMutations(plan, opts?) → array of
 *       { plItemId, columnValues } pairs ready for
 *       monday change_multiple_column_values. For dates set, the value is
 *       { date: 'YYYY-MM-DD' }; for clear (pLam etc.), the value is null.
 *
 * Pure tests — synthetic inputs only. No live monday calls. Live writeback
 * happens organically on next real --execute (see A5 task notes).
 */

const {
  buildFinishDateWriteback,
  buildFinishDateMutations,
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

// Column IDs from COL_PL on the Production Load board (rebalance-schedule.js:76-77).
const FINISH_DROP_COL = 'date_mm26qqv3';
const FINISH_RETURN_COL = 'date_mm2k17ef';

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

function pLamWindows() {
  // pLam: computeWindows omits finishDrop/finishReturn entirely.
  const w = validWindows();
  delete w.finishDrop;
  delete w.finishReturn;
  return w;
}

function validJob() {
  // job.id is the PL board item ID (loadJobs maps it.id → id).
  return { id: '12345', name: 'Test Job', delivery: '2026-06-15', finishingDays: 10, pLam: false };
}

// ============================================================================
// buildFinishDateWriteback — single-job derivation
// ============================================================================

console.log('Test 1: buildFinishDateWriteback — non-pLam with valid windows → dates populated');
{
  const e = buildFinishDateWriteback(validJob(), validWindows());
  check('jobId === "12345"', e.jobId === '12345', JSON.stringify(e));
  check('plItemId === "12345"', e.plItemId === '12345', JSON.stringify(e));
  check('jobName === "Test Job"', e.jobName === 'Test Job', JSON.stringify(e));
  check('finishDrop === "2026-05-18"', e.finishDrop === '2026-05-18', JSON.stringify(e));
  check('finishReturn === "2026-05-29"', e.finishReturn === '2026-05-29', JSON.stringify(e));
}

console.log('\nTest 2: buildFinishDateWriteback — pLam job → both dates null (clear writeback)');
{
  const e = buildFinishDateWriteback({ ...validJob(), pLam: true }, pLamWindows());
  check('jobId preserved', e.jobId === '12345', JSON.stringify(e));
  check('plItemId preserved', e.plItemId === '12345', JSON.stringify(e));
  check('finishDrop === null', e.finishDrop === null, JSON.stringify(e));
  check('finishReturn === null', e.finishReturn === null, JSON.stringify(e));
}

console.log('\nTest 3: buildFinishDateWriteback — finishingDays === 0 → both dates null');
{
  const w = pLamWindows();  // no finish dates in windows when finishingDays=0 either
  const e = buildFinishDateWriteback({ ...validJob(), finishingDays: 0 }, w);
  check('finishDrop === null', e.finishDrop === null, JSON.stringify(e));
  check('finishReturn === null', e.finishReturn === null, JSON.stringify(e));
}

console.log('\nTest 4: buildFinishDateWriteback — windows missing finishDrop/finishReturn → nulls (defensive)');
{
  // Non-pLam, non-zero finishingDays, but windows somehow lacks the fields.
  // Defensive: never explode, always emit a writeback entry so plItemId is tracked.
  const w = pLamWindows();
  const e = buildFinishDateWriteback(validJob(), w);
  check('finishDrop === null', e.finishDrop === null, JSON.stringify(e));
  check('finishReturn === null', e.finishReturn === null, JSON.stringify(e));
  check('plItemId still set', e.plItemId === '12345', JSON.stringify(e));
}

console.log('\nTest 5: buildFinishDateWriteback — null windows → all date fields null but entry still emitted');
{
  const e = buildFinishDateWriteback(validJob(), null);
  check('finishDrop === null', e.finishDrop === null, JSON.stringify(e));
  check('finishReturn === null', e.finishReturn === null, JSON.stringify(e));
  check('plItemId still set', e.plItemId === '12345', JSON.stringify(e));
}

// ============================================================================
// buildFinishDateMutations — plan → mutation params
// ============================================================================

console.log('\nTest 6: buildFinishDateMutations — non-pLam entry → { date: "..." } for both cols');
{
  const plan = {
    finishDateWritebacks: [
      { jobId: '12345', jobName: 'Test Job', plItemId: '12345', finishDrop: '2026-05-18', finishReturn: '2026-05-29' },
    ],
  };
  const muts = buildFinishDateMutations(plan);
  check('one mutation produced', muts.length === 1, JSON.stringify(muts));
  check('plItemId === "12345"', muts[0].plItemId === '12345', JSON.stringify(muts[0]));
  const cv = muts[0].columnValues;
  check('finishDrop col value is { date: "2026-05-18" }',
    cv[FINISH_DROP_COL]?.date === '2026-05-18',
    JSON.stringify(cv));
  check('finishReturn col value is { date: "2026-05-29" }',
    cv[FINISH_RETURN_COL]?.date === '2026-05-29',
    JSON.stringify(cv));
}

console.log('\nTest 7: buildFinishDateMutations — pLam entry → null for both cols (clear)');
{
  const plan = {
    finishDateWritebacks: [
      { jobId: '999', jobName: 'pLam Job', plItemId: '999', finishDrop: null, finishReturn: null },
    ],
  };
  const muts = buildFinishDateMutations(plan);
  check('one mutation produced', muts.length === 1, JSON.stringify(muts));
  const cv = muts[0].columnValues;
  check('finishDrop col value is null',
    cv[FINISH_DROP_COL] === null,
    JSON.stringify(cv));
  check('finishReturn col value is null',
    cv[FINISH_RETURN_COL] === null,
    JSON.stringify(cv));
  check('finishDrop key is present in payload',
    Object.prototype.hasOwnProperty.call(cv, FINISH_DROP_COL),
    JSON.stringify(cv));
  check('finishReturn key is present in payload',
    Object.prototype.hasOwnProperty.call(cv, FINISH_RETURN_COL),
    JSON.stringify(cv));
}

console.log('\nTest 8: buildFinishDateMutations — empty/missing writebacks → empty array');
{
  check('plan with empty array → []',
    Array.isArray(buildFinishDateMutations({ finishDateWritebacks: [] })) &&
    buildFinishDateMutations({ finishDateWritebacks: [] }).length === 0,
    '');
  check('plan with no finishDateWritebacks field → []',
    Array.isArray(buildFinishDateMutations({})) &&
    buildFinishDateMutations({}).length === 0,
    '');
  check('null plan → []',
    Array.isArray(buildFinishDateMutations(null)) &&
    buildFinishDateMutations(null).length === 0,
    '');
}

console.log('\nTest 9: buildFinishDateMutations — multi-job plan preserves order; mixed pLam + dated');
{
  const plan = {
    finishDateWritebacks: [
      { jobId: 'a', jobName: 'Alpha', plItemId: 'a', finishDrop: '2026-05-18', finishReturn: '2026-05-29' },
      { jobId: 'b', jobName: 'Bravo (pLam)', plItemId: 'b', finishDrop: null, finishReturn: null },
      { jobId: 'c', jobName: 'Charlie', plItemId: 'c', finishDrop: '2026-06-01', finishReturn: '2026-06-12' },
    ],
  };
  const muts = buildFinishDateMutations(plan);
  check('three mutations produced', muts.length === 3, JSON.stringify(muts));
  check('order preserved: a,b,c',
    muts[0].plItemId === 'a' && muts[1].plItemId === 'b' && muts[2].plItemId === 'c',
    muts.map(m => m.plItemId).join(','));
  check('Alpha has dated finishDrop',
    muts[0].columnValues[FINISH_DROP_COL]?.date === '2026-05-18',
    JSON.stringify(muts[0].columnValues));
  check('Bravo has null finishDrop (clear)',
    muts[1].columnValues[FINISH_DROP_COL] === null,
    JSON.stringify(muts[1].columnValues));
  check('Charlie has dated finishReturn',
    muts[2].columnValues[FINISH_RETURN_COL]?.date === '2026-06-12',
    JSON.stringify(muts[2].columnValues));
}

console.log('\nTest 10: buildFinishDateMutations — custom column IDs via opts override defaults');
{
  const plan = {
    finishDateWritebacks: [
      { jobId: 'x', jobName: 'X', plItemId: 'x', finishDrop: '2026-05-18', finishReturn: '2026-05-29' },
    ],
  };
  const muts = buildFinishDateMutations(plan, {
    finishDropCol: 'custom_drop',
    finishReturnCol: 'custom_return',
  });
  const cv = muts[0].columnValues;
  check('custom finishDrop key present',
    cv.custom_drop?.date === '2026-05-18',
    JSON.stringify(cv));
  check('custom finishReturn key present',
    cv.custom_return?.date === '2026-05-29',
    JSON.stringify(cv));
  check('default keys not present when overridden',
    !Object.prototype.hasOwnProperty.call(cv, FINISH_DROP_COL),
    JSON.stringify(cv));
}

console.log('\nTest 11: buildFinishDateMutations — partial dates (only finishDrop set) → finishReturn cleared');
{
  // Defensive: if upstream produced half-populated entry, emit the half we have
  // and explicitly clear the other column rather than leaving it stale.
  const plan = {
    finishDateWritebacks: [
      { jobId: 'p', jobName: 'Partial', plItemId: 'p', finishDrop: '2026-05-18', finishReturn: null },
    ],
  };
  const muts = buildFinishDateMutations(plan);
  const cv = muts[0].columnValues;
  check('finishDrop set to date', cv[FINISH_DROP_COL]?.date === '2026-05-18', JSON.stringify(cv));
  check('finishReturn explicitly null', cv[FINISH_RETURN_COL] === null, JSON.stringify(cv));
}

console.log();
if (failures.length > 0) {
  console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✅ All A5 tests passed (${checks} checks).`);
