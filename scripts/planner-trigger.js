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
  deploy: 'Deploy Requested',
  running: 'Running',
  error: 'Error',
});
const CHRIS_USER_ID = 77398023;
const LOCK_STALE_MS = 45 * 60 * 1000;   // a full run is ~2-4 min; 45 min = clearly dead
const DEFAULT_LOCK_FILE = path.join(__dirname, '..', 'logs', 'planner.lock');
const DEFAULT_CONFIG_FILE = path.join(__dirname, '..', 'config', 'planner-trigger.json');

function decideAction(statusText) {
  if (statusText === TRIGGER_LABELS.requested) return 'run';
  // DEPLOY (2026-06-11, per Chris): Bob can deploy — plan + execute in one
  // pass. The execute leg reuses every safety layer: the plan is fresh by
  // construction (just produced), the finishing-cycle gate still blocks
  // invalid cycles, and the delete-guard limits the blast radius.
  if (statusText === TRIGGER_LABELS.deploy) return 'deploy';
  return 'skip';
}

// Lockfile guard. REVIEW FIX (2026-06-11): the original check-then-write was
// a TOCTOU — the every-minute poll task and the Saturday task are SEPARATE
// scheduled tasks (IgnoreNew doesn't cross-serialize them) and fire within
// milliseconds at Sat 18:00; both could pass existsSync and double-run the
// planner (concurrent Capacity View delete/add passes). Acquisition is now
// an ATOMIC exclusive create ({ flag: 'wx' }); stale locks (older than
// staleMs — a crashed run that never released) are stolen via unlink +
// retry-wx. Each acquire carries an ownership token so releaseLock can never
// delete a lock a stealer now owns.
function tryExclusiveCreate(fsImpl, lockFile, payload) {
  try {
    fsImpl.writeFileSync(lockFile, payload, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    throw e;
  }
}

function readLockState({ fsImpl = fs, lockFile = DEFAULT_LOCK_FILE, now = () => new Date(), staleMs = LOCK_STALE_MS } = {}) {
  // Read-based, not existsSync-based: between an EEXIST and this read the
  // holder may release, and an existsSync answer can be stale by the time
  // it's used. A failed read (ENOENT or otherwise) = no lock to honor.
  let raw = null;
  try { raw = fsImpl.readFileSync(lockFile, 'utf8'); } catch (e) { return { state: 'absent', held: null }; }
  let held = null;
  try { held = JSON.parse(raw); } catch (e) { /* corrupt */ }
  if (!held || !held.startedAt) return { state: 'stale', held };
  const age = now().getTime() - new Date(held.startedAt).getTime();
  return { state: age < staleMs ? 'fresh' : 'stale', held };
}

function acquireLock({ fsImpl = fs, lockFile = DEFAULT_LOCK_FILE, now = () => new Date(), staleMs = LOCK_STALE_MS, pid = process.pid } = {}) {
  const token = `${pid}-${now().getTime()}-${Math.random().toString(36).slice(2, 10)}`;
  const payload = JSON.stringify({ pid, token, startedAt: now().toISOString() });
  const dir = path.dirname(lockFile);
  if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });

  if (tryExclusiveCreate(fsImpl, lockFile, payload)) return { ok: true, token };

  const { state, held } = readLockState({ fsImpl, lockFile, now, staleMs });
  if (state === 'fresh') {
    return { ok: false, reason: `lock held by pid ${held.pid} since ${held.startedAt}` };
  }
  // Stale or corrupt → steal: remove and retry the exclusive create ONCE.
  // Losing the retry means another process stole it in the same window.
  try { fsImpl.unlinkSync(lockFile); } catch (e) { /* already gone */ }
  if (tryExclusiveCreate(fsImpl, lockFile, payload)) return { ok: true, token };
  return { ok: false, reason: 'lost the stale-steal race to another process' };
}

