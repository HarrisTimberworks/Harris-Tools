#!/usr/bin/env node
// B5b — run-planner.js: Phase 1 two-pass driver.
//
// Phase 1 spec's expected wrapper around the existing rebalance-schedule.js.
// Replaces direct `node scripts/rebalance-schedule.js --plan` as the
// recommended path; the old CLI continues to work for backwards-compat.
//
// CLI:
//   node scripts/run-planner.js --plan          (default)
//   node scripts/run-planner.js --execute       (after --plan)
//   node scripts/run-planner.js --force         (A3 bypass; pass-through to runExecute)
//   node scripts/run-planner.js --auto-create-parents (A4 opt-in; pass-through to runPlan)
//
// Two-pass flow in --plan mode:
//   1. loadAll() — fetch all monday boards once (jobs, crewParents, timeOff,
//      existingSubs, overrideRows).
//   2. Pass 1 — runPlan(boards-without-overrideRows) → baselinePlan. The
//      validator needs a baseline to check consistency against, and per E2
//      we don't want the baseline polluted by partially-validated rows.
//   3. validateAll(pendingRows, baselinePlan, jobs, crewParents) →
//      { accepted, conflicts }.
//   4. Pass 2 — runPlan(boards-with-only-accepted-rows) → finalPlan.
//      Translate happens inside runPlan via translateOverrideRows; we feed
//      the original raw row objects (looked up by rowId) so the existing
//      translation path is reused with zero divergence.
//   5. Persist finalPlan to logs/rebalance-plan-<today>.json (same filename
//      that --execute looks for, so the old CLI keeps working) AND validation
//      result to logs/override-validation-<today>.json (B6 will consume this
//      on writeback).
//
// --execute mode is unchanged from rebalance-schedule.js's executor path:
// load the latest plan file, hand it to runExecute. Validation is irrelevant
// at execute time — the plan JSON already reflects what passed validation.
//
// Console output includes an "=== OVERRIDE VALIDATION ===" section between
// the FCV block and the final summary, showing accepted/conflict counts +
// per-row decisions.
//
// All dependencies are injectable via the `deps` parameter so the test
// harness (scripts/test-run-planner-orchestrator.js) can stub loadAll /
// runPlan / validateAll / fs without touching real monday or logs/.

const fs = require('fs');
const path = require('path');
const reb = require('./rebalance-schedule.js');
const { validateAll: realValidateAll } = require('./validate-overrides.js');
const { writeRowDecisions: realWriteRowDecisions } = require('./writeback-overrides.js');
const { buildCapacityViewDoc, deriveAcceptedOverrideTuples, timeOffEntriesFromPlan } = require('./capacity-view-generator.js');
const { buildWeeklyBriefingDoc } = require('./weekly-briefing-generator.js');
const { CAPACITY_VIEW_OBJECT_ID } = require('./write-capacity-view.js');

function isoOfDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

