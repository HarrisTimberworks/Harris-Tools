#!/usr/bin/env node
/**
 * Placement-accounting regression test (2026-06-11).
 *
 * Bug: scheduleStation's `totalUnplaced` sums per-week shortfalls, but the
 * PATCH-5 cumulative-budget tracker rolls unfilled hours forward
 * (remainingBudget only shrinks when hours are actually placed). When a
 * rolled-forward share is absorbed in a later week — by a forceAssignment
 * (forces deduct from remainingBudget, never from totalUnplaced) or by
 * auto-placement — the early week's shortfall is never credited back.
 * Result: the plan places ALL demand (placements sum to the station's full
 * hours) yet "=== WARNINGS ===" reports "<forced hours> hrs could not be
 * placed within window".
 *
 * Observed live: Spencer Benchwork force 31.5h week 2026-06-15 for job
 * 11835189937 — demand only fits WITH the force, week-1 share rolls into the
 * force week, warning reports exactly the forced 31.5h as unplaced.
 *
 * Fix under test: `unplaced` must be derived from the end-of-loop
 * remainingBudget (demand minus everything actually placed), not the sum of
 * per-week shortfalls.
 *
 * Runs without MONDAY_API_TOKEN — uses scheduleStation directly with a
 * synthetic grid (same pattern as test-multi-primary-spillover.js) and a
 * synthetic forceAssignment injected via the exported OVERRIDES (jobIds are
 * synthetic so real config entries never match).
 */

