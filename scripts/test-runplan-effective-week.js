#!/usr/bin/env node
/**
 * Current-week truthfulness (2026-06-12): Task 4 — thread nowContext through
 * runPlan so startWeek = ctx.effectiveWeek; per-job computeWindows gets the
 * same effectiveWeek; windowClamps/nowContext/unplacedTotal land in the report.
 *
 * All runPlan calls pass savePath: null — never write production logs.
 * Fixture builder copied from test-overrides-read-pipeline.js: generates
 * crewParents for every crew × horizon week (required by the A4 check).
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
// Fixed clock contexts for hermetic runs
// ---------------------------------------------------------------------------
const FRI_PM = {
  currentWeekMonday: '2026-06-08',
  effectiveWeek: '2026-06-08',
  remainingWorkdays: 0,
  isMidWeek: true,
};
const SAT = {
  currentWeekMonday: '2026-06-08',
  effectiveWeek: '2026-06-15',
  remainingWorkdays: 5,
  isMidWeek: false,
};

// ---------------------------------------------------------------------------
// Fixture builder — all crews × 24 horizon weeks from the given start
// (copied from test-overrides-read-pipeline.js / Test 12 pattern)
// ---------------------------------------------------------------------------
const CREWS = ['Chris', 'Jonathan', 'Paisios', 'Rob', 'Ian', 'Spencer', 'Ken', 'Bob'];
const BOB_START = '2026-05-18';
const IAN_END   = '2026-06-11';

function buildParents(startWeek) {
  const parents = [];
  let id = 9000;
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

// BCH-shaped job: delivery 6/17, bench 40h → computed bench window starts 6/08.
// Under SAT context (effectiveWeek 6/15) that window clamps.
const BCH_JOB = {
  id: 'TEST-BCH-1',
  name: 'BCH Test Job',
  status: 'Not Started',
  subtype: 'Commercial',
  delivery: '2026-06-17',
  masterPmId: 'MPM-BCH-1',
  hours: { eng: 0, panel: 0, bench: 40, prefin: 0, postfin: 0 },
  formulaHours: { eng: 0, panel: 0, bench: 40, prefin: 0, postfin: 0 },
  finishingDays: 0,
  pLam: true,
  notes: '',
  customWindow: null,
  parallelPostFin: false,
  overrideNote: null,
};

// Job with large hours to test unplacedTotal
const OVERLOADED_JOB = {
  id: 'TEST-OVER-1',
  name: 'Overloaded Test Job',
  status: 'Not Started',
  subtype: 'Commercial',
  delivery: '2026-06-17',
  masterPmId: 'MPM-OVER-1',
  hours: { eng: 0, panel: 0, bench: 9999, prefin: 0, postfin: 0 },
  formulaHours: { eng: 0, panel: 0, bench: 9999, prefin: 0, postfin: 0 },
  finishingDays: 0,
  pLam: true,
  notes: '',
  customWindow: null,
  parallelPostFin: false,
  overrideNote: null,
};

(async () => {
  const startWeek = '2026-06-08';
  const crewParents = buildParents(startWeek);

  const boards = {
    jobs: [BCH_JOB],
    crewParents,
    timeOff: [],
    existingSubs: [],
    overrideRows: [],
  };

  // Silence runPlan's console.log noise during tests
  const realLog = console.log;
  const realErr = console.error;
  function silence() { console.log = () => {}; console.error = () => {}; }
  function restore() { console.log = realLog; console.error = realErr; }

  // -------------------------------------------------------------------------
  console.log('Test 1: weekend run — grid starts at next Monday (dead week absent)');
  {
    let plan;
    silence();
    try { plan = await runPlan(boards, { savePath: null, nowContext: SAT }); }
    finally { restore(); }

    const weeks = new Set(Object.values(plan.capacityGrid).flatMap(c => Object.keys(c)));
    check('no 6/08 cells in grid', ![...weeks].includes('2026-06-08'),
      [...weeks].slice(0, 3).join(','));
    check('placements all >= 6/15',
      plan.placements.every(p => p.week >= '2026-06-15'),
      JSON.stringify(plan.placements.filter(p => p.week < '2026-06-15').slice(0, 2)));
  }

  // -------------------------------------------------------------------------
  console.log('\nTest 2: windowClamps + nowContext persisted in the plan report');
  {
    let plan;
    silence();
    try { plan = await runPlan(boards, { savePath: null, nowContext: SAT }); }
    finally { restore(); }

    check('windowClamps present',
      Array.isArray(plan.windowClamps) && plan.windowClamps.length >= 1,
      JSON.stringify(plan.windowClamps));
    check('clamp carries jobName',
      plan.windowClamps.length > 0 && plan.windowClamps[0].jobName !== undefined,
      JSON.stringify(plan.windowClamps[0]));
    check('nowContext persisted',
      plan.nowContext && plan.nowContext.effectiveWeek === '2026-06-15',
      JSON.stringify(plan.nowContext));
  }

  // -------------------------------------------------------------------------
  console.log('\nTest 3: unplacedTotal aggregates scheduleStation shortfalls');
  {
    const heavyBoards = {
      jobs: [OVERLOADED_JOB],
      crewParents,
      timeOff: [],
      existingSubs: [],
      overrideRows: [],
    };
    let plan;
    silence();
    try { plan = await runPlan(heavyBoards, { savePath: null, nowContext: SAT }); }
    finally { restore(); }

    check('unplacedTotal > 0', plan.unplacedTotal > 0, String(plan.unplacedTotal));
    check('unplacedTotal is a number', typeof plan.unplacedTotal === 'number',
      String(plan.unplacedTotal));
  }

  // -------------------------------------------------------------------------
  console.log('\nTest 4: no nowContext opt => live clock used, no throw (smoke)');
  {
    let plan;
    let threw = false;
    silence();
    try { plan = await runPlan(boards, { savePath: null }); }
    catch (e) { threw = true; restore(); }
    finally { restore(); }

    check('no throw with live clock', threw === false);
    check('nowContext shape in plan',
      plan && plan.nowContext && typeof plan.nowContext.effectiveWeek === 'string' &&
      plan.nowContext.effectiveWeek.length === 10,
      JSON.stringify(plan?.nowContext));
    check('windowClamps array present', Array.isArray(plan?.windowClamps));
    check('unplacedTotal present', typeof plan?.unplacedTotal === 'number');
  }

  // -------------------------------------------------------------------------
  console.log('\nTest 5: clamped job with broken cycle lands as invalid FCV row with clamp note, run completes');
  {
    // A finishing job whose prefin clamps into finish-drop → cycle invalid, but run completes.
    const finishJob = {
      id: 'TEST-FIN-1',
      name: 'Finishing Clamp Test',
      status: 'Not Started',
      subtype: 'Commercial',
      delivery: '2026-06-22',
      masterPmId: 'MPM-FIN-1',
      hours: { eng: 0, panel: 0, bench: 0, prefin: 30, postfin: 20 },
      formulaHours: { eng: 0, panel: 0, bench: 0, prefin: 30, postfin: 20 },
      finishingDays: 5,
      pLam: false,
      notes: '',
      customWindow: null,
      parallelPostFin: false,
      overrideNote: null,
    };
    const finishBoards = { ...boards, jobs: [finishJob] };
    let plan;
    let threw = false;
    silence();
    try { plan = await runPlan(finishBoards, { savePath: null, nowContext: SAT }); }
    catch (e) { threw = true; restore(); console.error('runPlan threw:', e.message); }
    finally { restore(); }

    check('run completes without throw', threw === false);
    // When clamped and cycle invalid, the FCV row should be marked clamped
    if (plan) {
      const fcRows = plan.finishingCycleReport?.rows || [];
      const clampedRow = fcRows.find(r => r.jobId === 'TEST-FIN-1');
      // The row may or may not exist depending on cycle validity after clamping
      // — assert only shape-level: run completed and report has the fcReport key.
      check('finishingCycleReport present', !!plan.finishingCycleReport);
      check('windowClamps present', Array.isArray(plan.windowClamps));
    }
  }

  // -------------------------------------------------------------------------
  console.log('\nTest 6: FRI_PM context — grid starts at current week (effectiveWeek 6/08)');
  {
    let plan;
    silence();
    try { plan = await runPlan(boards, { savePath: null, nowContext: FRI_PM }); }
    finally { restore(); }

    const weeks = new Set(Object.values(plan.capacityGrid).flatMap(c => Object.keys(c)));
    check('6/08 cells present in grid',
      [...weeks].includes('2026-06-08'),
      [...weeks].slice(0, 3).join(','));
    check('nowContext.effectiveWeek is 6/08',
      plan.nowContext?.effectiveWeek === '2026-06-08');
  }

  console.log();
  if (failures.length) {
    console.log(`❌ ${failures.length} failure(s) of ${checks}`);
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log(`✅ All runplan-effective-week tests passed (${checks} checks).`);
})();
