#!/usr/bin/env node
// P3.1 — planner trigger: poll + scheduled entry point for the Manual
// Overrides planner service (docs/phase-3-manual-overrides-plan.md).
//
// CLI (both wired into Task Scheduler via the repo-root .bats):
//   node scripts/planner-trigger.js --poll        every-minute task; runs
//                                                 only when the trigger item's
//                                                 Status is "Run Requested"
//   node scripts/planner-trigger.js --scheduled   Saturday 18:00 task; runs
//                                                 unconditionally
//
// Status lifecycle on the trigger item (⚙️ Control group, board 18413101550):
//   Run Requested → Running → Idle    clean run (conflicts included — those
//                                     are row outcomes, not run failures)
//                 → Running → Error   planError or unexpected throw
//
// A held lock skips WITHOUT touching status, so a pending request survives
// to the next tick instead of being silently eaten.
//
// Notifications (P3-D4): monday create_notification to Chris (77398023),
// target = the trigger item — fires on planError, any Conflict rows, or an
// output-writer failure. Silent on clean success. Every run additionally
// posts a summary update on the trigger item as the audit trail.

const fs = require('fs');
const path = require('path');

const TRIGGER_LABELS = Object.freeze({
  idle: 'Idle',
  requested: 'Run Requested',
  running: 'Running',
  error: 'Error',
});
const CHRIS_USER_ID = 77398023;
const LOCK_STALE_MS = 45 * 60 * 1000;   // a full run is ~2-4 min; 45 min = clearly dead
const DEFAULT_LOCK_FILE = path.join(__dirname, '..', 'logs', 'planner.lock');
const DEFAULT_CONFIG_FILE = path.join(__dirname, '..', 'config', 'planner-trigger.json');

function decideAction(statusText) {
  return statusText === TRIGGER_LABELS.requested ? 'run' : 'skip';
}

// Lockfile guard. Stale locks (older than staleMs) are stolen — covers a
// crashed run that never released. Belt-and-suspenders with the task XML's
// MultipleInstancesPolicy=IgnoreNew.
function acquireLock({ fsImpl = fs, lockFile = DEFAULT_LOCK_FILE, now = () => new Date(), staleMs = LOCK_STALE_MS, pid = process.pid } = {}) {
  if (fsImpl.existsSync(lockFile)) {
    let held = null;
    try { held = JSON.parse(fsImpl.readFileSync(lockFile, 'utf8')); } catch (e) { /* corrupt → steal */ }
    if (held && held.startedAt) {
      const age = now().getTime() - new Date(held.startedAt).getTime();
      if (age < staleMs) {
        return { ok: false, reason: `lock held by pid ${held.pid} since ${held.startedAt}` };
      }
    }
  }
  const dir = path.dirname(lockFile);
  if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.writeFileSync(lockFile, JSON.stringify({ pid, startedAt: now().toISOString() }));
  return { ok: true };
}

function releaseLock({ fsImpl = fs, lockFile = DEFAULT_LOCK_FILE } = {}) {
  try {
    if (fsImpl.existsSync(lockFile)) fsImpl.unlinkSync(lockFile);
  } catch (e) { /* best-effort */ }
}

