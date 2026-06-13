#!/usr/bin/env node
/**
 * Current-week truthfulness (2026-06-12): Task 5 — day-weighted placeable
 * capacity for the current week.
 *
 * buildCapacityGrid gains a ctx param (null = exact legacy behavior).
 * allocateStationWeek and the primaries filter respect slot.placeable as a
 * physical upper bound on new work. forceAssignment warning threshold also
 * checks it (warning only, forces still place).
 */

const {
  buildCapacityGrid,
  allocateStationWeek,
  SOFT_CAP_MULTIPLIER,
  OVERRIDES,
} = require('./rebalance-schedule.js');

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

// Helper: build minimal crewParents for a given crew and weeks
const weeks = ['2026-06-08', '2026-06-15'];
function parents(crew, base = 40) {
  return weeks.map(w => ({ parentId: `${crew}-${w}`, week: w, crew, base, timeOff: 0, nonProd: 0 }));
}

// Minimal synthetic job for allocateStationWeek calls
const JOB = { id: 'J', name: 'J', subtype: 'Commercial', masterPmId: 'M' };

// ---------------------------------------------------------------------------
console.log('Test 1: Friday-PM context (remainingWorkdays 0) zeroes current-week placeable, future weeks untouched');
{
  const ctx = { currentWeekMonday: '2026-06-08', effectiveWeek: '2026-06-08', remainingWorkdays: 0, isMidWeek: true };
  const grid = buildCapacityGrid(parents('Bob'), [], weeks, [], new Set(), ctx);
  check('placeable 0 on 6/08', grid.Bob['2026-06-08'].placeable === 0,
    JSON.stringify(grid.Bob['2026-06-08']));
  check('no placeable on 6/15 (future weeks untouched)',
    grid.Bob['2026-06-15'].placeable === undefined,
    JSON.stringify(grid.Bob['2026-06-15']));
  check('nominal available intact (display)', grid.Bob['2026-06-08'].available === 40,
    String(grid.Bob['2026-06-08'].available));
}

// ---------------------------------------------------------------------------
console.log('\nTest 2: Wednesday-PM context (remainingWorkdays 2) → 16h placeable (2 days × base/5)');
{
  const ctx = { currentWeekMonday: '2026-06-08', effectiveWeek: '2026-06-08', remainingWorkdays: 2, isMidWeek: true };
  const grid = buildCapacityGrid(parents('Bob'), [], weeks, [], new Set(), ctx);
  // base 40 / 5 days = 8h/day × 2 days = 16h
  check('placeable 16 on 6/08', grid.Bob['2026-06-08'].placeable === 16,
    String(grid.Bob['2026-06-08'].placeable));
  check('available still 40', grid.Bob['2026-06-08'].available === 40);
  check('no placeable on 6/15', grid.Bob['2026-06-15'].placeable === undefined);
}

// ---------------------------------------------------------------------------
console.log('\nTest 3: allocateStationWeek respects placeable, not just soft cap');
{
  const ctx = { currentWeekMonday: '2026-06-08', effectiveWeek: '2026-06-08', remainingWorkdays: 2, isMidWeek: true };
  const grid = buildCapacityGrid(parents('Bob'), [], weeks, [], new Set(), ctx);
  // Try to place 40h — placeable is 16h, so only 16 should land
  const r = allocateStationWeek(grid, JOB, 'Benchwork', '2026-06-08', 40, ['Bob']);
  const placed = r.placements.reduce((s, p) => s + p.hours, 0);
  check('placed capped at 16', Math.abs(placed - 16) < 0.01, String(placed));
  check('rest unplaced', Math.abs(r.unplaced - 24) < 0.01, String(r.unplaced));
}

// ---------------------------------------------------------------------------
console.log('\nTest 4: explicit crewCapacityOverrides.available exempts from day-weighting — operator number wins verbatim');
{
  // Temporarily inject an override for Bob @ 2026-06-08
  const savedOverrides = OVERRIDES.crewCapacityOverrides;
  OVERRIDES.crewCapacityOverrides = {
    '2026-06-08': { Bob: { available: 20, reason: 'test override' } },
  };
  try {
    const ctx = { currentWeekMonday: '2026-06-08', effectiveWeek: '2026-06-08', remainingWorkdays: 0, isMidWeek: true };
    const grid = buildCapacityGrid(parents('Bob'), [], weeks, [], new Set(), ctx);
    // overrideReason is set → placeable = available verbatim (20), not 0
    check('placeable === override available (20)', grid.Bob['2026-06-08'].placeable === 20,
      JSON.stringify(grid.Bob['2026-06-08']));
    check('available is 20 (override applied)', grid.Bob['2026-06-08'].available === 20);
  } finally {
    OVERRIDES.crewCapacityOverrides = savedOverrides;
  }
}