function releaseLock({ fsImpl = fs, lockFile = DEFAULT_LOCK_FILE, token = null } = {}) {
  try {
    if (!fsImpl.existsSync(lockFile)) return;
    if (token) {
      let held = null;
      try { held = JSON.parse(fsImpl.readFileSync(lockFile, 'utf8')); } catch (e) { /* corrupt → safe to remove */ }
      if (held && held.token && held.token !== token) return;   // not ours anymore (stolen)
    }
    fsImpl.unlinkSync(lockFile);
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
function buildRunSummary(result, { mode, startedAt, finishedAt, deploy } = {}) {
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
    // REVIEW FIX — only the structured planError path (run-planner's pass-2
    // guard) verified that the previous state was preserved. An unexpected
    // throw could have died anywhere; don't assert what we can't verify.
    if (result.unexpectedError) {
      lines.push(`PLANNER RUN FAILED (unexpected error) — outputs not regenerated; check logs/planner-<date>.log. Override-row statuses may be partially written:`);
    } else {
      lines.push(`PLANNER ERROR — run aborted, previous good state preserved; outputs not regenerated:`);
    }
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
  if (deploy) {
    lines.push(`DEPLOYED to Crew Allocation: ${deploy.deleted} deleted / ${deploy.created} created subitems`
      + (deploy.subSkipped ? ` (${deploy.subSkipped} sub placements ops-only)` : '')
      + `; finish dates ${deploy.finishWrites?.ok ?? 0} ok${deploy.finishWrites?.fail ? `, ${deploy.finishWrites.fail} FAILED` : ''}`);
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
  // AUDIT FIX (2026-06-11): config-lint errors are silent no-ops waiting to
  // bite a rebalance — they warrant a human.
  if (result?.configLint?.errors?.length) {
    reasons.push(`${result.configLint.errors.length} config error(s) in rebalance-overrides.json (silent no-op shapes — see the run log)`);
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

// ---------------------------------------------------------------------------
// Quote handling (Lead Time Calculator V2 — spec §4.3/§4.4)
// ---------------------------------------------------------------------------
const QUOTE_LABELS = { requested: 'Quote Requested', quoting: 'Quoting', quoted: 'Quoted', error: 'Quote Error' };
// Quotes run 15-45 s; the 45-min planner staleness would wedge crashed quotes
// (spec §4.3). 5 min ≈ 10× worst-case quote duration.
const QUOTE_LOCK_STALE_MS = 5 * 60 * 1000;
const DEFAULT_QUOTE_LOCK_FILE = path.join(__dirname, '..', 'logs', 'quote.lock');

// One request per tick carrying BOTH the trigger status and the Quotes group
// (spec §4.3: "combined single-request query"). Falls back to the original
// single-item read until setup-quotes-group.js has written quotesGroupId.
async function readTickState({ config, gqlFn }) {
  if (!config.quotesGroupId) {
    const readQ = 'query ($item: [ID!]) { items(ids: $item) { column_values { id text } } }';
    const read = await gqlFn(readQ, { item: [String(config.itemId)] });
    const statusText = (read?.items?.[0]?.column_values || []).find(c => c.id === config.statusColumnId)?.text || null;
    return { statusText, quoteRows: [] };
  }
  const q = `query ($item: [ID!], $board: [ID!], $group: [String!]) {
    items(ids: $item) { column_values { id text } }
    boards(ids: $board) { groups(ids: $group) { items_page(limit: 50) { items { id name column_values { id text } } } } }
  }`;
  const read = await gqlFn(q, { item: [String(config.itemId)], board: [String(config.boardId)], group: [String(config.quotesGroupId)] });
  const statusText = (read?.items?.[0]?.column_values || []).find(c => c.id === config.statusColumnId)?.text || null;
  const items = read?.boards?.[0]?.groups?.[0]?.items_page?.items || [];
  return { statusText, quoteRows: parseQuoteRows(items, config) };
}

function parseQuoteRows(items, config) {
  const col = (item, id) => (item.column_values || []).find(c => c.id === id)?.text ?? '';
  const c = config.quoteColumns || {};
  return items.map(item => ({
    rowId: String(item.id),
    name: item.name,
    jobType: col(item, c.jobType),
    boxes: col(item, c.boxes),
    complexity: col(item, c.complexity),
    targetDate: col(item, c.targetDate) || null,
    quoteStatus: col(item, c.status),
  }));
}

async function setQuoteStatus(config, rowId, label, { gqlFn }) {
  await gqlFn(
    'mutation ($item: ID!, $board: ID!, $cv: JSON!) { change_multiple_column_values(item_id: $item, board_id: $board, column_values: $cv, create_labels_if_missing: true) { id } }',
    { item: String(rowId), board: String(config.boardId),
      cv: JSON.stringify({ [config.quoteColumns.status]: { label } }) });
}

async function writeQuoteResult(config, rowId, result, { gqlFn }) {
  const cv = {
    [config.quoteColumns.status]: { label: QUOTE_LABELS.quoted },
    [config.quoteColumns.quotedWeek]: { date: result.quotedWeek },
    [config.quoteColumns.capacityWeek]: { date: result.capacityWeek },
  };
  await gqlFn(
    'mutation ($item: ID!, $board: ID!, $cv: JSON!) { change_multiple_column_values(item_id: $item, board_id: $board, column_values: $cv, create_labels_if_missing: true) { id } }',
    { item: String(rowId), board: String(config.boardId), cv: JSON.stringify(cv) });
  const { buildQuoteUpdate } = require('./quote-engine.js');
  await gqlFn('mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }',
    { item: String(rowId), body: buildQuoteUpdate(result) });
}

async function postQuoteError(config, rowId, reason, { gqlFn }) {
  try { await setQuoteStatus(config, rowId, QUOTE_LABELS.error, { gqlFn }); } catch (e) { /* self-heal corrects later */ }
  try {
    await gqlFn('mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }',
      { item: String(rowId), body: `Quote failed: ${reason}` });
  } catch (e) { /* best-effort */ }
}

// Quote tick (spec §4.3): own lock (never planner.lock), 3-per-tick cap,
// self-heal for stuck Quoting rows, defer entirely while a planner run/deploy
// holds planner.lock, DRY_RUN prints instead of writing.
const MAX_QUOTES_PER_TICK = 3;
async function processQuotes({ rows = [], deps = {} } = {}) {
  const _gqlFn = deps.gqlFn;
  const _fsImpl = deps.fsImpl || fs;
  const _now = deps.now || (() => new Date());
  const _logger = deps.logger || console;
  const _loadAll = deps.loadAllFn || (() => require('./rebalance-schedule.js').loadAll({}));
  const _runQuote = deps.runQuoteFn || require('./quote-engine.js').runQuote;
  const _userId = deps.notifyUserId || CHRIS_USER_ID;
  const _plannerLock = deps.lockFile || DEFAULT_LOCK_FILE;
  const _quoteLock = deps.quoteLockFile || DEFAULT_QUOTE_LOCK_FILE;
  const _dryRun = process.env.DRY_RUN === '1';
  const config = deps.config;
  if (!config?.quotesGroupId || !config?.quoteColumns) return { processed: 0, skipped: 'quotes not set up' };

  const out = { processed: 0, healed: 0, deferred: 0, errors: 0, remaining: 0 };

  // Self-heal: Quoting + no live quote lock ⇒ that quote died mid-flight.
  const lockState = readLockState({ fsImpl: _fsImpl, lockFile: _quoteLock, now: _now, staleMs: QUOTE_LOCK_STALE_MS });
  for (const row of rows.filter(r => r.quoteStatus === QUOTE_LABELS.quoting)) {
    if (lockState.state !== 'fresh') {
      if (_dryRun) { _logger.log(`  [DRY RUN] would heal stuck-Quoting row ${row.rowId} → Quote Error`); continue; }
      try { await setQuoteStatus(config, row.rowId, QUOTE_LABELS.error, { gqlFn: _gqlFn }); } catch (e) { _logger.log(`quote self-heal flip failed: ${e.message}`); }
      try {
        await _gqlFn('mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }',
          { item: String(row.rowId), body: 'This quote died mid-flight (machine sleep, crash, or kill while Quoting). Flip Quote Status back to Quote Requested to retry.' });
      } catch (e) { /* best-effort */ }
      out.healed++;
    }
  }

  const requested = rows.filter(r => r.quoteStatus === QUOTE_LABELS.requested)
    .sort((a, b) => a.rowId.localeCompare(b.rowId, undefined, { numeric: true }));
  if (requested.length === 0) return out;

  // Quotes against mid-rewrite boards lie — defer the whole batch one tick.
  const plannerState = readLockState({ fsImpl: _fsImpl, lockFile: _plannerLock, now: _now });
  if (plannerState.state === 'fresh') {
    out.deferred = requested.length;
    _logger.log(`planner-trigger: ${requested.length} quote(s) deferred — planner run/deploy in flight`);
    return out;
  }

  const lock = acquireLock({ fsImpl: _fsImpl, lockFile: _quoteLock, now: _now, staleMs: QUOTE_LOCK_STALE_MS });
  if (!lock.ok) {
    out.deferred = requested.length;
    _logger.log(`planner-trigger: quotes deferred — ${lock.reason}`);
    return out;
  }
  try {
    const batch = requested.slice(0, MAX_QUOTES_PER_TICK);
    out.remaining = requested.length - batch.length;
    const { loadQuotePolicy } = require('./quote-engine.js');
    const { validateQuoteInput } = require('./quote-engine.js');

    let policy;
    try {
      policy = deps.policy || loadQuotePolicy();
    } catch (e) {
      // config lint failure: loud + notify, rows untouched (retry next tick after fix)
      _logger.log(`quote-policy lint FAILED: ${e.message}`);
      if (!_dryRun) {
        try { await notifyChris(config, `HTW Quotes: quote-policy.json failed lint — ${e.message}`, { gqlFn: _gqlFn, userId: _userId }); } catch (e2) { /* */ }
      }
      out.errors = requested.length;
      return out;
    }

    for (const row of batch) {
      const v = validateQuoteInput(row, policy);
      if (!v.ok) {
        if (_dryRun) { _logger.log(`  [DRY RUN] would flip row ${row.rowId} → Quote Error (${v.reason})`); }
        else { await postQuoteError(config, row.rowId, v.reason, { gqlFn: _gqlFn }); }
        out.processed++;
        continue;
      }
      try {
        if (_dryRun) { _logger.log(`  [DRY RUN] would flip row ${row.rowId} → Quoting`); }
        else { try { await setQuoteStatus(config, row.rowId, QUOTE_LABELS.quoting, { gqlFn: _gqlFn }); } catch (e) { _logger.log(`Quoting claim failed (${e.message}) — proceeding under lock`); } }

        const boards = await _loadAll();

        // Torn-read guard (spec §4.3): a run/deploy that started mid-fetch may
        // have half-rewritten the boards we just read.
        const recheck = readLockState({ fsImpl: _fsImpl, lockFile: _plannerLock, now: _now });
        if (recheck.state === 'fresh') {
          if (_dryRun) { _logger.log(`  [DRY RUN] torn-read defer for row ${row.rowId}`); }
          else { try { await setQuoteStatus(config, row.rowId, QUOTE_LABELS.requested, { gqlFn: _gqlFn }); } catch (e) { /* */ } }
          out.deferred++;
          continue;
        }

        const result = await _runQuote(row, { boards, policy, now: _now });
        if (!result.ok) {
          if (_dryRun) { _logger.log(`  [DRY RUN] would flip row ${row.rowId} → Quote Error (${result.reason})`); }
          else { await postQuoteError(config, row.rowId, result.reason, { gqlFn: _gqlFn }); }
          out.processed++;
          continue;
        }
        if (_dryRun) {
          _logger.log(`  [DRY RUN] would write row ${row.rowId} → Quoted (quoted ${result.quotedWeek}, capacity ${result.capacityWeek})`);
        } else {
          await writeQuoteResult(config, row.rowId, result, { gqlFn: _gqlFn });
        }
        out.processed++;
      } catch (e) {
        out.errors++;
        out.processed++;
        const msg = e.message || String(e);
        if (_dryRun) { _logger.log(`  [DRY RUN] would flip row ${row.rowId} → Quote Error + notify (${msg})`); }
        else {
          await postQuoteError(config, row.rowId, msg, { gqlFn: _gqlFn });
          try { await notifyChris(config, `HTW Quotes: quote on row ${row.rowId} failed — ${msg}`, { gqlFn: _gqlFn, userId: _userId }); } catch (e2) { _logger.log(`quote failure notification failed: ${e2.message}`); }
        }
      }
    }
    return out;
  } finally {
    releaseLock({ fsImpl: _fsImpl, lockFile: _quoteLock, token: lock.token });
  }
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

  const _dryRun = process.env.DRY_RUN === '1';

  const config = deps.config || loadTriggerConfig({ fsImpl: _fsImpl, configFile: deps.configFile });
  if (!config) {
    throw new Error('planner-trigger: no trigger config — run `node scripts/setup-trigger-item.js` first (writes config/planner-trigger.json)');
  }

  // Read the trigger status. Poll mode gates on it; scheduled mode reads it
  // only opportunistically and MUST survive a transient read failure — the
  // weekly run shouldn't die for a 502 on a read it doesn't gate on
  // (REVIEW FIX).
  let statusText = null;
  try {
    if (deps.tickState) {
      statusText = deps.tickState.statusText;
    } else {
      const state = await readTickState({ config, gqlFn: _gqlFn });
      statusText = state.statusText;
    }
  } catch (e) {
    // AUDIT FIX (2026-06-11): token death previously looked identical to
    // healthy idle. Auth-shaped errors get a distinct flag so the CLI logs
    // loudly every tick until the token is rotated (monday notifications
    // can't help — they need the very token that died).
    const isAuth = /not authenticated|unauthorized|invalid token|401/i.test(e.message || '');
    if (mode === 'poll') {
      return {
        ran: false,
        ...(isAuth ? { authFailure: true } : {}),
        skipped: `status read failed (${e.message}) — ${isAuth ? 'TOKEN AUTH FAILURE' : 'next tick retries'}`,
      };
    }
    _logger.log(`planner-trigger: status read failed (${e.message}) — scheduled run proceeding anyway${isAuth ? ' (LOOKS LIKE TOKEN AUTH FAILURE — rotate .token)' : ''}`);
  }

  const action = mode === 'scheduled' ? 'run' : decideAction(statusText);
  if (mode === 'poll' && action === 'skip') {
    // REVIEW FIX — stuck-Running self-heal: a run killed mid-flight (logoff,
    // reboot, battery-stop) leaves status=Running with no live lock; poll
    // only acts on Run Requested, so without this the board lies until the
    // Saturday run. Running + absent/stale lock ⇒ the run died: surface it.
    if (statusText === TRIGGER_LABELS.running) {
      const { state } = readLockState({ fsImpl: _fsImpl, lockFile: _lockFile, now: _now });
      if (state !== 'fresh') {
        try { await setTriggerStatus(config, TRIGGER_LABELS.error, { gqlFn: _gqlFn }); } catch (e) { _logger.log(`recovery status flip failed: ${e.message}`); }
        const msg = 'Previous planner run died mid-flight (status was Running with no live lock — machine sleep, logoff, or crash). Status flipped to Error. Re-request a run when ready; the previous docs/plan remain whatever the last completed run wrote.';
        try { await postTriggerUpdate(config, msg, { gqlFn: _gqlFn }); } catch (e) { /* best-effort */ }
        try { await notifyChris(config, `HTW Planner: a run died mid-flight and was marked Error — re-request when ready.`, { gqlFn: _gqlFn, userId: _userId }); } catch (e) { /* best-effort */ }
        _logger.log(msg);
        return { ran: false, recovered: true };
      }
    }
    return { ran: false, skipped: `status is ${JSON.stringify(statusText)} — nothing requested` };
  }

  const lock = acquireLock({ fsImpl: _fsImpl, lockFile: _lockFile, now: _now });
  if (!lock.ok) {
    _logger.log(`planner-trigger: skipping — ${lock.reason} (request preserved for next tick)`);
    // REVIEW FIX — a skipped SCHEDULED run is a lost weekly backbone run;
    // unlike a poll tick it won't retry in a minute. Tell Chris.
    if (mode === 'scheduled') {
      try {
        await notifyChris(config, `HTW Planner: Saturday scheduled run was skipped — ${lock.reason}. If no run is genuinely in flight, re-request via the Planner Trigger.`, { gqlFn: _gqlFn, userId: _userId });
      } catch (e) { _logger.log(`skip notification failed: ${e.message}`); }
    }
    return { ran: false, skipped: `locked: ${lock.reason}` };
  }

  const startedAt = _now();
  let result = null;
  let unexpectedError = null;
  try {
    // The Running claim is operator UX, not the concurrency guard (the lock
    // is) — a transient failure here must not kill the run (REVIEW FIX).
    try {
      await setTriggerStatus(config, TRIGGER_LABELS.running, { gqlFn: _gqlFn });
    } catch (e) {
      _logger.log(`planner-trigger: Running claim failed (${e.message}) — proceeding under lock`);
    }
    try {
      result = await _runPlanner({ mode: 'plan' });
    } catch (e) {
      unexpectedError = e.message || String(e);
      result = { validation: { accepted: [], conflicts: [] }, planError: unexpectedError, unexpectedError: true };
    }

    // DEPLOY: after a clean plan, run --execute in-process. The execute leg
    // loads the plan file just written (fresh — passes the age guard) and
    // goes through the finishing-cycle gate + delete-guard. Any throw lands
    // in planError so the Error/notify path below handles it.
    let deploy = null;
    if (action === 'deploy' && !result.planError) {
      if (_dryRun) {
        _logger.log('  [DRY RUN] would deploy (plan + execute) — execute skipped');
      } else {
        try {
          const ex = await _runPlanner({ mode: 'execute' });
          deploy = (ex && ex.executed) || { deleted: '?', created: '?', subSkipped: 0, finishWrites: { ok: 0, fail: 0 } };
        } catch (e) {
          result.planError = `deploy failed during execute: ${e.message || e}`;
        }
      }
    }
    const finishedAt = _now();

    // REVIEW FIX — the post-run flip was the only unguarded monday write: a
    // failure here (likely right after a mutation-heavy run) stranded status
    // at Running AND swallowed the summary + notification below.
    const failed = !!result.planError;
    try {
      await setTriggerStatus(config, failed ? TRIGGER_LABELS.error : TRIGGER_LABELS.idle, { gqlFn: _gqlFn });
    } catch (e) {
      _logger.log(`planner-trigger: post-run status flip failed (${e.message}) — the stuck-Running self-heal will correct it on a later tick`);
    }

    const summary = buildRunSummary(result, { mode, startedAt, finishedAt, deploy });
    try {
      await postTriggerUpdate(config, summary, { gqlFn: _gqlFn });
    } catch (e) {
      _logger.log(`planner-trigger: failed to post run-summary update: ${e.message}`);
    }

    const n = shouldNotify(result);
    // A deploy rewrites the Crew Allocation board — Chris hears about it
    // even on success (tunable later if it gets noisy).
    if (deploy) {
      n.notify = true;
      n.reasons.unshift(`deploy completed via trigger: ${deploy.deleted} deleted / ${deploy.created} created subitems`);
    }
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
      ...(deploy ? { deployed: true } : {}),
      ...(result.planError ? { planError: result.planError } : {}),
      ...(unexpectedError ? { error: unexpectedError } : {}),
      notified: n.notify,
    };
  } finally {
    releaseLock({ fsImpl: _fsImpl, lockFile: _lockFile, token: lock.token });
  }
}

module.exports = {
  TRIGGER_LABELS,
  CHRIS_USER_ID,
  LOCK_STALE_MS,
  decideAction,
  acquireLock,
  releaseLock,
  readLockState,
  loadTriggerConfig,
  buildRunSummary,
  shouldNotify,
  runOnce,
  // Quote handling (Lead Time Calculator V2)
  QUOTE_LABELS,
  QUOTE_LOCK_STALE_MS,
  DEFAULT_QUOTE_LOCK_FILE,
  readTickState,
  parseQuoteRows,
  processQuotes,
  MAX_QUOTES_PER_TICK,
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
  // Lazy-require the planner stack only when a run actually fires: the
  // every-minute idle tick then loads nothing heavyweight and logs NOTHING
  // (rebalance-schedule.js prints "Loaded overrides from..." at require
  // time — at 1440 ticks/day that's pure log pollution). defaultGql from
  // the writer module is side-effect-free at require.
  const { defaultGql } = require('./write-capacity-view.js');

  const deps = {
    gqlFn: defaultGql,
    runPlannerFn: (opts) => {
      const { runPlanner } = require('./run-planner.js');
      const { replaceCapacityViewBody } = require('./write-capacity-view.js');
      const { writeWeeklyBriefing } = require('./write-weekly-briefing.js');
      return runPlanner({
        ...opts,
        deps: {
          writeCapacityView: replaceCapacityViewBody,
          writeWeeklyBriefing,
        },
      });
    },
  };

  (async () => {
    if (mode === 'poll') {
      // Combined tick: one request carries both trigger status + quote rows
      // (avoids a second API call on every idle tick). A readTickState throw
      // is handled exactly like the old status-read failure: runOnce receives
      // no tickState and re-reads internally, where the poll catch path applies.
      const config = loadTriggerConfig({});
      let state = null;
      try {
        state = config ? await readTickState({ config, gqlFn: deps.gqlFn }) : null;
      } catch (e) {
        // Pass through — runOnce will re-read and handle the error (auth flag,
        // quiet skip) via its own catch block, matching old behavior.
      }
      const r = await runOnce({ mode: 'poll', deps: { ...deps, ...(state ? { tickState: state, config } : {}) } });
      if (r.planError || r.error) process.exitCode = 1;
      if (r.authFailure) {
        console.error(`planner-trigger (poll): TOKEN AUTH FAILURE — monday rejected the token in C:\\Users\\chris\\Harris-Tools\\.token. The planner is BLIND until it is replaced.`);
        process.exitCode = 2;
        return;
      }
      if (!r.ran && process.env.VERBOSE === '1') {
        console.log(`planner-trigger (poll): ${r.skipped}`);
      }
      if (state && config?.quotesGroupId) {
        const qr = await processQuotes({ rows: state.quoteRows, deps: { ...deps, config } });
        // Idle-tick silence: only log when something actually happened.
        if (qr.processed || qr.healed || qr.deferred) {
          console.log(`quotes: ${qr.processed} processed, ${qr.healed} healed, ${qr.deferred} deferred, ${qr.remaining} remaining`);
        }
      }
    } else {
      // Scheduled mode — unchanged: unconditional run, no quote processing.
      const r = await runOnce({ mode: 'scheduled', deps });
      if (r.planError || r.error) process.exitCode = 1;
      if (r.authFailure) {
        console.error(`planner-trigger (scheduled): TOKEN AUTH FAILURE — monday rejected the token in C:\\Users\\chris\\Harris-Tools\\.token. The planner is BLIND until it is replaced.`);
        process.exitCode = 2;
        return;
      }
      if (!r.ran) {
        console.log(`planner-trigger (scheduled): ${r.skipped}`);
      }
    }
  })().catch(e => {
    // Transient network loss (machine waking, wifi down) hits the status
    // read first. A poll tick has nothing to do offline — one short line,
    // not a stack trace per minute for the outage's duration. The next
    // tick self-heals. Scheduled runs keep the full trace (a missed
    // Saturday run should be loudly visible in the log).
    const cause = e && (e.cause || e);
    const isNetwork = /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(
      `${e && e.message} ${cause && cause.code} ${cause && cause.message}`);
    if (mode === 'poll' && isNetwork) {
      console.log(`planner-trigger (poll): network unavailable — skipping tick (${(cause && cause.code) || 'fetch failed'})`);
      process.exit(1);
    }
    console.error('planner-trigger fatal:', e);
    process.exit(1);
  });
}