function loadTriggerConfig({ fsImpl = fs, configFile = DEFAULT_CONFIG_FILE } = {}) {
  try {
    if (!fsImpl.existsSync(configFile)) return null;
    const parsed = JSON.parse(fsImpl.readFileSync(configFile, 'utf8'));
    if (!parsed || !parsed.itemId || !parsed.statusColumnId || !parsed.boardId) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

// Human-readable run summary for the trigger-item update (audit trail).
function buildRunSummary(result, { mode, startedAt, finishedAt } = {}) {
  const lines = [];
  const dur = startedAt && finishedAt ? ` in ${Math.round((finishedAt - startedAt) / 1000)}s` : '';
  lines.push(`Planner run (${mode || 'manual'})${dur} — ${finishedAt ? finishedAt.toISOString() : ''}`);

  const accepted = result?.validation?.accepted?.length || 0;
  const conflicts = result?.validation?.conflicts || [];
  lines.push(`Overrides: ${accepted} accepted, ${conflicts.length} conflict(s)`);
  for (const c of conflicts) {
    lines.push(`  ✗ row ${c.rowId}: ${c.reason}`);
  }

  if (result?.planError) {
    lines.push(`PLANNER ERROR — run aborted, previous good state preserved; outputs not regenerated:`);
    lines.push(`  ${result.planError}`);
    return lines.join('\n');
  }

  lines.push(`Plan: ${result?.finalPlan?.placements?.length || 0} placement(s)`);

  const cv = result?.outputs?.capacityView;
  if (cv) {
    lines.push(cv.ok
      ? `Capacity View: regenerated (${cv.blocksDeleted ?? '?'} blocks replaced, ${cv.blockIdsAdded ?? '?'} added)`
      : `Capacity View: FAILED — ${cv.error}`);
  }
  const wb = result?.outputs?.weeklyBriefing;
  if (wb) {
    lines.push(wb.ok
      ? `Weekly Briefing: week ${wb.weekISO}${wb.created ? ' (doc created)' : ''}`
      : `Weekly Briefing: FAILED — ${wb.error}`);
  }
  return lines.join('\n');
}

// Notify only when something needs a human: planner error, conflict rows,
// or an output writer failure. Clean success stays silent (spec).
function shouldNotify(result) {
  const reasons = [];
  if (result?.planError) reasons.push(`planner error: ${result.planError}`);
  const conflicts = result?.validation?.conflicts || [];
  if (conflicts.length > 0) reasons.push(`${conflicts.length} override conflict(s) need review`);
  if (result?.outputs?.capacityView && result.outputs.capacityView.ok === false) {
    reasons.push(`Capacity View regeneration failed: ${result.outputs.capacityView.error}`);
  }
  if (result?.outputs?.weeklyBriefing && result.outputs.weeklyBriefing.ok === false) {
    reasons.push(`Weekly Briefing regeneration failed: ${result.outputs.weeklyBriefing.error}`);
  }
  return { notify: reasons.length > 0, reasons };
}

async function setTriggerStatus(config, label, { gqlFn }) {
  const q = `mutation ($item: ID!, $board: ID!, $cv: JSON!) {
    change_multiple_column_values(item_id: $item, board_id: $board, column_values: $cv, create_labels_if_missing: true) { id }
  }`;
  await gqlFn(q, {
    item: String(config.itemId),
    board: String(config.boardId),
    cv: JSON.stringify({ [config.statusColumnId]: { label } }),
  });
}

async function postTriggerUpdate(config, body, { gqlFn }) {
  const q = 'mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }';
  await gqlFn(q, { item: String(config.itemId), body });
}

async function notifyChris(config, text, { gqlFn, userId = CHRIS_USER_ID }) {
  const q = `mutation ($userId: ID!, $targetId: ID!, $text: String!) {
    create_notification(user_id: $userId, target_id: $targetId, target_type: Project, text: $text) { text }
  }`;
  await gqlFn(q, { userId: String(userId), targetId: String(config.itemId), text });
}

// Orchestrator. mode: 'poll' (gated on Run Requested) | 'scheduled'
// (unconditional). All I/O injectable via deps.
async function runOnce({ mode = 'poll', deps = {} } = {}) {
  const _gqlFn   = deps.gqlFn;
  const _fsImpl  = deps.fsImpl || fs;
  const _lockFile = deps.lockFile || DEFAULT_LOCK_FILE;
  const _now     = deps.now || (() => new Date());
  const _logger  = deps.logger || console;
  const _runPlanner = deps.runPlannerFn;
  const _userId  = deps.notifyUserId || CHRIS_USER_ID;

  const config = deps.config || loadTriggerConfig({ fsImpl: _fsImpl, configFile: deps.configFile });
  if (!config) {
    throw new Error('planner-trigger: no trigger config — run `node scripts/setup-trigger-item.js` first (writes config/planner-trigger.json)');
  }

  // Read the trigger status (poll mode gates on it; scheduled mode reads it
  // anyway so a queued Run Requested is absorbed by this run rather than
  // re-firing on the next poll tick).
  const readQ = 'query ($item: [ID!]) { items(ids: $item) { column_values { id text } } }';
  const read = await _gqlFn(readQ, { item: [String(config.itemId)] });
  const statusText = (read?.items?.[0]?.column_values || []).find(c => c.id === config.statusColumnId)?.text || null;

  if (mode === 'poll' && decideAction(statusText) !== 'run') {
    return { ran: false, skipped: `status is ${JSON.stringify(statusText)} — nothing requested` };
  }

  const lock = acquireLock({ fsImpl: _fsImpl, lockFile: _lockFile, now: _now });
  if (!lock.ok) {
    _logger.log(`planner-trigger: skipping — ${lock.reason} (request preserved for next tick)`);
    return { ran: false, skipped: `locked: ${lock.reason}` };
  }

  const startedAt = _now();
  let result = null;
  let unexpectedError = null;
  try {
    await setTriggerStatus(config, TRIGGER_LABELS.running, { gqlFn: _gqlFn });
    try {
      result = await _runPlanner({ mode: 'plan' });
    } catch (e) {
      unexpectedError = e.message || String(e);
      result = { validation: { accepted: [], conflicts: [] }, planError: unexpectedError };
    }
    const finishedAt = _now();

    const failed = !!result.planError;
    await setTriggerStatus(config, failed ? TRIGGER_LABELS.error : TRIGGER_LABELS.idle, { gqlFn: _gqlFn });

    const summary = buildRunSummary(result, { mode, startedAt, finishedAt });
    try {
      await postTriggerUpdate(config, summary, { gqlFn: _gqlFn });
    } catch (e) {
      _logger.log(`planner-trigger: failed to post run-summary update: ${e.message}`);
    }

    const n = shouldNotify(result);
    if (n.notify) {
      try {
        await notifyChris(config, `HTW Planner (${mode}): ${n.reasons.join(' • ')}`, { gqlFn: _gqlFn, userId: _userId });
      } catch (e) {
        _logger.log(`planner-trigger: failed to send notification: ${e.message}`);
      }
    }

    _logger.log(summary);
    return {
      ran: true,
      ...(result.planError ? { planError: result.planError } : {}),
      ...(unexpectedError ? { error: unexpectedError } : {}),
      notified: n.notify,
    };
  } finally {
    releaseLock({ fsImpl: _fsImpl, lockFile: _lockFile });
  }
}

module.exports = {
  TRIGGER_LABELS,
  CHRIS_USER_ID,
  LOCK_STALE_MS,
  decideAction,
  acquireLock,
  releaseLock,
  loadTriggerConfig,
  buildRunSummary,
  shouldNotify,
  runOnce,
};

// ============================================================================
// CLI entry — wires the real planner + writers + gql (hermetic-by-default
// pattern: tests inject everything, the CLI provides production deps).
// ============================================================================
if (require.main === module) {
  const args = process.argv.slice(2);
  const mode = args.includes('--scheduled') ? 'scheduled' : 'poll';
  if (!process.env.MONDAY_API_TOKEN) {
    console.error('ERROR: MONDAY_API_TOKEN env var required');
    process.exit(1);
  }
  const reb = require('./rebalance-schedule.js');
  const { runPlanner } = require('./run-planner.js');
  const { replaceCapacityViewBody } = require('./write-capacity-view.js');
  const { writeWeeklyBriefing } = require('./write-weekly-briefing.js');

  runOnce({
    mode,
    deps: {
      gqlFn: reb.gql,
      runPlannerFn: (opts) => runPlanner({
        ...opts,
        deps: {
          writeCapacityView: replaceCapacityViewBody,
          writeWeeklyBriefing,
        },
      }),
    },
  }).then(r => {
    if (r.planError || r.error) process.exitCode = 1;
    if (!r.ran) console.log(`planner-trigger (${mode}): ${r.skipped}`);
  }).catch(e => {
    console.error('planner-trigger fatal:', e);
    process.exit(1);
  });
}
