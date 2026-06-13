#!/usr/bin/env node
/**
 * Current-week truthfulness (2026-06-12): Task 6 + 7 — deploy preservation.
 *
 * Mid-week deploys must preserve already-deployed Crew Allocation rows in past
 * weeks (immutable history) and the current week (committed reality). Preserved
 * current-week rows load into the grid as preExisting committed AND their hours
 * subtract from each job × station's planable remaining so nothing is
 * double-scheduled. Jobs with an accepted override row touching the current week
 * opt back into full rewrite.
 *
 * Tests 3–5 are marked TODO(task7) — they assert week-aware delete behavior
 * that depends on computeSubitemDeletes opts wiring (Task 7). They are written
 * now for their final behavior and un-skipped in Task 7.
 */

const {
  runPlan,
  getMondayOfWeek,
  addDays,
  toISO,
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

// ---------------------------------------------------------------------------
// Fixed clock context: Wednesday AM, current week 6/08, 3 days remaining
// ---------------------------------------------------------------------------
const WED_AM = {
  currentWeekMonday: '2026-06-08',
  effectiveWeek: '2026-06-08',
  remainingWorkdays: 3,
  isMidWeek: true,
};

// Weekend context: current week is 6/08 (history), planning into 6/15
const WEEKEND = {
  currentWeekMonday: '2026-06-08',
  effectiveWeek: '2026-06-15',
  remainingWorkdays: 5,
  isMidWeek: false,
};

// ---------------------------------------------------------------------------
// Fixture builder (same as test-runplan-effective-week.js)
// ---------------------------------------------------------------------------
const CREWS = ['Chris', 'Jonathan', 'Paisios', 'Rob', 'Ian', 'Spencer', 'Ken', 'Bob'];
const BOB_START = '2026-05-18';
const IAN_END   = '2026-06-11';

function buildParents(startWeek) {
  const parents = [];
  let id = 8000;
  for (let i = 0; i < 24; i++) {
    const wk = toISO(getMondayOfWeek(addDays(new Date(startWeek + 'T00:00:00Z'), i * 7)));
    for (const crew of CREWS) {
      if (crew === 'Bob' && wk < BOB_START) continue;
      if (crew === 'Ian' && wk > IAN_END) continue;
      parents.push({ parentId: String(id++), week: wk, crew, base: 40, timeOff: 0, nonProd: 0 });
    }
  }
  return parents;
}

// ---------------------------------------------------------------------------
// Job fixture: bench 40h, delivery 6/24, masterPmId M1
// Under WED_AM context the computed bench window starts 6/08 (current week).
// ---------------------------------------------------------------------------
const BENCH_JOB = {
  id: 'TEST-PRES-1',
  name: 'Preservation Test Job',
  status: 'Not Started',
  subtype: 'Commercial',
  delivery: '2026-06-24',
  masterPmId: 'M1',
  hours: { eng: 0, panel: 0, bench: 40, prefin: 0, postfin: 0 },
  formulaHours: { eng: 0, panel: 0, bench: 40, prefin: 0, postfin: 0 },
  finishingDays: 0,
  pLam: true,
  notes: '',
  customWindow: null,
  parallelPostFin: false,
  overrideNote: null,
};

// Sub fixture shape: { id, parentWeek, parentCrew, station, hours, masterPmId, name }
// 24h bench on Bob @ 6/08 (current week), 8h bench @ 6/01 (past week)
const EXISTING_SUBS = [
  {
    id: 'sub-608',
    parentWeek: '2026-06-08',
    parentCrew: 'Bob',
    station: 'Benchwork',
    hours: 24,
    masterPmId: 'M1',
    name: 'Preservation Test Job — Benchwork',
  },
  {
    id: 'sub-601',
    parentWeek: '2026-06-01',
    parentCrew: 'Bob',
    station: 'Benchwork',
    hours: 8,
    masterPmId: 'M1',
    name: 'Preservation Test Job — Benchwork',
  },
  {
    id: 'sub-615',
    parentWeek: '2026-06-15',
    parentCrew: 'Bob',
    station: 'Benchwork',
    hours: 16,
    masterPmId: 'M1',
    name: 'Preservation Test Job — Benchwork',
  },
];

// Silence runPlan's console.log noise during tests
const realLog = console.log;
const realErr = console.error;
function silence() { console.log = () => {}; console.error = () => {}; }
function restore() { console.log = realLog; console.error = realErr; }

(async () => {
  const startWeek = '2026-06-08';
  const crewParents = buildParents(startWeek);

  const boards = {
    jobs: [BENCH_JOB],
    crewParents,
    timeOff: [],
    existingSubs: EXISTING_SUBS,
    overrideRows: [],
  };

  // -------------------------------------------------------------------------
  console.log('Test 1: current-week rows load as preExisting committed in grid');
  {
    let plan;
    silence();
    try { plan = await runPlan(boards, { savePath: null, nowContext: WED_AM }); }
    finally { restore(); }

    const cell = plan.capacityGrid?.Bob?.['2026-06-08'];
    check('cell exists for Bob 6/08', !!cell, JSON.stringify(Object.keys(plan.capacityGrid?.Bob || {})));
    check('24h preExisting committed',
      !!(cell && cell.assignments && cell.assignments.some(a => a.preExisting && a.hours === 24)),
      JSON.stringify(cell?.assignments));
  }

  // -------------------------------------------------------------------------
  console.log('\nTest 2: preserved hours subtract from planable remaining (no double-schedule)');
  {
    // bench remaining 40, preserved 24 → only 16 should be (re)placed across the window
    let plan;
    silence();
    try { plan = await runPlan(boards, { savePath: null, nowContext: WED_AM }); }
    finally { restore(); }

    const benchPlaced = (plan.placements || [])
      .filter(p => p.station === 'Benchwork' && String(p.masterPmId) === 'M1')
      .reduce((s, p) => s + p.hours, 0);
    check('16h placed, not 40 (preserved 24 subtracted)',
      Math.abs(benchPlaced - 16) < 0.01,
      String(benchPlaced));
  }

  // -------------------------------------------------------------------------
  // Tests 3–5: week-aware delete behavior (Task 7 un-skipped)
  // -------------------------------------------------------------------------
  console.log('\nTest 3: preserved current-week rows NOT in the delete set; past-week rows NOT either');
  {
    let plan;
    silence();
    try { plan = await runPlan(boards, { savePath: null, nowContext: WED_AM }); }
    finally { restore(); }

    check('6/08 sub preserved (current week)',
      !plan.existingSubitemIdsToDelete.includes('sub-608'),
      JSON.stringify(plan.existingSubitemIdsToDelete));
    check('6/01 sub preserved (past week / history)',
      !plan.existingSubitemIdsToDelete.includes('sub-601'),
      JSON.stringify(plan.existingSubitemIdsToDelete));
  }

  console.log('\nTest 4: future-week rows of replanned jobs still deleted (full overwrite ahead)');
  {
    let plan;
    silence();
    try { plan = await runPlan(boards, { savePath: null, nowContext: WED_AM }); }
    finally { restore(); }

    check('6/15 sub deleted (future week, job replanned)',
      plan.existingSubitemIdsToDelete.includes('sub-615'),
      JSON.stringify(plan.existingSubitemIdsToDelete));
  }

  console.log('\nTest 5: weekend context — ending week falls under history protection');
  {
    // Under WEEKEND ctx (effectiveWeek 6/15, isMidWeek false):
    //   sub-608 @ 6/08 is past history → protected
    //   sub-615 @ 6/15 → deleted (>= effectiveWeek, job replanned)
    let plan;
    silence();
    try { plan = await runPlan(boards, { savePath: null, nowContext: WEEKEND }); }
    finally { restore(); }

    check('weekend: 6/08 sub protected as history',
      !plan.existingSubitemIdsToDelete.includes('sub-608'),
      JSON.stringify(plan.existingSubitemIdsToDelete));
    check('weekend: 6/15 sub deleted (future >= effectiveWeek)',
      plan.existingSubitemIdsToDelete.includes('sub-615'),
      JSON.stringify(plan.existingSubitemIdsToDelete));
  }

  // -------------------------------------------------------------------------
  console.log('\nTest 6: P&S/Delivery preserved rows reduce the 2h re-place');
  {
    // Job with a Pack & Ship subitem already on 6/08 (the delivery week under WED_AM)
    // After preservation, the re-place should be 0 (2h - 2h preserved = 0).
    const PS_JOB = {
      id: 'TEST-PS-1',
      name: 'PS Preservation Test',
      status: 'Not Started',
      subtype: 'Commercial',
      delivery: '2026-06-12',  // delivery week = 6/08 (current week)
      masterPmId: 'M2',
      hours: { eng: 0, panel: 0, bench: 0, prefin: 0, postfin: 0 },
      formulaHours: { eng: 0, panel: 0, bench: 0, prefin: 0, postfin: 0 },
      finishingDays: 0,
      pLam: true,
      notes: '',
      customWindow: null,
      parallelPostFin: false,
      overrideNote: null,
    };
    const psExistingSubs = [
      {
        id: 'sub-ps-608',
        parentWeek: '2026-06-08',
        parentCrew: 'Paisios',
        station: 'Pack & Ship',
        hours: 2,
        masterPmId: 'M2',
        name: 'PS Preservation Test — Pack & Ship',
      },
    ];
    const psBoards = {
      jobs: [PS_JOB],
      crewParents,
      timeOff: [],
      existingSubs: psExistingSubs,
      overrideRows: [],
    };

    let plan;
    silence();
    try { plan = await runPlan(psBoards, { savePath: null, nowContext: WED_AM }); }
    finally { restore(); }

    const psPlaced = (plan.placements || [])
      .filter(p => p.station === 'Pack & Ship' && String(p.masterPmId) === 'M2')
      .reduce((s, p) => s + p.hours, 0);
    // If 2h already preserved, re-place = 0; allow small float tolerance
    check('P&S re-place 0 when 2h already preserved',
      psPlaced < 0.01,
      `placed=${psPlaced}`);

    // Also verify the preserved sub is in the cell's preExisting assignments
    const cell = plan.capacityGrid?.Paisios?.['2026-06-08'];
    check('P&S preExisting in grid',
      !!(cell && cell.assignments && cell.assignments.some(a => a.preExisting && a.station === 'Pack & Ship')),
      JSON.stringify(cell?.assignments?.slice(0, 3)));
  }

  // -------------------------------------------------------------------------
  console.log('\nTest 7: remaining < preserved floors at 0 (no negative hours)');
  {
    // Job with bench 10h total, but 24h preserved → should place 0, no negative
    const SMALL_JOB = {
      id: 'TEST-SMALL-1',
      name: 'Small Job',
      status: 'Not Started',
      subtype: 'Commercial',
      delivery: '2026-06-24',
      masterPmId: 'M3',
      hours: { eng: 0, panel: 0, bench: 10, prefin: 0, postfin: 0 },
      formulaHours: { eng: 0, panel: 0, bench: 10, prefin: 0, postfin: 0 },
      finishingDays: 0,
      pLam: true,
      notes: '',
      customWindow: null,
      parallelPostFin: false,
      overrideNote: null,
    };
    const smallSubs = [
      {
        id: 'sub-sm-608',
        parentWeek: '2026-06-08',
        parentCrew: 'Bob',
        station: 'Benchwork',
        hours: 24,  // more preserved than job.hours.bench (10)
        masterPmId: 'M3',
        name: 'Small Job — Benchwork',
      },
    ];
    const smallBoards = {
      jobs: [SMALL_JOB],
      crewParents,
      timeOff: [],
      existingSubs: smallSubs,
      overrideRows: [],
    };

    let plan;
    silence();
    try { plan = await runPlan(smallBoards, { savePath: null, nowContext: WED_AM }); }
    finally { restore(); }

    const placed = (plan.placements || [])
      .filter(p => p.station === 'Benchwork' && String(p.masterPmId) === 'M3')
      .reduce((s, p) => s + p.hours, 0);
    check('placed 0 when preserved > job hours (floor at 0)',
      placed < 0.01,
      String(placed));
    check('unplacedTotal >= 0 (no negative leak)',
      plan.unplacedTotal >= 0,
      String(plan.unplacedTotal));
  }

  // -------------------------------------------------------------------------
  console.log();
  if (failures.length) {
    console.log(`❌ ${failures.length} failure(s) of ${checks}`);
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log(`✅ All current-week-preservation tests passed (${checks} checks).`);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