async function runPlanner({ mode = 'plan', options = {}, deps = {} } = {}) {
  const _loadAll       = deps.loadAll       || reb.loadAll;
  const _runPlan       = deps.runPlan       || reb.runPlan;
  const _runExecute    = deps.runExecute    || reb.runExecute;
  const _validateAll   = deps.validateAll   || realValidateAll;
  const _writeRowDecisions = deps.writeRowDecisions || realWriteRowDecisions;
  const _computeWindows = deps.computeWindows || reb.computeWindows;
  const _gqlFn         = deps.gqlFn         || reb.gql;
  const _findLatest    = deps.findLatestPlanFile || reb.findLatestPlanFile;
  const _fs            = deps.fs            || fs;
  const _logsDir       = deps.logsDir       || path.join(__dirname, '..', 'logs');
  const _now           = deps.now           || (() => new Date());
  const _dryRun        = process.env.DRY_RUN === '1';

  const todayISO = isoOfDate(_now());

  console.log(`=== HTW Rebalancer (run-planner.js) — ${mode.toUpperCase()} mode ===`);
  console.log('Loading data from monday.com...');
  const boards = await _loadAll();

  if (mode === 'execute') {
    const fname = _findLatest(_logsDir);
    if (!fname) {
      console.error('No plan file found. Run with --plan first.');
      process.exit(1);
    }
    const planFile = path.join(_logsDir, fname);
    console.log(`Loading plan: ${planFile}`);
    const planObj = JSON.parse(_fs.readFileSync(planFile, 'utf8'));

    // AUDIT FIX (2026-06-11): a days-old plan applied against changed board
    // state computes deletes/creates from a stale world. Refuse beyond 24h
    // unless --force (operator re-runs --plan first, which takes ~2 min).
    const MAX_PLAN_AGE_MS = 24 * 3600 * 1000;
    if (planObj.generatedAt) {
      const ageMs = _now().getTime() - new Date(planObj.generatedAt).getTime();
      if (ageMs > MAX_PLAN_AGE_MS && !options.force) {
        throw new Error(
          `plan ${fname} is ${(ageMs / 3600e3).toFixed(1)}h old (generated ${planObj.generatedAt}) — ` +
          `boards have likely changed. Re-run --plan first, or pass --force to apply anyway.`);
      }
    } else {
      console.log('  ⚠️  plan has no generatedAt stamp — age guard skipped (legacy file)');
    }

    const executed = await _runExecute(planObj, boards);
    return { plan: planObj, executed: executed || null };
  }

  // --plan mode: two-pass driver.

  // AUDIT FIX (2026-06-11) — config lint: surface silent no-op shapes in
  // config/rebalance-overrides.json (typo'd ids, 'station' vs 'stations',
  // non-Monday weeks) loudly at the top of every run. Never blocks the run.
  let configLint = { errors: [], warnings: [] };
  try {
    const { validateOverridesConfig } = require('./validate-config.js');
    const overridesCfg = deps.overridesConfig || require('../config/rebalance-overrides.json');
    // subcontractors is keyed by week → arrays of pool entries.
    const subNames = Object.values(overridesCfg.subcontractors || {})
      .flat().map(s => s && s.name).filter(Boolean);
    const crews = new Set([
      ...(boards.crewParents || []).map(p => p.crew),
      ...subNames,
    ]);
    configLint = validateOverridesConfig(overridesCfg, {
      jobIds: (boards.jobs || []).map(j => j.id),
      crews,
      todayISO,
    });
  } catch (e) {
    configLint.warnings.push(`config lint itself failed: ${e.message}`);
  }
  console.log('\n=== CONFIG LINT ===');
  if (configLint.errors.length === 0 && configLint.warnings.length === 0) {
    console.log('  clean ✅');
  }
  for (const e of configLint.errors) console.log(`  ✗ ${e}`);
  for (const w of configLint.warnings) console.log(`  ⚠️  ${w}`);

  // Pass 1: baseline. Strip overrideRows so the baseline reflects the
  // structural-config-only world. The validator's consistency check
  // compares row.fromCrew × row.fromWeek × row.station × jobMpmId against
  // THIS baseline's placements — any board row asking to move hours that
  // don't exist there is rejected with no further reasoning.
  const baselineBoards = { ...boards, overrideRows: [] };
  console.log('\n--- Pass 1: baseline plan (no board overrides) ---');
  const baselinePlan = await _runPlan(baselineBoards);

  // B7-followup: build jobWindows = { [jobId]: <computeWindows result> } so
  // the validator's checkWindowMembership can reject out-of-window forces
  // (which the planner silently drops). Per-job try/catch — a throw from
  // assertFinishingCycleValid inside computeWindows must not abort the run;
  // that job just doesn't get a window and the validator silent-passes its
  // rows (matches the missing-delivery silent-pass policy).
  const jobWindows = {};
  for (const job of boards.jobs || []) {
    try {
      const w = _computeWindows(job);
      if (w) jobWindows[job.id] = w;
    } catch (e) {
      // Silently skip — leave the job out of jobWindows. Logging would
      // double-warn the operator (the same finishing-cycle issue surfaces
      // again inside runPlan's own A3 reporting path).
    }
  }

  // Phase 1.1: Pending + Applied both validate. validateAll's filter is the
  // authoritative gate; this pre-filter is just for the console log + the
  // count we hand to validateAll's slice. Conflict / Cleared rows skip the
  // count (they're not "to-be-validated" rows from the operator's POV).
  const toValidate = (boards.overrideRows || []).filter(r => r.status === 'Pending' || r.status === 'Applied');
  console.log(`\n--- Validating ${toValidate.length} Pending/Applied override row(s) against baseline ---`);
  const validation = _validateAll(toValidate, baselinePlan, boards.jobs, boards.crewParents, jobWindows);

  console.log('\n=== OVERRIDE VALIDATION ===');
  console.log(`Accepted: ${validation.accepted.length}`);
  console.log(`Conflicts: ${validation.conflicts.length}`);
  for (const a of validation.accepted) {
    const warn = a.softWarning ? ` — soft warn: ${a.softWarning}` : '';
    console.log(`  ✓ row ${a.rowId}${warn}`);
  }
  for (const c of validation.conflicts) {
    console.log(`  ✗ row ${c.rowId}: ${c.reason}`);
  }

  // B6 writeback — fires at --plan time (deliberate spec deviation, see
  // writeback-overrides.js docstring). Conflicts surface on the board the
  // moment they're known; accepted rows are marked Applied even though pass 2
  // hasn't run yet — the decision is already final, pass 2 just produces the
  // plan that reflects those decisions. Empty validation → zero-row no-op.
  console.log('\n=== OVERRIDE WRITEBACK ===');
  if (_dryRun) console.log('  DRY RUN MODE — no mutations will fire');
  const writeback = await _writeRowDecisions(validation, {
    gqlFn: _gqlFn,
    today: todayISO,
    dryRun: _dryRun,
  });
  console.log(`  written: ${writeback.written}, skipped: ${writeback.skipped}, errors: ${writeback.errors.length}`);
  for (const e of writeback.errors) console.log(`  ✗ row ${e.rowId}: ${e.error}`);

  // Pass 2: re-run runPlan with only the accepted board rows in overrideRows.
  // Look up original raw rows by rowId so translateOverrideRows (inside runPlan)
  // sees the same shape it would on a single-pass run. Conflict rows are
  // dropped — they neither contribute to the final plan nor get written back
  // as Applied; B6 will surface their conflict state to the operator.
  const acceptedIds = new Set(validation.accepted.map(a => a.rowId));
  const finalOverrideRows = (boards.overrideRows || []).filter(r => acceptedIds.has(r.rowId));
  const finalBoards = { ...boards, overrideRows: finalOverrideRows };
  console.log(`\n--- Pass 2: final plan (${finalOverrideRows.length} accepted override row(s) applied) ---`);

  // SMOKE FIX (2026-06-10) — pass-2 guard, spec Step 3: "If the planner
  // itself errors → abort, preserve previous good state, raise notification."
  // Before this guard, a planner throw (e.g. a board force hitting a PATCH-3
  // hard rule) killed the run AFTER writeback had flipped rows to Applied:
  // the board lied, nothing persisted, no outputs, no loud signal. Now: the
  // error is surfaced loudly, the accepted rows are re-written back as
  // Conflict carrying the planner's reason, nothing is persisted (the
  // previous plan/validation files and docs stay the good state), and the
  // CLI exits nonzero via the planError marker.
  let finalPlan;
  try {
    finalPlan = await _runPlan(finalBoards);
  } catch (e) {
    const msg = e.message || String(e);
    console.log(`\n✗ PLANNER ERROR in pass 2 — run aborted, previous good state preserved: ${msg}`);
    const failureFlip = {
      accepted: [],
      conflicts: validation.accepted.map(a => ({
        rowId: a.rowId,
        decision: 'conflict',
        reason: `planner error during apply: ${msg}`,
      })),
    };
    console.log(`  Flipping ${failureFlip.conflicts.length} previously-accepted row(s) to Conflict on the board...`);
    const flip = await _writeRowDecisions(failureFlip, { gqlFn: _gqlFn, today: todayISO, dryRun: _dryRun });
    console.log(`  written: ${flip.written}, skipped: ${flip.skipped}, errors: ${flip.errors.length}`);
    console.log('  No plan/validation files written; Capacity View + Weekly Briefing not regenerated.');
    return { baselinePlan, validation, planError: msg };
  }

  // C5/C8 — derive the 🔧 tuple set BEFORE persisting validation, so the
  // on-disk override-validation JSON carries acceptedTuples for standalone
  // writer CLIs (write-capacity-view.js / write-weekly-briefing.js read it
  // via tuplesFromPersistedValidation). Needs both plans: pure-clear rows
  // wrench by diffing final vs baseline cells.
  const acceptedTuples = deriveAcceptedOverrideTuples(validation.accepted, baselinePlan, finalPlan);
  validation.acceptedTuples = acceptedTuples;

  // Persist final plan + validation result. NOTE: runPlan itself writes a
  // rebalance-plan-<today>.json inside the call (line ~1828 of
  // rebalance-schedule.js); we overwrite here with the same filename to
  // guarantee the file on disk is the final plan (pass 2), not pass 1.
  // The wasted intermediate write is acceptable for Phase 1.
  if (!_fs.existsSync(_logsDir)) _fs.mkdirSync(_logsDir, { recursive: true });
  const planFile = path.join(_logsDir, `rebalance-plan-${todayISO}.json`);
  _fs.writeFileSync(planFile, JSON.stringify(finalPlan, null, 2));
  const validationFile = path.join(_logsDir, `override-validation-${todayISO}.json`);
  _fs.writeFileSync(validationFile, JSON.stringify(validation, null, 2));
  console.log(`\nFinal plan saved: ${planFile}`);
  console.log(`Validation result saved: ${validationFile}`);

  // ==========================================================================
  // C8 — outputs stage (Capacity View + Weekly Briefing), per D5: fire at
  // the end of --plan, after writeback + persist. Writers are INJECTED-ONLY
  // here; the CLI entry wires the real implementations. Unit tests that omit
  // them are hermetic by construction — no accidental live doc mutations
  // even with MONDAY_API_TOKEN in env.
  //
  // Failure policy (spec "Failure handling between steps"): each writer is
  // independent; a Capacity View failure is logged loudly and the Weekly
  // Briefing still runs. runPlanner does not throw — the plan + validation
  // files are already saved, and the writers are re-runnable standalone.
  // ==========================================================================
  // ==========================================================================
  // Stations-Complete status derivation (2026-06-11): a job whose every
  // formula>0 production station is marked done on the PLB flips to
  // 'Ready to Ship' — production finished, job stays ACTIVE so P&S/Delivery
  // keep planning (the Liz Stapp Complete-cliff fix). Idempotent: jobs
  // already Ready to Ship (or any non-production status) are skipped.
  // ==========================================================================
  const _isReadyToShip = deps.isReadyToShip || reb.isReadyToShip;
  const BOARD_PROD_LOAD = '18407601557';
  const PL_STATUS_COL = 'color_mm26404x';
  const rtsCandidates = (boards.jobs || []).filter(j =>
    ['Not Started', 'Scheduled', 'Ready to Schedule', 'Finishing'].includes(j.status)
    && _isReadyToShip(j.formulaHours, j.stationsComplete));
  console.log('\n=== STATUS DERIVATION ===');
  const statusDerivation = { flipped: [], dryRun: _dryRun };
  if (rtsCandidates.length === 0) {
    console.log('  no jobs newly ready-to-ship');
  }

  // AUDIT FIX (2026-06-11) — intake flip, inherited from the retired 15-min
  // legacy scheduler: a 'Ready to Schedule' job that received placements in
  // this plan flips to 'Scheduled' (lifecycle bookkeeping; the planner
  // already plans such jobs either way).
  const placedMpmIds = new Set((finalPlan.placements || []).map(p => String(p.masterPmId)));
  const intakeCandidates = (boards.jobs || []).filter(j =>
    j.status === 'Ready to Schedule' && placedMpmIds.has(String(j.masterPmId)));

  const flipStatus = async (j, label, why) => {
    if (_dryRun) {
      console.log(`  [DRY RUN] would set ${j.name} → ${label} (${why})`);
      return;
    }
    try {
      await _gqlFn(
        'mutation ($item: ID!, $board: ID!, $cv: JSON!) { change_multiple_column_values(item_id: $item, board_id: $board, column_values: $cv, create_labels_if_missing: true) { id } }',
        { item: String(j.id), board: BOARD_PROD_LOAD, cv: JSON.stringify({ [PL_STATUS_COL]: { label } }) });
      statusDerivation.flipped.push(`${j.name} → ${label}`);
      console.log(`  ✓ ${j.name} → ${label} (${why})`);
    } catch (e) {
      console.log(`  ✗ ${j.name} status flip failed: ${e.message} — re-runs next --plan`);
    }
  };
  for (const j of rtsCandidates) await flipStatus(j, 'Ready to Ship', 'all production stations complete');
  for (const j of intakeCandidates) await flipStatus(j, 'Scheduled', 'intake: placed in this plan');

  const _writeCapacityView   = deps.writeCapacityView;
  const _writeWeeklyBriefing = deps.writeWeeklyBriefing;
  const outputs = { acceptedTuples, statusDerivation, capacityView: null, weeklyBriefing: null };

  if (!_writeCapacityView && !_writeWeeklyBriefing) {
    console.log('\n=== OUTPUTS === skipped (no writers wired — CLI entry provides them)');
  } else {
    console.log('\n=== OUTPUTS ===');
    if (_dryRun) console.log('  DRY RUN MODE — writers will not fire mutations');
    const jobsById = {};
    for (const j of boards.jobs || []) jobsById[j.id] = j;
    const generatedAt = _now();
    // REVIEW FIX (2026-06-10): PTO rows derive from the plan's capacityGrid,
    // NOT boards.timeOff — the raw loadTimeOff shape has no crew/week fields
    // and renders nothing (see timeOffEntriesFromPlan docstring).
    const timeOffEntries = timeOffEntriesFromPlan(finalPlan);

    if (_writeCapacityView) {
      try {
        const cvMarkdown = buildCapacityViewDoc(finalPlan, jobsById, timeOffEntries, {
          generatedAt, acceptedOverrides: acceptedTuples,
        });
        const r = await _writeCapacityView(CAPACITY_VIEW_OBJECT_ID, cvMarkdown, { dryRun: _dryRun });
        outputs.capacityView = { ok: true, blocksRead: r.blocksRead, blocksDeleted: r.blocksDeleted, blockIdsAdded: (r.blockIdsAdded || []).length, dryRun: r.dryRun, savedMarkdownPath: r.savedMarkdownPath };
        console.log(`  ✓ Capacity View regenerated (${r.blocksDeleted}/${r.blocksRead} blocks replaced, ${(r.blockIdsAdded || []).length} added${r.dryRun ? ', dry-run' : ''})`);
      } catch (e) {
        outputs.capacityView = { ok: false, error: e.message || String(e) };
        console.log(`  ✗ Capacity View regeneration FAILED: ${e.message || e}`);
        console.log('    The writer saves logs/capacity-view-<date>.md before any mutation — if deletes already fired, recover from that artifact (or the capacity-view-refresh skill); a failure before the writer ran leaves the doc untouched. Re-run: `node scripts/write-capacity-view.js`.');
      }
    } else {
      console.log('  Capacity View writer not wired — skipped.');
    }

    if (_writeWeeklyBriefing) {
      try {
        const briefing = buildWeeklyBriefingDoc(finalPlan, jobsById, timeOffEntries, {
          generatedAt, acceptedOverrides: acceptedTuples,
        });
        const r = await _writeWeeklyBriefing({ title: briefing.title, markdown: briefing.markdown }, { dryRun: _dryRun });
        outputs.weeklyBriefing = { ok: true, weekISO: briefing.weekISO, created: !!r.created, renamed: !!r.renamed, wouldCreate: !!r.wouldCreate, blockIdsAdded: (r.blockIdsAdded || []).length, dryRun: r.dryRun, savedMarkdownPath: r.savedMarkdownPath };
        console.log(`  ✓ Weekly Briefing for week ${briefing.weekISO}${r.wouldCreate ? ' (would create doc — dry-run)' : r.created ? ' (doc created)' : ''}${r.dryRun ? ' (dry-run)' : ''}`);
      } catch (e) {
        outputs.weeklyBriefing = { ok: false, error: e.message || String(e) };
        console.log(`  ✗ Weekly Briefing regeneration FAILED: ${e.message || e}`);
        console.log('    Recovery artifact at logs/weekly-briefing-<date>.md; re-run `node scripts/write-weekly-briefing.js`.');
      }
    } else {
      console.log('  Weekly Briefing writer not wired — skipped.');
    }
  }

  return { baselinePlan, validation, finalPlan, planFile, validationFile, outputs, configLint };
}

module.exports = { runPlanner };

// ============================================================================
// CLI entry
// ============================================================================
if (require.main === module) {
  const args = process.argv.slice(2);
  const mode = args.includes('--execute') ? 'execute' : 'plan';
  // --force and --auto-create-parents propagate down to rebalance-schedule.js
  // automatically via process.argv (both flags are read at module load there).
  // Nothing to wire explicitly here.
  if (!process.env.MONDAY_API_TOKEN) {
    console.error('ERROR: MONDAY_API_TOKEN env var required');
    process.exit(1);
  }
  // C8: wire the real output writers here (and only here) — runPlanner
  // skips the outputs stage when these are absent, keeping unit tests
  // hermetic. See the outputs-stage docstring in runPlanner.
  const { replaceCapacityViewBody } = require('./write-capacity-view.js');
  const { writeWeeklyBriefing } = require('./write-weekly-briefing.js');
  runPlanner({
    mode,
    options: { force: args.includes('--force') },
    deps: {
      writeCapacityView: replaceCapacityViewBody,
      writeWeeklyBriefing,
    },
  }).then(result => {
    if (result && result.planError) process.exitCode = 1;
  }).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
