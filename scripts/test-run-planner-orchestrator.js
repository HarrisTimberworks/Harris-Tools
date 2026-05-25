#!/usr/bin/env node
/**
 * B5b — run-planner.js two-pass driver smoke test.
 *
 * Verifies the orchestrator wires loadAll + runPlan + validateAll in the
 * right order and persists results to the right files. Logic of each
 * component is tested elsewhere (B3 for loadAll/runPlan, B5a for
 * validateAll). This test is about ORDER, COUNTS, and SIDE EFFECTS — not
 * about planner math or validation rules.
 *
 * Stubs every dependency via injection so the test runs without
 * MONDAY_API_TOKEN and without touching the real logs/ directory.
 */

const path = require('path');
const { runPlanner } = require('./run-planner.js');

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
// Stub builders
// ---------------------------------------------------------------------------

function makeFakeFs() {
  const writes = [];      // { path, content }
  const readMap = new Map(); // path → content
  return {
    writes,
    readMap,
    fs: {
      existsSync: (p) => readMap.has(p) || true,
      mkdirSync: () => {},
      writeFileSync: (p, content) => {
        writes.push({ path: p, content });
        readMap.set(p, content);
      },
      readFileSync: (p) => {
        if (!readMap.has(p)) throw new Error(`fake fs: no such file ${p}`);
        return readMap.get(p);
      },
      readdirSync: () => {
        // Return any file basenames we've written under logsDir.
        return Array.from(readMap.keys()).map(k => path.basename(k));
      },
    },
  };
}

function makeFakeBoards() {
  return {
    jobs: [
      { id: 'PL-A', masterPmId: 'MPM-A', name: 'Job A', delivery: '2026-06-12', status: 'Not Started' },
    ],
    crewParents: [
      { parentId: 'CP-IAN-0525', crew: 'Ian', week: '2026-05-25', base: 40, timeOff: 0, nonProd: 0 },
    ],
    timeOff: [],
    existingSubs: [],
    overrideRows: [
      { rowId: 'R1', jobMpmId: 'MPM-A', station: 'Benchwork',
        fromCrewParentId: null, fromWeek: null,
        toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25',
        hours: 8, status: 'Pending', allowOverCap: false },
    ],
  };
}

// ---------------------------------------------------------------------------

