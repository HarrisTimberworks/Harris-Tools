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

  // ===========================================================================
  // C8 — outputs wire-up (Capacity View + Weekly Briefing after writeback)
  // ===========================================================================
  //
  // Writers are INJECTED-ONLY at the runPlanner level: when deps omit
  // writeCapacityView/writeWeeklyBriefing, the outputs stage is skipped with
  // an explicit console note. The CLI entry wires the real writers. This
  // keeps every orchestrator unit test hermetic by construction — no
  // accidental live doc mutations even when MONDAY_API_TOKEN is in env.

  function makeOutputBoards() {
    const boards = makeFakeBoards();
    // Real loadTimeOff shape — NO crew/week fields. If the outputs stage
    // passes this straight to the generators (the reviewed bug), the PTO
    // row assertion in Test 13 fails because this shape never matches.
    boards.timeOff = [
      { id: 'TO-1', name: 'Ken', personId: 'U-KEN', from: '2026-05-18', to: '2026-05-18', type: 'PTO', status: 'Approved', hours: 8 },
    ];
    return boards;
  }

  function makeOutputStubs({ failCapacityView = false } = {}) {
    const calls = [];
    const baselineReport = { mode: 'plan', placements: [], capacityGrid: {}, warnings: [] };
    const finalReport = {
      mode: 'plan',
      placements: [{ crew: 'Ian', week: '2026-05-25', jobId: 'PL-A', jobName: 'Job A', masterPmId: 'MPM-A', station: 'Benchwork', hours: 8, forced: true }],
      capacityGrid: {
        Ian: { '2026-05-25': { committed: 8, avail: 40, timeOff: 0 } },
        // PTO-only crew: zero placements, timeOff in the serialized grid.
        // REVIEW FIX (2026-06-10): the outputs stage must derive PTO rows
        // from the plan's capacityGrid (timeOffEntriesFromPlan), NOT from
        // boards.timeOff (raw loadTimeOff shape has no crew/week fields).
        // Week 2026-05-18 = both the CV window start AND briefingWeekFor's
        // target for the fixture's Friday 2026-05-22 now().
        Ken: { '2026-05-18': { committed: 0, avail: 32, timeOff: 8 } },
      },
      warnings: [],
    };
    let pass = 0;
    return {
      calls,
      baselineReport,
      finalReport,
      deps: {
        loadAll: async () => makeOutputBoards(),
        runPlan: async () => (++pass === 1 ? baselineReport : finalReport),
        validateAll: () => ({
          accepted: [{ rowId: 'R1', decision: 'accepted', jobId: 'PL-A', jobMpmId: 'MPM-A', station: 'Benchwork',
                       fromCrew: null, fromWeek: null, toCrew: 'Ian', toWeek: '2026-05-25', hours: 8 }],
          conflicts: [],
        }),
        writeRowDecisions: async () => ({ written: 1, skipped: 0, errors: [] }),
        writeCapacityView: async (objectId, markdown, opts) => {
          calls.push({ kind: 'cv', objectId, markdown, opts });
          if (failCapacityView) throw new Error('synthetic capacity-view failure');
          return { blocksRead: 5, blocksDeleted: 5, deleteErrors: [], blockIdsAdded: ['a'], dryRun: !!opts?.dryRun, savedMarkdownPath: '/fake/logs/capacity-view-x.md' };
        },
        writeWeeklyBriefing: async (briefing, opts) => {
          calls.push({ kind: 'wb', briefing, opts });
          return { objectId: 'o', created: false, renamed: true, blocksRead: 3, blocksDeleted: 3, deleteErrors: [], blockIdsAdded: ['b'], dryRun: !!opts?.dryRun, savedMarkdownPath: '/fake/logs/weekly-briefing-x.md' };
        },
        now: () => new Date('2026-05-22T20:00:00Z'),
      },
    };
  }

  console.log('\nTest 12: C8 — validation JSON persists acceptedTuples (destination-cell tuple for to-side row)');
  {
    const stubs = makeOutputStubs();
    const fakeFs = makeFakeFs();
    const realLog = console.log; console.log = () => {};
    let result;
    try {
      result = await runPlanner({ mode: 'plan', deps: { ...stubs.deps, fs: fakeFs.fs, logsDir: '/fake/logs' } });
    } finally { console.log = realLog; }

    const vWrite = fakeFs.writes.filter(w => /override-validation-.*\.json$/.test(w.path)).pop();
    const persisted = vWrite ? JSON.parse(vWrite.content) : null;
    check('validation JSON has acceptedTuples array', Array.isArray(persisted?.acceptedTuples), JSON.stringify(persisted)?.slice(0, 300));
    check('tuple is the destination cell (Ian 2026-05-25 Benchwork PL-A)',
      persisted?.acceptedTuples?.length === 1
      && persisted.acceptedTuples[0].crew === 'Ian'
      && persisted.acceptedTuples[0].week === '2026-05-25'
      && persisted.acceptedTuples[0].station === 'Benchwork'
      && String(persisted.acceptedTuples[0].jobId) === 'PL-A',
      JSON.stringify(persisted?.acceptedTuples));
    check('result.outputs.acceptedTuples matches', result?.outputs?.acceptedTuples?.length === 1, JSON.stringify(result?.outputs));
  }

  console.log('\nTest 13: C8 — both writers called after persist; CV gets 8-week doc w/ 🔧, briefing gets single-week shape');
  {
    const stubs = makeOutputStubs();
    const fakeFs = makeFakeFs();
    const captured = [];
    const realLog = console.log; console.log = (...a) => captured.push(a.join(' '));
    let result;
    try {
      result = await runPlanner({ mode: 'plan', deps: { ...stubs.deps, fs: fakeFs.fs, logsDir: '/fake/logs' } });
    } finally { console.log = realLog; }

    const cv = stubs.calls.find(c => c.kind === 'cv');
    const wb = stubs.calls.find(c => c.kind === 'wb');
    check('capacity-view writer called once', stubs.calls.filter(c => c.kind === 'cv').length === 1, JSON.stringify(stubs.calls.map(c => c.kind)));
    check('briefing writer called once', stubs.calls.filter(c => c.kind === 'wb').length === 1, JSON.stringify(stubs.calls.map(c => c.kind)));
    check('CV writer received the live doc object id 18410103423', String(cv?.objectId) === '18410103423', String(cv?.objectId));
    check('CV markdown is the C3 doc (header + legend present)',
      /\*\*Generated:\*\*/.test(cv?.markdown || '') && /## Legend/.test(cv?.markdown || ''), (cv?.markdown || '').slice(0, 150));
    check('CV markdown carries 🔧 on the overridden cell',
      /🔧 8/.test(cv?.markdown || ''), (cv?.markdown || '').split('\n').filter(l => l.includes('Ian')).join(' // '));
    check('CV markdown renders the PTO-only crew row (plan-derived timeOff, not raw board shape)',
      /\| Ken \| PTO \(8h\) \| — \| — \| — \|/.test(cv?.markdown || ''),
      (cv?.markdown || '').split('\n').filter(l => l.includes('Ken')).join(' // ') || '(no Ken rows)');
    check('briefing markdown also renders the PTO-only crew row',
      /\| Ken \| PTO \(8h\) \| — \| — \| — \|/.test(wb?.briefing?.markdown || ''),
      (wb?.briefing?.markdown || '').split('\n').filter(l => l.includes('Ken')).join(' // ') || '(no Ken rows)');
    check('briefing writer received { title, markdown }',
      typeof wb?.briefing?.title === 'string' && /HTW Weekly Briefing — Week of \d{4}-\d{2}-\d{2}/.test(wb.briefing.title) && typeof wb?.briefing?.markdown === 'string',
      JSON.stringify(wb?.briefing?.title));
    check('briefing markdown is single-week (exactly one "## Week of")',
      ((wb?.briefing?.markdown || '').match(/^## Week of /gm) || []).length === 1, '');
    check('plan file written BEFORE writers ran (persist precedes outputs)',
      fakeFs.writes.some(w => /rebalance-plan-.*\.json$/.test(w.path)), JSON.stringify(fakeFs.writes.map(w => w.path)));
    const blob = captured.join('\n');
    check('console prints === OUTPUTS === section', /=== OUTPUTS ===/.test(blob), blob.slice(-600));
    check('result.outputs has both writer results', result?.outputs?.capacityView?.ok === true && result?.outputs?.weeklyBriefing?.ok === true, JSON.stringify(result?.outputs));
    // AUDIT FIX: config lint runs on every --plan and lands in the result.
    check('console prints === CONFIG LINT === section', /=== CONFIG LINT ===/.test(blob), blob.slice(0, 400));
    check('result carries configLint { errors, warnings }', Array.isArray(result?.configLint?.errors) && Array.isArray(result?.configLint?.warnings), JSON.stringify(result?.configLint));
  }

  console.log('\nTest 14: C8 — DRY_RUN=1 propagates dryRun:true to both writers');
  {
    const stubs = makeOutputStubs();
    const fakeFs = makeFakeFs();
    const prevEnv = process.env.DRY_RUN;
    process.env.DRY_RUN = '1';
    const realLog = console.log; console.log = () => {};
    try {
      await runPlanner({ mode: 'plan', deps: { ...stubs.deps, fs: fakeFs.fs, logsDir: '/fake/logs' } });
    } finally {
      console.log = realLog;
      if (prevEnv === undefined) delete process.env.DRY_RUN; else process.env.DRY_RUN = prevEnv;
    }
    const cv = stubs.calls.find(c => c.kind === 'cv');
    const wb = stubs.calls.find(c => c.kind === 'wb');
    check('CV writer got dryRun: true', cv?.opts?.dryRun === true, JSON.stringify(cv?.opts));
    check('briefing writer got dryRun: true', wb?.opts?.dryRun === true, JSON.stringify(wb?.opts));
  }

  console.log('\nTest 15: C8 — capacity-view failure logged loudly, briefing still runs, runPlanner does NOT throw');
  {
    const stubs = makeOutputStubs({ failCapacityView: true });
    const fakeFs = makeFakeFs();
    const captured = [];
    const realLog = console.log; console.log = (...a) => captured.push(a.join(' '));
    let result, threw = false;
    try {
      result = await runPlanner({ mode: 'plan', deps: { ...stubs.deps, fs: fakeFs.fs, logsDir: '/fake/logs' } });
    } catch (e) {
      threw = true;
    } finally { console.log = realLog; }

    check('runPlanner did not throw', threw === false, '');
    check('briefing writer still ran after CV failure', stubs.calls.some(c => c.kind === 'wb'), JSON.stringify(stubs.calls.map(c => c.kind)));
    check('result.outputs.capacityView.ok === false with error', result?.outputs?.capacityView?.ok === false && /synthetic/.test(result?.outputs?.capacityView?.error || ''), JSON.stringify(result?.outputs?.capacityView));
    check('result.outputs.weeklyBriefing.ok === true', result?.outputs?.weeklyBriefing?.ok === true, JSON.stringify(result?.outputs?.weeklyBriefing));
    const blob = captured.join('\n');
    check('failure surfaced loudly in console', /✗.*[Cc]apacity [Vv]iew.*FAILED/.test(blob), blob.slice(-500));
  }

  console.log('\nTest 16: C8 — writers absent from deps → outputs stage skipped with explicit note (hermetic default)');
  {
    const stubs = makeOutputStubs();
    const { writeCapacityView, writeWeeklyBriefing, ...depsNoWriters } = stubs.deps;
    const fakeFs = makeFakeFs();
    const captured = [];
    const realLog = console.log; console.log = (...a) => captured.push(a.join(' '));
    let result;
    try {
      result = await runPlanner({ mode: 'plan', deps: { ...depsNoWriters, fs: fakeFs.fs, logsDir: '/fake/logs' } });
    } finally { console.log = realLog; }
    check('no writer calls', stubs.calls.length === 0, JSON.stringify(stubs.calls.map(c => c.kind)));
    check('console notes outputs skipped', /OUTPUTS[^\n]*skipped/i.test(captured.join('\n')), captured.join('\n').slice(-400));
    check('acceptedTuples still derived + persisted (writers not needed for tuples)',
      result?.outputs?.acceptedTuples?.length === 1, JSON.stringify(result?.outputs));
  }

  console.log('\nTest 17b: SMOKE FIX — pass-2 planner throw: loud abort, accepted rows flipped to Conflict, no persist, no outputs');
  {
    // Surfaced live 2026-06-10: a board force that violates a planner hard
    // rule made pass 2 THROW after writeback already flipped the row to
    // Applied — board lied, nothing persisted, no outputs, silent death.
    // Spec Step 3: "If the planner itself errors → abort, preserve previous
    // good state, raise notification." The orchestrator must catch the pass-2
    // error, re-writeback the accepted rows as Conflict (with the planner's
    // reason), skip persist + outputs, and resolve (not reject) with a
    // planError marker the CLI can turn into a nonzero exit.
    const stubs = makeOutputStubs();
    const writebackCalls = [];
    let pass = 0;
    const deps = {
      ...stubs.deps,
      runPlan: async () => {
        pass++;
        if (pass === 1) return stubs.baselineReport;
        throw new Error('forceAssignment violates hard rule: Ken on Post Fin Cab Assembly 2026-06-22 for SH - McMorris — Ken Post Fin is Commercial-only (subtype: Res - Face Frame)');
      },
      writeRowDecisions: async (validation, opts) => {
        writebackCalls.push(JSON.parse(JSON.stringify(validation)));
        return { written: (validation.accepted || []).length + (validation.conflicts || []).length, skipped: 0, errors: [] };
      },
    };
    const fakeFs = makeFakeFs();
    const captured = [];
    const realLog = console.log; console.log = (...a) => captured.push(a.join(' '));
    let result, threw = false;
    try {
      result = await runPlanner({ mode: 'plan', deps: { ...deps, fs: fakeFs.fs, logsDir: '/fake/logs' } });
    } catch (e) {
      threw = true;
    } finally { console.log = realLog; }

    check('runPlanner resolved (no unhandled rejection)', threw === false, '');
    check('result.planError carries the planner message', /hard rule/.test(result?.planError || ''), JSON.stringify(result?.planError));
    check('no plan/validation files persisted (previous good state preserved)',
      !fakeFs.writes.some(w => /rebalance-plan-|override-validation-/.test(w.path)),
      JSON.stringify(fakeFs.writes.map(w => w.path)));
    check('no output writers called', stubs.calls.length === 0, JSON.stringify(stubs.calls.map(c => c.kind)));
    check('writeback called twice (decisions, then failure flip)', writebackCalls.length === 2, `calls=${writebackCalls.length}`);
    check('second writeback flips the accepted row to Conflict with the planner reason',
      writebackCalls[1]?.accepted?.length === 0
      && writebackCalls[1]?.conflicts?.length === 1
      && writebackCalls[1].conflicts[0].rowId === 'R1'
      && /hard rule/.test(writebackCalls[1].conflicts[0].reason || ''),
      JSON.stringify(writebackCalls[1]));
    const blob = captured.join('\n');
    check('failure surfaced loudly in console', /✗.*[Pp]ass 2|PLANNER ERROR|planner error/i.test(blob), blob.slice(-500));
  }

  console.log('\nTest 5b: AUDIT FIX — execute refuses a plan older than 24h unless --force');
  {
    const mkDeps = (generatedAt) => {
      const fakeFs = makeFakeFs();
      const planContent = JSON.stringify({ mode: 'plan', generatedAt, placements: [{ crew: 'Bob' }] });
      fakeFs.fs.writeFileSync(path.join('/fake/logs', 'rebalance-plan-2026-06-10.json'), planContent);
      const calls = [];
      return {
        calls,
        deps: {
          loadAll: async () => makeFakeBoards(),
          runExecute: async (plan) => { calls.push('runExecute'); return { ok: true }; },
          findLatestPlanFile: () => 'rebalance-plan-2026-06-10.json',
          fs: fakeFs.fs, logsDir: '/fake/logs',
          now: () => new Date('2026-06-12T20:00:00Z'),
        },
      };
    };

    // Stale (generated 2 days before now) → refuses.
    const stale = mkDeps('2026-06-10T20:00:00Z');
    let threw = null;
    const realLog = console.log; console.log = () => {};
    try { await runPlanner({ mode: 'execute', deps: stale.deps }); } catch (e) { threw = e; } finally { console.log = realLog; }
    check('stale plan → throws with age + remedy', threw !== null && /old|stale/i.test(threw.message) && /--force|--plan/.test(threw.message), String(threw && threw.message));
    check('runExecute NOT called for stale plan', !stale.calls.includes('runExecute'), JSON.stringify(stale.calls));

    // Stale + force → executes.
    const forced = mkDeps('2026-06-10T20:00:00Z');
    console.log = () => {};
    try { await runPlanner({ mode: 'execute', options: { force: true }, deps: forced.deps }); } finally { console.log = realLog; }
    check('stale + force → executes', forced.calls.includes('runExecute'), JSON.stringify(forced.calls));

    // Fresh (3 hours old) → executes.
    const fresh = mkDeps('2026-06-12T17:00:00Z');
    console.log = () => {};
    try { await runPlanner({ mode: 'execute', deps: fresh.deps }); } finally { console.log = realLog; }
    check('fresh plan → executes', fresh.calls.includes('runExecute'), JSON.stringify(fresh.calls));
  }

  console.log('\nTest 16b: STATIONS-COMPLETE — derived Ready to Ship status flips qualifying jobs (dryRun-aware)');
  {
    // A job whose every formula>0 station is marked done on the board gets
    // its PLB status flipped to 'Ready to Ship' during --plan. Jobs already
    // Ready to Ship, inactive jobs, and partially-done jobs are untouched.
    const mkBoards = () => {
      const b = makeFakeBoards();
      b.jobs = [
        { id: 'PL-RTS', masterPmId: 'MPM-RTS', name: 'Ship Me', delivery: '2026-06-26', status: 'Finishing',
          formulaHours: { eng: 4, panel: 8, bench: 0, prefin: 6, postfin: 5 },
          stationsComplete: ['Eng', 'Panel', 'PreFin', 'PostFin'],
          hours: { eng: 0, panel: 0, bench: 0, prefin: 0, postfin: 0 } },
        { id: 'PL-PART', masterPmId: 'MPM-PART', name: 'Partial', delivery: '2026-07-02', status: 'Scheduled',
          formulaHours: { eng: 4, panel: 8, bench: 10, prefin: 0, postfin: 5 },
          stationsComplete: ['Eng'],
          hours: { eng: 0, panel: 8, bench: 10, prefin: 0, postfin: 5 } },
        { id: 'PL-ALREADY', masterPmId: 'MPM-ALR', name: 'Already RTS', delivery: '2026-07-02', status: 'Ready to Ship',
          formulaHours: { eng: 4, panel: 0, bench: 0, prefin: 0, postfin: 0 },
          stationsComplete: ['Eng'],
          hours: { eng: 0, panel: 0, bench: 0, prefin: 0, postfin: 0 } },
        // AUDIT FIX — intake flip (legacy 15-min scheduler retired): a Ready
        // to Schedule job that received placements flips to Scheduled.
        { id: 'PL-INTAKE', masterPmId: 'MPM-INTAKE', name: 'New Job', delivery: '2026-07-10', status: 'Ready to Schedule',
          formulaHours: { eng: 4, panel: 8, bench: 10, prefin: 4, postfin: 5 },
          stationsComplete: [],
          hours: { eng: 4, panel: 8, bench: 10, prefin: 4, postfin: 5 } },
      ];
      return b;
    };
    const run = async (env) => {
      const gqlCalls = [];
      const stubGql = async (q, v) => { gqlCalls.push({ q, v }); return {}; };
      let pass = 0;
      const fakeFs = makeFakeFs();
      const captured = [];
      const realLog = console.log; console.log = (...a) => captured.push(a.join(' '));
      const prevEnv = process.env.DRY_RUN;
      if (env) process.env.DRY_RUN = '1'; else delete process.env.DRY_RUN;
      try {
        await runPlanner({ mode: 'plan', deps: {
          loadAll: async () => mkBoards(),
          runPlan: async () => (++pass, { mode: 'plan',
            placements: [{ masterPmId: 'MPM-INTAKE', jobId: 'PL-INTAKE', crew: 'Bob', week: '2026-06-15', station: 'Benchwork', hours: 10 }],
            capacityGrid: {}, warnings: [] }),
          validateAll: () => ({ accepted: [], conflicts: [] }),
          writeRowDecisions: async () => ({ written: 0, skipped: 0, errors: [] }),
          gqlFn: stubGql,
          fs: fakeFs.fs, logsDir: '/fake/logs', now: () => new Date('2026-06-11T20:00:00Z'),
        } });
      } finally {
        console.log = realLog;
        if (prevEnv === undefined) delete process.env.DRY_RUN; else process.env.DRY_RUN = prevEnv;
      }
      return { gqlCalls, blob: captured.join('\n') };
    };

    const live = await run(false);
    const statusFlips = live.gqlCalls.filter(c => /change_multiple_column_values/.test(c.q) && /Ready to Ship/.test(JSON.stringify(c.v)));
    check('exactly one flip (PL-RTS only)', statusFlips.length === 1, JSON.stringify(live.gqlCalls.map(c => c.v)));
    const intakeFlips = live.gqlCalls.filter(c => /change_multiple_column_values/.test(c.q)
      && /Scheduled/.test(JSON.stringify(c.v)) && !/Ready to Ship/.test(JSON.stringify(c.v)));
    check('intake flip: PL-INTAKE (Ready to Schedule + placed) → Scheduled',
      intakeFlips.length === 1 && String(intakeFlips[0]?.v?.item) === 'PL-INTAKE',
      JSON.stringify(intakeFlips.map(c => c.v)));
    check('flip targets PL-RTS on the Production Load board',
      String(statusFlips[0]?.v?.item) === 'PL-RTS' && String(statusFlips[0]?.v?.board) === '18407601557',
      JSON.stringify(statusFlips[0]?.v));
    check('console prints STATUS DERIVATION section', /=== STATUS DERIVATION ===/.test(live.blob), live.blob.slice(-400));

    const dry = await run(true);
    const dryFlips = dry.gqlCalls.filter(c => /change_multiple_column_values/.test(c.q) && /Ready to Ship/.test(JSON.stringify(c.v)));
    check('DRY_RUN: no flip mutation', dryFlips.length === 0, JSON.stringify(dryFlips));
    check('DRY_RUN: would-flip logged', /would set .*Ship Me.*Ready to Ship/i.test(dry.blob), dry.blob.slice(-400));
  }

  console.log('\nTest 16c: SHOP-FLOOR PROGRESS — progressWarnings surfaced; board Hrs Left blocks RTS flip');
  {
    // Verifies that shopProgressWarnings runs and its output is:
    //   1. Printed under === SHOP-FLOOR PROGRESS === in console.
    //   2. Returned in result.progressWarnings.
    //   3. Does NOT cause a Ready-to-Ship flip when board Hrs Left (hrsLeft)
    //      shows remaining work that formula says is done (bench formula=0 but ⏳5).
    const empty = { eng: null, panel: null, bench: null, prefin: null, postfin: null };
    const mkBoards16c = () => {
      const b = makeFakeBoards();
      b.jobs = [
        // 1) Would flip RTS on ticks alone, but bench (formula 0) carries ⏳5 → must NOT flip.
        { id: 'PL-HL-BLOCK', masterPmId: 'MPM-HLB', name: 'Blocked By Board Hours', delivery: '2026-06-26', status: 'Finishing',
          formulaHours: { eng: 4, panel: 8, bench: 0, prefin: 0, postfin: 5 },
          stationsComplete: ['Eng', 'Panel', 'PostFin'],
          hrsLeft: { ...empty, bench: 5 },
          hours: { eng: 0, panel: 0, bench: 5, prefin: 0, postfin: 0 } },
        // 2) ⏳0 unticked → nudge warning.
        { id: 'PL-HL-NUDGE', masterPmId: 'MPM-HLN', name: 'Nudge Me', delivery: '2026-07-02', status: 'Scheduled',
          formulaHours: { eng: 4, panel: 8, bench: 10, prefin: 0, postfin: 5 },
          stationsComplete: [],
          hrsLeft: { ...empty, panel: 0 },
          hours: { eng: 4, panel: 0, bench: 10, prefin: 0, postfin: 5 } },
      ];
      return b;
    };
    const run16c = async (env) => {
      const gqlCalls = [];
      const stubGql = async (q, v) => { gqlCalls.push({ q, v }); return {}; };
      let pass = 0;
      const fakeFs = makeFakeFs();
      const captured = [];
      const realLog = console.log; console.log = (...a) => captured.push(a.join(' '));
      const prevEnv = process.env.DRY_RUN;
      if (env) process.env.DRY_RUN = '1'; else delete process.env.DRY_RUN;
      let result;
      try {
        result = await runPlanner({ mode: 'plan', deps: {
          loadAll: async () => mkBoards16c(),
          runPlan: async () => (++pass, { mode: 'plan',
            placements: [],
            capacityGrid: {}, warnings: [] }),
          validateAll: () => ({ accepted: [], conflicts: [] }),
          writeRowDecisions: async () => ({ written: 0, skipped: 0, errors: [] }),
          gqlFn: stubGql,
          fs: fakeFs.fs, logsDir: '/fake/logs', now: () => new Date('2026-06-12T20:00:00Z'),
        } });
      } finally {
        console.log = realLog;
        if (prevEnv === undefined) delete process.env.DRY_RUN; else process.env.DRY_RUN = prevEnv;
      }
      return { gqlCalls, blob: captured.join('\n'), result };
    };

    const live = await run16c(false);
    check('console prints SHOP-FLOOR PROGRESS section', /=== SHOP-FLOOR PROGRESS ===/.test(live.blob), live.blob.slice(-600));
    check('result carries progressWarnings array', Array.isArray(live.result.progressWarnings), typeof live.result.progressWarnings);
    check('nudge warning present', live.result.progressWarnings.some(w => /Nudge Me Panel/.test(w)), JSON.stringify(live.result.progressWarnings));
    check('board-added-work info present (bench ⏳5 > formula 0)',
      live.result.progressWarnings.some(w => /Blocked By Board Hours Bench/.test(w)), JSON.stringify(live.result.progressWarnings));
    check('exactly 2 warnings', live.result.progressWarnings.length === 2, JSON.stringify(live.result.progressWarnings));
    check('NO RTS flip (bench ⏳5 blocks despite all formula>0 ticks)',
      live.gqlCalls.filter(c => /change_multiple_column_values/.test(c.q) && /Ready to Ship/.test(JSON.stringify(c.v))).length === 0,
      JSON.stringify(live.gqlCalls.map(c => c.v)));
  }

  console.log('\nTest 17: C8 — execute mode never touches writers or tuple derivation');
  {
    const stubs = makeOutputStubs();
    const fakeFs = makeFakeFs();
    const planContent = JSON.stringify({ mode: 'plan', placements: [{ crew: 'Ian' }] });
    fakeFs.fs.writeFileSync(path.join('/fake/logs', 'rebalance-plan-2026-05-22.json'), planContent);
    const realLog = console.log; console.log = () => {};
    try {
      await runPlanner({
        mode: 'execute',
        deps: {
          ...stubs.deps,
          runExecute: async () => ({ ok: true }),
          findLatestPlanFile: () => 'rebalance-plan-2026-05-22.json',
          fs: fakeFs.fs, logsDir: '/fake/logs',
        },
      });
    } finally { console.log = realLog; }
    check('no writer calls in execute mode', stubs.calls.length === 0, JSON.stringify(stubs.calls.map(c => c.kind)));
  }

  // ===========================================================================
  // Task 11 — lead-times writer hook (third independent writer)
  // ===========================================================================

  console.log('\nTest 18: Task 11 — deps.writeLeadTimes invoked once; outputs.leadTimes.ok === true');
  {
    // Verifies the lead-times hook fires in the outputs stage and that the
    // result lands in outputs.leadTimes with ok: true. Stubs loadQuotePolicy
    // and leadTimesForBasket via deps injection (the hook falls back to
    // require('./quote-engine.js') only when these deps are absent) so the
    // test stays hermetic — no API calls, no board data needed.
    const stubs = makeOutputStubs();
    const ltCalls = [];
    const fakeBasket = [
      { label: 'Typical residential FF', jobType: 'Res - Face Frame', display: 'Face frame', quotedWeek: '2026-09-07', weeks: 12 },
    ];
    const stubLoadQuotePolicy    = () => ({ preProductionWeeks: 2, minLeadWeeks: {}, defaultFinishingDays: 5, referenceBasket: [] });
    const stubLeadTimesForBasket = async () => fakeBasket;
    const stubWriteLeadTimes     = async (basket, opts) => {
      ltCalls.push({ basket, opts });
      return { files: ['/fake/logs/lead-times-2026-05-22.json', '/fake/logs/lead-times.json', '/fake/logs/lead-times-snippet.html'] };
    };

    const fakeFs = makeFakeFs();
    const realLog = console.log; console.log = () => {};
    let result;
    try {
      result = await runPlanner({
        mode: 'plan',
        deps: {
          ...stubs.deps,
          fs: fakeFs.fs,
          logsDir: '/fake/logs',
          loadQuotePolicy: stubLoadQuotePolicy,
          leadTimesForBasket: stubLeadTimesForBasket,
          writeLeadTimes: stubWriteLeadTimes,
        },
      });
    } finally { console.log = realLog; }

    check('lead-times writer invoked exactly once', ltCalls.length === 1, `calls=${ltCalls.length}`);
    check('writer received the basket array', Array.isArray(ltCalls[0]?.basket), JSON.stringify(ltCalls[0]?.basket));
    check('outputs.leadTimes.ok === true', result?.outputs?.leadTimes?.ok === true, JSON.stringify(result?.outputs?.leadTimes));
    check('outputs.leadTimes is not null', result?.outputs?.leadTimes !== null, JSON.stringify(result?.outputs?.leadTimes));
    check('other writers unaffected (capacityView ok)', result?.outputs?.capacityView?.ok === true, JSON.stringify(result?.outputs?.capacityView));
    check('other writers unaffected (weeklyBriefing ok)', result?.outputs?.weeklyBriefing?.ok === true, JSON.stringify(result?.outputs?.weeklyBriefing));
  }

  console.log('\nTest 19: Task 11 — throwing writeLeadTimes → outputs.leadTimes.ok === false; other writers unaffected');
  {
    // Verifies per-writer try/catch: a writeLeadTimes throw must not abort the
    // run, and the other two writers' results must be unchanged.
    const stubs = makeOutputStubs();
    const stubLoadQuotePolicy    = () => ({ preProductionWeeks: 2, minLeadWeeks: {}, defaultFinishingDays: 5, referenceBasket: [] });
    const stubLeadTimesForBasket = async () => [];
    const stubWriteLeadTimesThrows = async () => {
      throw new Error('synthetic lead-times write failure');
    };

    const fakeFs = makeFakeFs();
    const captured = [];
    const realLog = console.log; console.log = (...a) => captured.push(a.join(' '));
    let result, threw = false;
    try {
      result = await runPlanner({
        mode: 'plan',
        deps: {
          ...stubs.deps,
          fs: fakeFs.fs,
          logsDir: '/fake/logs',
          loadQuotePolicy: stubLoadQuotePolicy,
          leadTimesForBasket: stubLeadTimesForBasket,
          writeLeadTimes: stubWriteLeadTimesThrows,
        },
      });
    } catch (e) {
      threw = true;
    } finally { console.log = realLog; }

    check('runPlanner did not throw on lead-times failure', threw === false, '');
    check('outputs.leadTimes.ok === false', result?.outputs?.leadTimes?.ok === false, JSON.stringify(result?.outputs?.leadTimes));
    check('outputs.leadTimes.error contains the message', /synthetic/.test(result?.outputs?.leadTimes?.error || ''), JSON.stringify(result?.outputs?.leadTimes));
    check('capacityView writer still ran (ok === true)', result?.outputs?.capacityView?.ok === true, JSON.stringify(result?.outputs?.capacityView));
    check('weeklyBriefing writer still ran (ok === true)', result?.outputs?.weeklyBriefing?.ok === true, JSON.stringify(result?.outputs?.weeklyBriefing));
    const blob = captured.join('\n');
    check('failure surfaced loudly in console', /✗.*[Ll]ead-[Tt]imes.*FAILED/.test(blob), blob.slice(-400));
    // Fix 3: shouldNotify must fire for lead-times failures so the trigger notifies Chris.
    const { shouldNotify } = require('./planner-trigger.js');
    const n = shouldNotify(result);
    check('shouldNotify.notify === true for lead-times failure', n.notify === true, JSON.stringify(n));
    check('shouldNotify reasons mention lead-times', n.reasons.some(r => /lead-times/i.test(r)), JSON.stringify(n.reasons));
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
