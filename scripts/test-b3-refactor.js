#!/usr/bin/env node
/**
 * B3 smoke tests — proves loadAll() and runPlan() are importable and callable
 * after the refactor extracts them from plan().
 *
 * These are SMOKE tests, not logic tests. They don't catch planner bugs — that's
 * what the byte-identity --plan diff against logs/B3-baseline.json is for.
 *
 * Runs without MONDAY_API_TOKEN.
 *   - loadAll uses an injected gqlFn stub (no real network).
 *   - runPlan uses synthetic boards (empty jobs, populated crewParents).
 */

const reb = require('./rebalance-schedule.js');
const {
  loadAll,
  runPlan,
  getMondayOfWeek,
  addDays,
  toISO,
} = reb;

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

// CREW roster — must match CREW_BASE_HOURS keys in rebalance-schedule.js
const CREWS = ['Chris', 'Jonathan', 'Paisios', 'Rob', 'Ian', 'Spencer', 'Ken', 'Bob'];
const BOB_START = '2026-05-18';

// Build crew-parent rows for today's Monday + N future Mondays for every crew
// (covers the planning horizon however runPlan computes it).
function buildSyntheticCrewParents(weeksOut = 24) {
  const today = new Date();
  const firstMonday = toISO(getMondayOfWeek(today));
  const parents = [];
  let id = 9000;
  for (let i = 0; i < weeksOut; i++) {
    const wk = toISO(getMondayOfWeek(addDays(new Date(firstMonday + 'T00:00:00Z'), i * 7)));
    for (const crew of CREWS) {
      if (crew === 'Bob' && wk < BOB_START) continue;
      parents.push({
        parentId: String(id++),
        week: wk,
        crew,
        base: 40,
        timeOff: 0,
        nonProd: 0,
      });
    }
  }
  return parents;
}

(async () => {

  console.log('Test 1: loadAll() with injected gqlFn returns the expected boards shape');
  {
    // Minimum-viable gql stub: every load* query expects boards[0].items_page.items
    const emptyPage = { boards: [{ items_page: { items: [], cursor: null } }] };
    const gqlStub = async () => emptyPage;

    check('loadAll is exported', typeof loadAll === 'function', `typeof=${typeof loadAll}`);
    if (typeof loadAll !== 'function') {
      console.log('  (skipping rest of test 1 — loadAll not exported)');
    } else {
      const boards = await loadAll({ gqlFn: gqlStub });
      check('returns an object', boards && typeof boards === 'object', `got ${typeof boards}`);
      check('boards.jobs is an array', Array.isArray(boards?.jobs), `typeof=${typeof boards?.jobs}`);
      check('boards.crewParents is an array', Array.isArray(boards?.crewParents), `typeof=${typeof boards?.crewParents}`);
      check('boards.timeOff is an array', Array.isArray(boards?.timeOff), `typeof=${typeof boards?.timeOff}`);
      check('boards.existingSubs is an array', Array.isArray(boards?.existingSubs), `typeof=${typeof boards?.existingSubs}`);
    }
  }

  console.log('\nTest 1b: runPlan() — savePath: null isolates writes from logs/rebalance-plan-<today>.json (production-pollution guard)');
  {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const productionLogsDir = path.join(__dirname, '..', 'logs');
    const todayPath = path.join(productionLogsDir, `rebalance-plan-${new Date().toISOString().slice(0, 10)}.json`);
    // Snapshot the production file's content (if any) BEFORE the test runs.
    const before = fs.existsSync(todayPath) ? fs.readFileSync(todayPath, 'utf8') : null;

    // Reuse Test 2's synthetic-parent helper so A4's parent-row check doesn't
    // abort the run before we get to the save-path branch we're testing.
    const boards = {
      jobs: [], crewParents: buildSyntheticCrewParents(24),
      timeOff: [], existingSubs: [], overrideRows: [],
    };
    const realLog = console.log; const realErr = console.error;
    console.log = () => {}; console.error = () => {};
    try {
      await runPlan(boards, { savePath: null });
    } finally {
      console.log = realLog; console.error = realErr;
    }
    const after = fs.existsSync(todayPath) ? fs.readFileSync(todayPath, 'utf8') : null;
    check('production logs/rebalance-plan-<today>.json unchanged by runPlan({ savePath: null })',
      before === after,
      `before=${before === null ? '(absent)' : 'present'}, after=${after === null ? '(absent)' : 'present'}`);

    // Also verify explicit savePath (string) DOES write to that path
    const tmpFile = path.join(os.tmpdir(), `runplan-savepath-test-${process.pid}-${Date.now()}.json`);
    console.log = () => {};
    try {
      await runPlan(boards, { savePath: tmpFile });
    } finally {
      console.log = realLog;
    }
    check('runPlan({ savePath: <explicit path> }) writes to that path',
      fs.existsSync(tmpFile),
      `expected file at ${tmpFile}`);
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }

  console.log('\nTest 2: runPlan() with synthetic boards returns a plan report with expected top-level fields');
  {
    check('runPlan is exported', typeof runPlan === 'function', `typeof=${typeof runPlan}`);
    if (typeof runPlan !== 'function') {
      console.log('  (skipping rest of test 2 — runPlan not exported)');
    } else {
      const boards = {
        jobs: [],
        crewParents: buildSyntheticCrewParents(24),
        timeOff: [],
        existingSubs: [],
      };

      // Silence console.log during the planner run so test output stays scannable.
      const realLog = console.log;
      const realErr = console.error;
      console.log = () => {};
      console.error = () => {};
      let report;
      try {
        // savePath: null — don't pollute logs/rebalance-plan-<today>.json
        // with this test's empty-jobs fixture (see runPlan docstring +
        // 2026-05-25 incident note + Test 1b above).
        report = await runPlan(boards, { savePath: null });
      } finally {
        console.log = realLog;
        console.error = realErr;
      }

      check('report is an object', report && typeof report === 'object', `got ${typeof report}`);
      check('report.mode === "plan"', report?.mode === 'plan', `got ${report?.mode}`);
      check('report.generatedAt is set', typeof report?.generatedAt === 'string' && report.generatedAt.length > 0, report?.generatedAt);
      check('report.jobsScheduled === 0 (no jobs)', report?.jobsScheduled === 0, `got ${report?.jobsScheduled}`);
      check('report.placements is an array', Array.isArray(report?.placements), `typeof=${typeof report?.placements}`);
      check('report.warnings is an array', Array.isArray(report?.warnings), `typeof=${typeof report?.warnings}`);
      check('report.capacityGrid is an object', report?.capacityGrid && typeof report.capacityGrid === 'object', `typeof=${typeof report?.capacityGrid}`);
      check('report.finishingCycleReport present', report?.finishingCycleReport && typeof report.finishingCycleReport === 'object', JSON.stringify(report?.finishingCycleReport));
      check('report.finishDateWritebacks is an array', Array.isArray(report?.finishDateWritebacks), `typeof=${typeof report?.finishDateWritebacks}`);
      check('report.committedAuditMismatches is an array', Array.isArray(report?.committedAuditMismatches), `typeof=${typeof report?.committedAuditMismatches}`);
      check('report.existingSubitemIdsToDelete is an array', Array.isArray(report?.existingSubitemIdsToDelete), `typeof=${typeof report?.existingSubitemIdsToDelete}`);
    }
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All B3 smoke tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