(async () => {

  console.log('Test 1: runPlanner exported and callable');
  {
    check('runPlanner is a function', typeof runPlanner === 'function', `typeof=${typeof runPlanner}`);
  }

  console.log('\nTest 2: --plan mode — loadAll called once, runPlan twice, validateAll once, in that order');
  {
    const callLog = [];
    const boards = makeFakeBoards();
    const baselineReport = { mode: 'plan', placements: [], capacityGrid: {}, warnings: [] };
    const finalReport    = { mode: 'plan', placements: [{ crew: 'Ian', week: '2026-05-25', hours: 8 }], capacityGrid: {}, warnings: [] };

    const stubLoadAll = async () => { callLog.push('loadAll'); return boards; };
    let runPlanCalls = 0;
    const stubRunPlan = async (b) => {
      runPlanCalls++;
      callLog.push(`runPlan:${runPlanCalls}:overrideRows=${(b.overrideRows || []).length}`);
      return runPlanCalls === 1 ? baselineReport : finalReport;
    };
    const stubValidateAll = (rows, baseline, plJobs, crewParents) => {
      callLog.push(`validateAll:rows=${rows.length}`);
      // Accept the single Pending row.
      return {
        accepted: [{ rowId: 'R1', decision: 'accepted', jobId: 'PL-A', station: 'Benchwork',
                     fromCrew: null, fromWeek: null, toCrew: 'Ian', toWeek: '2026-05-25', hours: 8 }],
        conflicts: [],
      };
    };
    const stubWriteRowDecisions = async (validation, opts) => {
      callLog.push(`writeRowDecisions:accepted=${validation.accepted.length}:conflicts=${validation.conflicts.length}`);
      return { written: validation.accepted.length + validation.conflicts.length, skipped: 0, errors: [] };
    };

    const fakeFs = makeFakeFs();
    const realLog = console.log; console.log = () => {};
    let result;
    try {
      result = await runPlanner({
        mode: 'plan',
        deps: {
          loadAll: stubLoadAll,
          runPlan: stubRunPlan,
          validateAll: stubValidateAll,
          writeRowDecisions: stubWriteRowDecisions,
          fs: fakeFs.fs,
          logsDir: '/fake/logs',
          now: () => new Date('2026-05-22T20:00:00Z'),
        },
      });
    } finally {
      console.log = realLog;
    }

    check('loadAll called exactly once', callLog.filter(s => s === 'loadAll').length === 1, JSON.stringify(callLog));
    check('runPlan called exactly twice', callLog.filter(s => s.startsWith('runPlan:')).length === 2, JSON.stringify(callLog));
    check('validateAll called exactly once', callLog.filter(s => s.startsWith('validateAll:')).length === 1, JSON.stringify(callLog));
    check('writeRowDecisions called exactly once', callLog.filter(s => s.startsWith('writeRowDecisions:')).length === 1, JSON.stringify(callLog));
    check('call order: loadAll → runPlan(pass1) → validateAll → writeRowDecisions → runPlan(pass2)',
      callLog[0] === 'loadAll'
      && callLog[1].startsWith('runPlan:1')
      && callLog[2].startsWith('validateAll')
      && callLog[3].startsWith('writeRowDecisions')
      && callLog[4].startsWith('runPlan:2'),
      JSON.stringify(callLog));
    check('pass-1 runPlan saw zero overrideRows (baseline)', callLog[1] === 'runPlan:1:overrideRows=0', JSON.stringify(callLog));
    check('pass-2 runPlan saw the accepted row count (1)', callLog[4] === 'runPlan:2:overrideRows=1', JSON.stringify(callLog));
    check('result.baselinePlan === pass-1 return', result?.baselinePlan === baselineReport, JSON.stringify(Object.keys(result || {})));
    check('result.finalPlan === pass-2 return',    result?.finalPlan    === finalReport,    JSON.stringify(Object.keys(result || {})));
    check('result.validation has accepted + conflicts', result?.validation?.accepted?.length === 1 && Array.isArray(result?.validation?.conflicts), JSON.stringify(result?.validation));
  }

  console.log('\nTest 3: --plan mode — final plan + validation result persisted under logsDir');
  {
    const baselineReport = { mode: 'plan', placements: [], capacityGrid: {}, warnings: [] };
    const finalReport    = { mode: 'plan', placements: [{ crew: 'Ian' }], capacityGrid: {}, warnings: [] };
    const stubLoadAll          = async () => makeFakeBoards();
    let runPlanCalls = 0;
    const stubRunPlan          = async () => (++runPlanCalls === 1 ? baselineReport : finalReport);
    const stubValidateAll      = () => ({ accepted: [], conflicts: [] });
    const stubWriteRowDecisions = async () => ({ written: 0, skipped: 0, errors: [] });

    const fakeFs = makeFakeFs();
    const realLog = console.log; console.log = () => {};
    try {
      await runPlanner({
        mode: 'plan',
        deps: {
          loadAll: stubLoadAll, runPlan: stubRunPlan, validateAll: stubValidateAll, writeRowDecisions: stubWriteRowDecisions,
          fs: fakeFs.fs, logsDir: '/fake/logs', now: () => new Date('2026-05-22T20:00:00Z'),
        },
      });
    } finally { console.log = realLog; }

    const planWrites       = fakeFs.writes.filter(w => /rebalance-plan-.*\.json$/.test(w.path));
    const validationWrites = fakeFs.writes.filter(w => /override-validation-.*\.json$/.test(w.path));
    check('a rebalance-plan-*.json file was written',       planWrites.length >= 1, JSON.stringify(fakeFs.writes.map(w => w.path)));
    check('an override-validation-*.json file was written', validationWrites.length >= 1, JSON.stringify(fakeFs.writes.map(w => w.path)));
    check('rebalance-plan-* content is the FINAL plan (placements != [])',
      planWrites.length && JSON.parse(planWrites[planWrites.length - 1].content)?.placements?.length === 1,
      planWrites.length ? planWrites[planWrites.length - 1].content.slice(0, 200) : '(no writes)');
    check('override-validation-* content has accepted + conflicts arrays',
      validationWrites.length && Array.isArray(JSON.parse(validationWrites[0].content)?.accepted) && Array.isArray(JSON.parse(validationWrites[0].content)?.conflicts),
      validationWrites.length ? validationWrites[0].content : '(no writes)');
  }

  console.log('\nTest 4: --plan mode — pass 2 receives boards with overrideRows filtered to accepted-by-rowId');
  {
    const callLog = [];
    const boards = makeFakeBoards();
    // Add a second row that will be rejected.
    boards.overrideRows.push({
      rowId: 'R2', jobMpmId: 'MPM-A', station: 'Benchwork',
      fromCrewParentId: null, fromWeek: null,
      toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25',
      hours: 4, status: 'Pending', allowOverCap: false,
    });
    const baselineReport = { mode: 'plan', placements: [], capacityGrid: {}, warnings: [] };
    const finalReport    = { mode: 'plan', placements: [], capacityGrid: {}, warnings: [] };

    const stubLoadAll = async () => boards;
    let pass = 0;
    const stubRunPlan = async (b) => {
      pass++;
      callLog.push({ pass, overrideRowIds: (b.overrideRows || []).map(r => r.rowId) });
      return pass === 1 ? baselineReport : finalReport;
    };
    // Accept only R1; reject R2.
    const stubValidateAll = () => ({
      accepted: [{ rowId: 'R1', decision: 'accepted' }],
      conflicts: [{ rowId: 'R2', decision: 'conflict', reason: 'synthetic' }],
    });
    const stubWriteRowDecisions = async () => ({ written: 2, skipped: 0, errors: [] });

    const fakeFs = makeFakeFs();
    const realLog = console.log; console.log = () => {};
    try {
      await runPlanner({
        mode: 'plan',
        deps: {
          loadAll: stubLoadAll, runPlan: stubRunPlan, validateAll: stubValidateAll, writeRowDecisions: stubWriteRowDecisions,
          fs: fakeFs.fs, logsDir: '/fake/logs', now: () => new Date('2026-05-22T20:00:00Z'),
        },
      });
    } finally { console.log = realLog; }

    check('pass 1 saw empty overrideRows', callLog[0]?.overrideRowIds.length === 0, JSON.stringify(callLog));
    check('pass 2 saw exactly [R1] (R2 was rejected)',
      callLog[1]?.overrideRowIds.length === 1 && callLog[1].overrideRowIds[0] === 'R1',
      JSON.stringify(callLog));
  }

  console.log('\nTest 5: --execute mode — loads latest saved plan and calls runExecute, no validation');
  {
    const callLog = [];
    const fakeFs = makeFakeFs();
    // Pre-populate logs/ with a saved plan file. Use path.join so the key
    // matches whatever the orchestrator constructs (Windows = backslash).
    const planContent = JSON.stringify({ mode: 'plan', placements: [{ crew: 'Ian' }] });
    fakeFs.fs.writeFileSync(path.join('/fake/logs', 'rebalance-plan-2026-05-22.json'), planContent);

    const stubLoadAll    = async () => { callLog.push('loadAll'); return makeFakeBoards(); };
    const stubRunPlan    = async () => { callLog.push('runPlan'); return null; };
    const stubRunExecute = async (plan, boards) => {
      callLog.push(`runExecute:placements=${plan?.placements?.length || 0}`);
      return { ok: true };
    };
    const stubValidateAll = () => { callLog.push('validateAll'); return { accepted: [], conflicts: [] }; };
    const stubFindLatestPlanFile = () => 'rebalance-plan-2026-05-22.json';

    const realLog = console.log; console.log = () => {};
    try {
      await runPlanner({
        mode: 'execute',
        deps: {
          loadAll: stubLoadAll, runPlan: stubRunPlan, runExecute: stubRunExecute, validateAll: stubValidateAll,
          findLatestPlanFile: stubFindLatestPlanFile,
          fs: fakeFs.fs, logsDir: '/fake/logs', now: () => new Date('2026-05-22T20:00:00Z'),
        },
      });
    } finally { console.log = realLog; }

    check('runExecute was called', callLog.some(s => s.startsWith('runExecute')), JSON.stringify(callLog));
    check('runExecute received the saved plan (placements===1)', callLog.find(s => s.startsWith('runExecute')) === 'runExecute:placements=1', JSON.stringify(callLog));
    check('runPlan was NOT called in execute mode',  !callLog.includes('runPlan'),      JSON.stringify(callLog));
    check('validateAll was NOT called in execute mode', !callLog.includes('validateAll'), JSON.stringify(callLog));
  }

  console.log('\nTest 6: --plan mode prints "=== OVERRIDE VALIDATION ===" banner with accepted/conflict counts');
  {
    const captured = [];
    const stubLoadAll     = async () => makeFakeBoards();
    let pass = 0;
    const stubRunPlan     = async () => (++pass, { mode: 'plan', placements: [], capacityGrid: {}, warnings: [] });
    const stubValidateAll = () => ({
      accepted:  [{ rowId: 'R1', decision: 'accepted' }],
      conflicts: [{ rowId: 'R2', decision: 'conflict', reason: 'too tall' }],
    });
    const stubWriteRowDecisions = async () => ({ written: 1, skipped: 0, errors: [] });
    const fakeFs = makeFakeFs();

    const realLog = console.log;
    console.log = (...args) => captured.push(args.join(' '));
    try {
      await runPlanner({
        mode: 'plan',
        deps: {
          loadAll: stubLoadAll, runPlan: stubRunPlan, validateAll: stubValidateAll, writeRowDecisions: stubWriteRowDecisions,
          fs: fakeFs.fs, logsDir: '/fake/logs', now: () => new Date('2026-05-22T20:00:00Z'),
        },
      });
    } finally { console.log = realLog; }

    const blob = captured.join('\n');
    check('banner present', /=== OVERRIDE VALIDATION ===/.test(blob), blob.slice(0, 400));
    check('accepted count printed (1)', /accept[^\n]*1/i.test(blob), blob.slice(0, 600));
    check('conflict count printed (1)', /conflict[^\n]*1/i.test(blob), blob.slice(0, 600));
    check('rejected row id surfaced in console',  /R2/.test(blob), blob.slice(0, 800));
  }

  console.log('\nTest 7: --plan mode — writeRowDecisions receives the validation result + gqlFn + today');
  {
    let writebackInvocations = [];
    const stubLoadAll      = async () => makeFakeBoards();
    let pass = 0;
    const stubRunPlan      = async () => (++pass, { mode: 'plan', placements: [], capacityGrid: {}, warnings: [] });
    const stubValidateAll  = () => ({
      accepted: [{ rowId: 'R-ACCEPT', decision: 'accepted' }],
      conflicts: [{ rowId: 'R-CONFLICT', decision: 'conflict', reason: 'past delivery' }],
    });
    const stubWriteRowDecisions = async (validation, opts) => {
      writebackInvocations.push({ validation, opts });
      return { written: 2, skipped: 0, errors: [] };
    };
    const stubGqlFn = async () => ({});
    const fakeFs = makeFakeFs();
    const realLog = console.log; console.log = () => {};
    try {
      await runPlanner({
        mode: 'plan',
        deps: {
          loadAll: stubLoadAll, runPlan: stubRunPlan, validateAll: stubValidateAll,
          writeRowDecisions: stubWriteRowDecisions, gqlFn: stubGqlFn,
          fs: fakeFs.fs, logsDir: '/fake/logs', now: () => new Date('2026-05-22T20:00:00Z'),
        },
      });
    } finally { console.log = realLog; }

    check('writeRowDecisions called once', writebackInvocations.length === 1, JSON.stringify(writebackInvocations));
    const { validation, opts } = writebackInvocations[0] || {};
    check('validation arg has 1 accepted + 1 conflict',
      validation?.accepted?.length === 1 && validation?.conflicts?.length === 1,
      JSON.stringify(validation));
    check('opts.gqlFn is the injected stub', opts?.gqlFn === stubGqlFn, `opts.gqlFn===stubGqlFn? ${opts?.gqlFn === stubGqlFn}`);
    check('opts.today is today ISO string', opts?.today === '2026-05-22', `today=${opts?.today}`);
    check('opts.dryRun defaults to false (no DRY_RUN env)', opts?.dryRun === false, `dryRun=${opts?.dryRun}`);
  }

  console.log('\nTest 8: --plan mode — DRY_RUN=1 environment variable propagates as opts.dryRun=true');
  {
    let received;
    const stubLoadAll      = async () => makeFakeBoards();
    let pass = 0;
    const stubRunPlan      = async () => (++pass, { mode: 'plan', placements: [], capacityGrid: {}, warnings: [] });
    const stubValidateAll  = () => ({ accepted: [], conflicts: [] });
    const stubWriteRowDecisions = async (_, opts) => { received = opts; return { written: 0, skipped: 0, errors: [] }; };
    const fakeFs = makeFakeFs();
    const realLog = console.log; console.log = () => {};
    const prevEnv = process.env.DRY_RUN;
    process.env.DRY_RUN = '1';
    try {
      await runPlanner({
        mode: 'plan',
        deps: {
          loadAll: stubLoadAll, runPlan: stubRunPlan, validateAll: stubValidateAll,
          writeRowDecisions: stubWriteRowDecisions,
          fs: fakeFs.fs, logsDir: '/fake/logs', now: () => new Date('2026-05-22T20:00:00Z'),
        },
      });
    } finally {
      console.log = realLog;
      if (prevEnv === undefined) delete process.env.DRY_RUN; else process.env.DRY_RUN = prevEnv;
    }
    check('opts.dryRun === true under DRY_RUN=1', received?.dryRun === true, `dryRun=${received?.dryRun}`);
  }

  console.log('\nTest 9: --plan mode — computeWindows called per job, jobWindows passed as 5th arg to validateAll (B7-followup)');
  {
    // Boards with two jobs so we can verify computeWindows fires once per job
    // and the result is keyed by jobId in the map handed to validateAll.
    const boards = {
      jobs: [
        { id: 'PL-A', masterPmId: 'MPM-A', name: 'Job A', delivery: '2026-06-12', status: 'Not Started',
          hours: { eng: 4, panel: 8, bench: 16, prefin: 8, postfin: 8 } },
        { id: 'PL-B', masterPmId: 'MPM-B', name: 'Job B', delivery: '2026-05-29', status: 'Not Started',
          hours: { eng: 0, panel: 4, bench: 0, prefin: 4, postfin: 4 } },
        // Job C deliberately has no delivery — computeWindows returns null, must not crash
        { id: 'PL-C', masterPmId: 'MPM-C', name: 'Job C', delivery: null, status: 'Not Started',
          hours: { eng: 0, panel: 0, bench: 0, prefin: 0, postfin: 0 } },
      ],
      crewParents: [
        { parentId: 'CP-IAN-0525', crew: 'Ian', week: '2026-05-25', base: 40, timeOff: 0, nonProd: 0 },
      ],
      timeOff: [],
      existingSubs: [],
      overrideRows: [],
    };

    const cwCalls = [];
    const stubComputeWindows = (job) => {
      cwCalls.push(job.id);
      if (!job.delivery) return null;
      return { bench: { start: '2026-05-18', end: '2026-05-29' }, packShip: { start: '2026-06-08', end: '2026-06-12' } };
    };

    let validateArgs = null;
    const stubValidateAll = (rows, baseline, plJobs, crewParents, jobWindows) => {
      validateArgs = { rows, baseline, plJobs, crewParents, jobWindows };
      return { accepted: [], conflicts: [] };
    };

    const stubLoadAll          = async () => boards;
    let pass = 0;
    const stubRunPlan          = async () => (++pass, { mode: 'plan', placements: [], capacityGrid: {}, warnings: [] });
    const stubWriteRowDecisions = async () => ({ written: 0, skipped: 0, errors: [] });

    const fakeFs = makeFakeFs();
    const realLog = console.log; console.log = () => {};
    try {
      await runPlanner({
        mode: 'plan',
        deps: {
          loadAll: stubLoadAll, runPlan: stubRunPlan, validateAll: stubValidateAll,
          writeRowDecisions: stubWriteRowDecisions,
          computeWindows: stubComputeWindows,
          fs: fakeFs.fs, logsDir: '/fake/logs', now: () => new Date('2026-05-22T20:00:00Z'),
        },
      });
    } finally { console.log = realLog; }

    check('computeWindows called once per job (3 jobs in boards)',
      cwCalls.length === 3, JSON.stringify(cwCalls));
    check('computeWindows saw each job id', cwCalls.includes('PL-A') && cwCalls.includes('PL-B') && cwCalls.includes('PL-C'),
      JSON.stringify(cwCalls));

    check('validateAll received jobWindows as 5th arg', validateArgs?.jobWindows != null,
      `jobWindows=${typeof validateArgs?.jobWindows}`);
    check('jobWindows has PL-A entry', validateArgs?.jobWindows?.['PL-A']?.bench?.start === '2026-05-18',
      JSON.stringify(validateArgs?.jobWindows));
    check('jobWindows has PL-B entry', validateArgs?.jobWindows?.['PL-B']?.bench?.start === '2026-05-18',
      JSON.stringify(validateArgs?.jobWindows));
    check('jobWindows omits PL-C (no delivery → computeWindows returned null)',
      !('PL-C' in (validateArgs?.jobWindows || {})),
      JSON.stringify(Object.keys(validateArgs?.jobWindows || {})));
  }

  console.log('\nTest 10: --plan mode — computeWindows throw is caught per-job (does not abort the run)');
  {
    // assertFinishingCycleValid inside the real computeWindows can throw. A
    // throw must not abort the planner — that job just doesn't get a window
    // and the validator falls back to silent-pass for that job's rows.
    const boards = {
      jobs: [
        { id: 'PL-GOOD', masterPmId: 'MPM-GOOD', name: 'Good Job', delivery: '2026-06-12', status: 'Not Started',
          hours: {} },
        { id: 'PL-BAD', masterPmId: 'MPM-BAD', name: 'Bad Job', delivery: '2026-06-12', status: 'Not Started',
          hours: {} },
      ],
      crewParents: [], timeOff: [], existingSubs: [], overrideRows: [],
    };
    const stubComputeWindows = (job) => {
      if (job.id === 'PL-BAD') throw new Error('synthetic computeWindows error');
      return { bench: { start: '2026-05-18', end: '2026-05-29' } };
    };
    let validateArgs = null;
    const stubValidateAll = (rows, baseline, plJobs, crewParents, jobWindows) => {
      validateArgs = { jobWindows };
      return { accepted: [], conflicts: [] };
    };
    const stubLoadAll = async () => boards;
    let pass = 0;
    const stubRunPlan = async () => (++pass, { mode: 'plan', placements: [], capacityGrid: {}, warnings: [] });
    const stubWriteRowDecisions = async () => ({ written: 0, skipped: 0, errors: [] });

    const fakeFs = makeFakeFs();
    const realLog = console.log; console.log = () => {};
    let ok = false;
    try {
      await runPlanner({
        mode: 'plan',
        deps: {
          loadAll: stubLoadAll, runPlan: stubRunPlan, validateAll: stubValidateAll,
          writeRowDecisions: stubWriteRowDecisions,
          computeWindows: stubComputeWindows,
          fs: fakeFs.fs, logsDir: '/fake/logs', now: () => new Date('2026-05-22T20:00:00Z'),
        },
      });
      ok = true;
    } catch (e) {
      ok = false;
    } finally { console.log = realLog; }

    check('runPlanner did NOT throw on per-job computeWindows error', ok === true, 'threw');
    check('PL-GOOD has a window entry', validateArgs?.jobWindows?.['PL-GOOD']?.bench != null,
      JSON.stringify(validateArgs?.jobWindows));
    check('PL-BAD silently omitted from jobWindows (does not abort)',
      !('PL-BAD' in (validateArgs?.jobWindows || {})),
      JSON.stringify(Object.keys(validateArgs?.jobWindows || {})));
  }

  console.log('\nTest 11: Phase 1.1 — Day-2 simulation: Applied row flows through validateAll, writeback, Pass 2 (persistence fix)');
  {
    // Pre-1.1: an Applied row from Day 1 would be silently dropped on Day 2
    // (validateAll filtered Pending-only). Result: 0 forces in Pass 2 → the
    // deployed override silently un-applies on next --execute. This test
    // simulates Day 2: the board carries a single row in Applied status,
    // and we assert it flows through the full pipeline.
    //
    // Note: this is the orchestrator-side guarantee. The validateAll filter
    // change is unit-tested in test-validate-overrides.js (Tests 39–42); the
    // translateOverrideRows filter change in test-overrides-read-pipeline.js
    // (Tests 7 + 7b). This test confirms the orchestrator routes the Applied
    // row through both correctly.
    const boards = {
      jobs: [
        { id: 'PL-A', masterPmId: 'MPM-A', name: 'Job A', delivery: '2026-06-12', status: 'Not Started',
          hours: { eng: 4, panel: 8, bench: 16, prefin: 8, postfin: 8 } },
      ],
      crewParents: [
        { parentId: 'CP-IAN-0525', crew: 'Ian', week: '2026-05-25', base: 40, timeOff: 0, nonProd: 0 },
      ],
      timeOff: [],
      existingSubs: [],
      overrideRows: [
        // A single row in Applied status — Day-2 scenario.
        { rowId: 'R-APPLIED', jobMpmId: 'MPM-A', station: 'Benchwork',
          fromCrewParentId: null, fromWeek: null,
          toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25',
          hours: 8, status: 'Applied', allowOverCap: false },
      ],
    };

    let validateAllSawRow = null;
    let writebackSawRow   = null;
    const callLog = [];

    const stubLoadAll       = async () => { callLog.push('loadAll'); return boards; };
    let runPlanCalls = 0;
    const stubRunPlan       = async (b) => {
      runPlanCalls++;
      callLog.push(`runPlan:${runPlanCalls}:overrideRows=${(b.overrideRows || []).length}`);
      return { mode: 'plan', placements: [], capacityGrid: {}, warnings: [] };
    };
    const stubValidateAll   = (rows, baseline, plJobs, crewParents, jobWindows) => {
      validateAllSawRow = rows.find(r => r.rowId === 'R-APPLIED') || null;
      // Real validateAll would accept this row (passes all checks against
      // the synthetic baseline). Stub mirrors that outcome so the
      // orchestrator can carry it into Pass 2.
      return {
        accepted: [{ rowId: 'R-APPLIED', decision: 'accepted',
                     jobId: 'PL-A', station: 'Benchwork',
                     fromCrew: null, fromWeek: null,
                     toCrew: 'Ian', toWeek: '2026-05-25', hours: 8 }],
        conflicts: [],
      };
    };
    const stubWriteRowDecisions = async (validation, opts) => {
      writebackSawRow = (validation.accepted || []).find(a => a.rowId === 'R-APPLIED') || null;
      return { written: validation.accepted.length + validation.conflicts.length, skipped: 0, errors: [] };
    };
    const stubComputeWindows = (job) =>
      ({ bench: { start: '2026-05-18', end: '2026-05-29' } });

    const fakeFs = makeFakeFs();
    const realLog = console.log; console.log = () => {};
    try {
      await runPlanner({
        mode: 'plan',
        deps: {
          loadAll: stubLoadAll, runPlan: stubRunPlan, validateAll: stubValidateAll,
          writeRowDecisions: stubWriteRowDecisions, computeWindows: stubComputeWindows,
          fs: fakeFs.fs, logsDir: '/fake/logs', now: () => new Date('2026-05-26T20:00:00Z'),
        },
      });
    } finally { console.log = realLog; }

    check('validateAll received the Applied row (not filtered upstream)',
      validateAllSawRow !== null && validateAllSawRow.status === 'Applied',
      JSON.stringify(validateAllSawRow));
    check('writeRowDecisions received the accepted decision for the Applied row',
      writebackSawRow !== null && writebackSawRow.rowId === 'R-APPLIED',
      JSON.stringify(writebackSawRow));
    // Pass 2's runPlan call should see overrideRows filtered to only the
    // accepted rowIds — i.e., the original R-APPLIED row carried forward.
    const pass2Log = callLog.find(s => s.startsWith('runPlan:2'));
    check('Pass 2 saw the Applied row in overrideRows (count 1)',
      pass2Log === 'runPlan:2:overrideRows=1',
      JSON.stringify({ pass2Log, fullLog: callLog }));
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All B5b run-planner orchestrator tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
