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
  const _findLatest    = deps.findLatestPlanFile || reb.findLatestPlanFile;
  const _fs            = deps.fs            || fs;
  const _logsDir       = deps.logsDir       || path.join(__dirname, '..', 'logs');
  const _now           = deps.now           || (() => new Date());

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

  const pending = (boards.overrideRows || []).filter(r => r.status === 'Pending');
  console.log(`\n--- Validating ${pending.length} Pending override row(s) against baseline ---`);
  const validation = _validateAll(pending, baselinePlan, boards.jobs, boards.crewParents);

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

  return { baselinePlan, validation, finalPlan, planFile, validationFile };
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
  runPlanner({ mode }).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
