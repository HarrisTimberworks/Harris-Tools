#!/usr/bin/env node
/**
 * Bug 4 (BCH PostFin dupe) regression test.
 *
 * Reproduces the multi-primary spillover bug observed on 2026-05-18 deploy:
 * BCH PostFin (10.4h, single week, primaries=[Ian, Bob]) emitted TWO Bob/5.2h
 * subitems instead of one Bob/10.4h subitem.
 *
 * Root cause: scheduleStation's multi-primary split iterates each primary p
 * and calls allocateStationWeek with candidates=[p, ...others]. When p1 is at
 * softCap (no room), the call falls through to p2 in the "others" list, placing
 * p1's share on p2. Then p2's own iteration runs and places ANOTHER share on
 * p2. Result: two placements on p2, both `perPrimary` hours.
 *
 * Fix: filter primariesAvailableThisWeek to also exclude primaries with no
 * room (softCap - committed <= 0). When length collapses to 1, the else-branch
 * issues a single allocateStationWeek call with the full hours → one placement.
 *
 * Runs without MONDAY_API_TOKEN — uses scheduleStation + allocateStationWeek
 * directly with a synthetic grid.
 */

const {
  scheduleStation,
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

// Build a minimal grid with Ian and Bob both as PostFin primaries for one week.
// Ian is pre-filled to softCap (no room); Bob is empty.
function buildSyntheticGrid({ ianCommitted, bobCommitted = 0 }) {
  const week = '2026-05-18';
  const grid = {
    Ian: {
      [week]: {
        parentId: 'parent-ian',
        base: 20,
        timeOff: 0,
        available: 20,        // softCap = 20 * 1.05 = 21
        committed: ianCommitted,
        assignments: [],
      },
    },
    Bob: {
      [week]: {
        parentId: 'parent-bob',
        base: 40,
        timeOff: 0,
        available: 40,        // softCap = 42
        committed: bobCommitted,
        assignments: [],
      },
    },
    Spencer: {
      [week]: {
        parentId: 'parent-spencer',
        base: 40,
        timeOff: 0,
        available: 40,
        committed: 0,
        assignments: [],
      },
    },
    Paisios: {
      [week]: {
        parentId: 'parent-paisios',
        base: 40,
        timeOff: 0,
        available: 40,
        committed: 0,
        assignments: [],
      },
    },
    Ken: {
      [week]: {
        parentId: 'parent-ken',
        base: 40,
        timeOff: 0,
        available: 40,
        committed: 0,
        assignments: [],
      },
    },
  };
  return grid;
}

function bchLikeJob() {
  return {
    id: 'test-synthetic-bch-001', // not in OVERRIDES.forceAssignments
    name: 'TEST - Synthetic BCH-like',
    subtype: 'Commercial',        // PostFin primary=[Ian, Bob]
    masterPmId: 'test-master-001',
  };
}

console.log('Test 1 (Bug 4): BCH PostFin 10.4h, Ian at softCap, single week, 2 primaries');
{
  const grid = buildSyntheticGrid({ ianCommitted: 21 }); // Ian at softCap
  const job = bchLikeJob();
  const result = scheduleStation(grid, job, 'Post Fin Cab Assembly', 10.4, '2026-05-18', '2026-05-18');

  // BUG: pre-fix emits 2 placements (Bob 5.2 + Bob 5.2).
  // POST-FIX: emits 1 placement (Bob 10.4).
  const bobPlacements = result.placements.filter(p => p.crew === 'Bob');
  const bobHours = bobPlacements.reduce((s, p) => s + p.hours, 0);

  check('total Bob hours == 10.4', Math.abs(bobHours - 10.4) < 0.01, `got ${bobHours}`);
  check('exactly ONE placement on Bob (no dupe row)', bobPlacements.length === 1,
        `got ${bobPlacements.length} placements: ${JSON.stringify(bobPlacements)}`);
  check('no placements on Ian (Ian full)', result.placements.filter(p => p.crew === 'Ian').length === 0,
        JSON.stringify(result.placements.filter(p => p.crew === 'Ian')));
  check('total placements == 1', result.placements.length === 1,
        JSON.stringify(result.placements));
  check('result.unplaced == 0', Math.abs(result.unplaced) < 0.01, `unplaced=${result.unplaced}`);

  // Grid invariant: Bob.committed must equal sum of Bob's new placements
  check('Bob grid.committed == 10.4 (no overcount)',
        Math.abs(grid.Bob['2026-05-18'].committed - 10.4) < 0.01,
        `committed=${grid.Bob['2026-05-18'].committed}`);
  // Ian shouldn't have moved (was already at softCap, no room)
  check('Ian grid.committed unchanged at 21',
        Math.abs(grid.Ian['2026-05-18'].committed - 21) < 0.01,
        `committed=${grid.Ian['2026-05-18'].committed}`);
}

console.log('\nTest 2 (Bug 4 control): BCH PostFin 10.4h, BOTH primaries have room → split');
{
  // When neither primary is full, multi-primary split is the intended behavior:
  // each primary gets perPrimary=5.2h. This test confirms the fix doesn't break
  // the working case.
  const grid = buildSyntheticGrid({ ianCommitted: 0, bobCommitted: 0 });
  const job = bchLikeJob();
  const result = scheduleStation(grid, job, 'Post Fin Cab Assembly', 10.4, '2026-05-18', '2026-05-18');

  const ianHours = result.placements.filter(p => p.crew === 'Ian').reduce((s, p) => s + p.hours, 0);
  const bobHours = result.placements.filter(p => p.crew === 'Bob').reduce((s, p) => s + p.hours, 0);

  check('Ian hours == 5.2', Math.abs(ianHours - 5.2) < 0.01, `got ${ianHours}`);
  check('Bob hours == 5.2', Math.abs(bobHours - 5.2) < 0.01, `got ${bobHours}`);
  check('total placements == 2 (one per primary)', result.placements.length === 2,
        JSON.stringify(result.placements));
}

console.log('\nTest 3 (Bug 4 invariant): grid.committed == sum(placements) per crew after multi-primary');
{
  // Stronger invariant: for ANY scheduleStation run on a fresh grid (no
  // pre-loads), every crew's grid.committed must equal the sum of placement
  // hours emitted for that crew. This holds for the working case AND the
  // edge case where one primary is full.
  for (const ianStart of [0, 10, 21]) {  // empty, half-full, full
    const grid = buildSyntheticGrid({ ianCommitted: ianStart });
    const initialCommitted = {};
    for (const c of Object.keys(grid)) initialCommitted[c] = grid[c]['2026-05-18'].committed;

    const job = bchLikeJob();
    const result = scheduleStation(grid, job, 'Post Fin Cab Assembly', 10.4, '2026-05-18', '2026-05-18');

    for (const crew of Object.keys(grid)) {
      const placedHours = result.placements
        .filter(p => p.crew === crew)
        .reduce((s, p) => s + p.hours, 0);
      const committedDelta = grid[crew]['2026-05-18'].committed - initialCommitted[crew];
      check(`ianStart=${ianStart}: ${crew} delta.committed == placed hours`,
            Math.abs(committedDelta - placedHours) < 0.01,
            `delta=${committedDelta.toFixed(2)} vs placed=${placedHours.toFixed(2)}`);
    }
  }
}

console.log();
if (failures.length > 0) {
  console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✅ All multi-primary-spillover tests passed (${checks} checks).`);
