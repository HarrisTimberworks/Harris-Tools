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
    await _runExecute(planObj, boards);
    return { plan: planObj };
  }

  // --plan mode: two-pass driver.

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
  const finalPlan = await _runPlan(finalBoards);

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
  const _writeCapacityView   = deps.writeCapacityView;
  const _writeWeeklyBriefing = deps.writeWeeklyBriefing;
  const outputs = { acceptedTuples, capacityView: null, weeklyBriefing: null };

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

  return { baselinePlan, validation, finalPlan, planFile, validationFile, outputs };
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
    deps: {
      writeCapacityView: replaceCapacityViewBody,
      writeWeeklyBriefing,
    },
  }).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