// ---------------------------------------------------------------------------
console.log('\nTest 5: weekendHours boost adds to placeable');
{
  const savedOverrides = OVERRIDES.crewCapacityOverrides;
  OVERRIDES.crewCapacityOverrides = {
    '2026-06-08': { Bob: { weekendHours: 8, reason: 'Saturday work' } },
  };
  try {
    // 2 remaining workdays + 8h weekend boost
    const ctx = { currentWeekMonday: '2026-06-08', effectiveWeek: '2026-06-08', remainingWorkdays: 2, isMidWeek: true };
    const grid = buildCapacityGrid(parents('Bob'), [], weeks, [], new Set(), ctx);
    // base 40/5*2 = 16 + weekendBoost 8 = 24
    check('placeable 24 with weekend boost', grid.Bob['2026-06-08'].placeable === 24,
      JSON.stringify(grid.Bob['2026-06-08']));
    check('weekendBoost set', grid.Bob['2026-06-08'].weekendBoost === 8);
  } finally {
    OVERRIDES.crewCapacityOverrides = savedOverrides;
  }
}

// ---------------------------------------------------------------------------
console.log('\nTest 6: subcontractor slots never get a placeable cap');
{
  const savedSubs = OVERRIDES.subcontractors;
  OVERRIDES.subcontractors = {
    '2026-06-08': [{ name: 'SubCo', hours: 40, allowedStations: ['Benchwork'], assignedJobId: null, fallbackOnly: false, reason: 'test' }],
  };
  try {
    const ctx = { currentWeekMonday: '2026-06-08', effectiveWeek: '2026-06-08', remainingWorkdays: 0, isMidWeek: true };
    const grid = buildCapacityGrid([], [], weeks, [], new Set(), ctx);
    check('subcontractor slot has no placeable', grid['SubCo']?.['2026-06-08']?.placeable === undefined,
      JSON.stringify(grid['SubCo']?.['2026-06-08']));
  } finally {
    OVERRIDES.subcontractors = savedSubs;
  }
}

// ---------------------------------------------------------------------------
console.log('\nTest 7: committed preExisting beyond placeable → no new room (committed >= cap path)');
{
  // Bob has 16h placeable (2 workdays) but 16h already committed (preExisting)
  // Use masterPmId 'DONE' (NOT in activeJobIds) so PATCH A picks up the sub
  const ctx = { currentWeekMonday: '2026-06-08', effectiveWeek: '2026-06-08', remainingWorkdays: 2, isMidWeek: true };
  const existingSubs = [{
    id: 'sub1',
    masterPmId: 'DONE',
    parentCrew: 'Bob',
    parentWeek: '2026-06-08',
    name: 'Done Job — Benchwork',
    station: 'Benchwork',
    hours: 16,
  }];
  const activeJobIds = new Set(['M']);  // 'DONE' is NOT here, so sub will be loaded as preExisting
  const grid = buildCapacityGrid(parents('Bob'), [], weeks, existingSubs, activeJobIds, ctx);
  // After preExisting load, committed = 16, placeable = 16 → softCap capped at 16 → room = 0
  const r = allocateStationWeek(grid, JOB, 'Benchwork', '2026-06-08', 8, ['Bob']);
  const placed = r.placements.reduce((s, p) => s + p.hours, 0);
  check('no room when committed >= placeable', placed === 0, String(placed));
  check('all 8h unplaced', r.unplaced === 8, String(r.unplaced));
}

// ---------------------------------------------------------------------------
console.log('\nTest 8: back-compat — no ctx arg => no placeable anywhere (all existing callers)');
{
  const grid = buildCapacityGrid(parents('Bob'), [], weeks, [], new Set());
  check('no placeable on 6/08', grid.Bob['2026-06-08'].placeable === undefined,
    JSON.stringify(grid.Bob['2026-06-08']));
  check('no placeable on 6/15', grid.Bob['2026-06-15'].placeable === undefined);
}

// ---------------------------------------------------------------------------
console.log('\nTest 9: placeableAvail appears in report cells when slot.placeable is set');
{
  // This is tested by running runPlan with a FRI_PM context and checking the
  // report.capacityGrid cells — but that would require a full runPlan fixture.
  // Instead verify that buildCapacityGrid correctly sets .placeable which
  // runPlan reads when building the report. The actual report emission is
  // covered by the runPlan integration test (test-runplan-effective-week.js).
  const ctx = { currentWeekMonday: '2026-06-08', effectiveWeek: '2026-06-08', remainingWorkdays: 2, isMidWeek: true };
  const grid = buildCapacityGrid(parents('Bob'), [], weeks, [], new Set(), ctx);
  check('placeable is a number', typeof grid.Bob['2026-06-08'].placeable === 'number',
    String(grid.Bob['2026-06-08'].placeable));
  check('placeable is 16', grid.Bob['2026-06-08'].placeable === 16);
}

// ---------------------------------------------------------------------------
console.log();
if (failures.length) {
  console.log(`❌ ${failures.length} failure(s) of ${checks}`);
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log(`✅ All day-weighted-capacity tests passed (${checks} checks).`);