const {
  scheduleStation,
  OVERRIDES,
  SOFT_CAP_MULTIPLIER,
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

const FORCED_JOB_ID = 'test-synthetic-force-accounting-001';
const NOFORCE_JOB_ID = 'test-synthetic-force-accounting-002';

// Synthetic force mirroring the live shape (stations array, explicit hours).
// Weeks are post Bob start (2026-05-18) and post Ian departure (2026-06-11);
// Spencer carries no Benchwork hard rule.
OVERRIDES.forceAssignments = OVERRIDES.forceAssignments || [];
OVERRIDES.forceAssignments.push({
  crew: 'Spencer',
  jobId: FORCED_JOB_ID,
  stations: ['Benchwork'],
  week: '2026-06-15',
  hours: 31.5,
  reason: 'synthetic test force (unplaced-accounting regression)',
});

const W1 = '2026-06-08';
const W2 = '2026-06-15';

// Benchwork candidates for 'Res - Face Frame': primary [Bob], secondary
// [Spencer, Jonathan]. Slot capacities are set per test below.
function buildGrid({ bobW2Committed = 0, spencerW2Available = 40 }) {
  const slot = (parentId, available, committed) => ({
    parentId,
    base: available,
    timeOff: 0,
    available,
    committed,
    assignments: [],
  });
  return {
    Bob: {
      // softCap = 30 * 1.05 = 31.5; week 1 pinned exactly at cap (no room)
      [W1]: slot('parent-bob', 30, 31.5),
      [W2]: slot('parent-bob', 30, bobW2Committed),
    },
    Spencer: {
      [W1]: slot('parent-spencer', 40, 42),   // at softCap (42)
      [W2]: slot('parent-spencer', spencerW2Available, 0),
    },
    Jonathan: {
      [W1]: slot('parent-jonathan', 40, 42),  // at softCap
      [W2]: slot('parent-jonathan', 40, 42),  // at softCap
    },
  };
}

function syntheticJob(id) {
  return {
    id,
    name: 'TEST - Synthetic force-accounting',
    subtype: 'Res - Face Frame',   // Benchwork: primary [Bob], secondary [Spencer, Jonathan]
    masterPmId: 'test-master-fa-001',
  };
}

console.log('Test 1 (the bug): 63h Benchwork over 2 weeks; week 1 full; week 2 = 31.5h Spencer force + 31.5h Bob room');
{
  // Week 1: every candidate at softCap → the 31.5h week-1 share rolls forward.
  // Week 2: force consumes 31.5h of budget, Bob's 31.5h room takes the rest.
  // ALL 63h get placed — unplaced must be 0, not the forced 31.5.
  const grid = buildGrid({ bobW2Committed: 0 });
  const job = syntheticJob(FORCED_JOB_ID);
  const result = scheduleStation(grid, job, 'Benchwork', 63, W1, W2);

  const placedTotal = result.placements.reduce((s, p) => s + p.hours, 0);
  const forced = result.placements.filter(p => p.forced);
  const forcedHours = forced.reduce((s, p) => s + p.hours, 0);
  const bobAuto = result.placements.filter(p => p.crew === 'Bob' && !p.forced);

  check('all 63h placed (placements sum to demand)', Math.abs(placedTotal - 63) < 0.01,
        `placed=${placedTotal.toFixed(2)}: ${JSON.stringify(result.placements)}`);
  check('force landed: Spencer 31.5h on 2026-06-15, forced=true',
        forced.length === 1 && forced[0].crew === 'Spencer' && forced[0].week === W2
          && Math.abs(forcedHours - 31.5) < 0.01,
        JSON.stringify(forced));
  check('auto remainder landed on Bob week 2 (31.5h)',
        bobAuto.length === 1 && bobAuto[0].week === W2 && Math.abs(bobAuto[0].hours - 31.5) < 0.01,
        JSON.stringify(bobAuto));
  check('result.unplaced == 0 (no spurious "could not be placed" warning)',
        Math.abs(result.unplaced) < 0.01, `unplaced=${result.unplaced}`);
  check('no budget-clamp warnings emitted', (result.warnings || []).length === 0,
        JSON.stringify(result.warnings));
}

console.log('\nTest 2 (control): genuine shortfall still reported exactly');
{
  // Week 2: Bob has only 21h room (committed 10.5 of softCap 31.5); Spencer's
  // slot is sized so the force fills it to cap (available 30 → softCap 31.5).
  // Placeable = 31.5 forced + 21 auto = 52.5 of 63 → genuinely unplaced 10.5.
  // The buggy per-week sum would report 42 (31.5 rolled + 10.5 real).
  const grid = buildGrid({ bobW2Committed: 10.5, spencerW2Available: 30 });
  const job = syntheticJob(FORCED_JOB_ID);
  const result = scheduleStation(grid, job, 'Benchwork', 63, W1, W2);

  const placedTotal = result.placements.reduce((s, p) => s + p.hours, 0);
  check('52.5h placed (31.5 forced + 21 auto)', Math.abs(placedTotal - 52.5) < 0.01,
        `placed=${placedTotal.toFixed(2)}`);
  check('result.unplaced == 10.5 (only the genuinely unplaceable hours)',
        Math.abs(result.unplaced - 10.5) < 0.01, `unplaced=${result.unplaced}`);
}

console.log('\nTest 3 (no force): shortfall that rolls forward and lands later is not unplaced');
{
  // 40h, week 1 full, week 2 Bob has room for all 40 (softCap 42). The week-1
  // share (20h) rolls forward and is auto-placed in week 2 — same accounting
  // hole as Test 1 but with no force involved.
  const grid = buildGrid({ bobW2Committed: 0 });
  grid.Bob[W2].available = 40;  // softCap 42 → room for the full 40h
  const job = syntheticJob(NOFORCE_JOB_ID);
  const result = scheduleStation(grid, job, 'Benchwork', 40, W1, W2);

  const placedTotal = result.placements.reduce((s, p) => s + p.hours, 0);
  check('all 40h placed', Math.abs(placedTotal - 40) < 0.01, `placed=${placedTotal.toFixed(2)}`);
  check('no forced placements (force is for a different jobId)',
        result.placements.every(p => !p.forced), JSON.stringify(result.placements));
  check('result.unplaced == 0', Math.abs(result.unplaced) < 0.01, `unplaced=${result.unplaced}`);
}

console.log('\nTest 4 (spec 2026-06-12 §Code 4): force exceeding board-shrunk remaining warns + places, never throws');
{
  // Shop floor reports ⏳ Hrs Left = 10 while a 31.5h force is pinned: the
  // station budget (10) is below the force. PATCH-5 behavior: place the
  // force (operator pin wins), warn loudly, clamp budget tracking, no throw.
  const grid = buildGrid({ bobW2Committed: 0 });
  const job = syntheticJob(FORCED_JOB_ID);
  let result, threw = null;
  try {
    result = scheduleStation(grid, job, 'Benchwork', 10, W2, W2);
  } catch (e) { threw = e; }
  check('no throw', threw === null, threw && threw.message);
  const forced = (result?.placements || []).filter(p => p.forced);
  check('force still placed in full (31.5h, placements stand)',
        forced.length === 1 && Math.abs(forced[0].hours - 31.5) < 0.01, JSON.stringify(forced));
  check('budget warning emitted',
        (result?.warnings || []).some(w => /exceeds remaining job budget/.test(w)),
        JSON.stringify(result?.warnings));
  check('no spurious unplaced hours', Math.abs(result?.unplaced || 0) < 0.01, `unplaced=${result?.unplaced}`);
  check('exactly one placement (no spurious auto top-up beside the force)',
        (result?.placements || []).length === 1, JSON.stringify(result?.placements));
}

console.log();
if (failures.length > 0) {
  console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✅ All force-unplaced-accounting tests passed (${checks} checks).`);
