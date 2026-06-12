#!/usr/bin/env node
/**
 * P3.1 — planner-trigger.js poll/run/notify logic.
 *
 * One module, two entry modes (docs/phase-3-manual-overrides-plan.md):
 *   --poll      gated on the trigger item's Status = "Run Requested"
 *   --scheduled runs unconditionally (Saturday 18:00 task)
 *
 * Contract under test:
 *   decideAction(statusText)            → 'run' | 'skip'
 *   acquireLock/releaseLock             → logs/planner.lock, stale-steal at 45 min
 *   buildRunSummary(result, meta)       → human-readable update body
 *   shouldNotify(result)                → { notify, reasons[] } (silent on clean success)
 *   runOnce({ mode, deps })             → orchestrator; all I/O injected
 *
 * Status lifecycle owned by runOnce: Run Requested → Running → Idle (clean)
 * or Error (planError / unexpected throw). A held lock skips WITHOUT touching
 * status, so the request survives to the next poll tick.
 */

const {
  TRIGGER_LABELS,
  CHRIS_USER_ID,
  decideAction,
  acquireLock,
  releaseLock,
  buildRunSummary,
  shouldNotify,
  loadTriggerConfig,
  runOnce,
} = require('./planner-trigger.js');

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
// Stubs
// ---------------------------------------------------------------------------

function makeFakeFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    fs: {
      existsSync: (p) => files.has(String(p)),
      mkdirSync: () => {},
      readFileSync: (p) => {
        if (!files.has(String(p))) throw new Error(`fake fs: no such file ${p}`);
        return files.get(String(p));
      },
      // Emulates the real fs's exclusive-create semantics: { flag: 'wx' }
      // throws EEXIST when the file already exists. The lock relies on this
      // for atomicity (REVIEW FIX: TOCTOU), so the fake must honor it.
      writeFileSync: (p, c, opts) => {
        if (opts && opts.flag === 'wx' && files.has(String(p))) {
          const e = new Error(`EEXIST: file already exists, open '${p}'`);
          e.code = 'EEXIST';
          throw e;
        }
        files.set(String(p), c);
      },
      unlinkSync: (p) => { files.delete(String(p)); },
    },
  };
}

const CONFIG = { boardId: '18413101550', itemId: '99100', statusColumnId: 'color_mm3aqx5g' };

// gql stub routed on query text. `status` controls the trigger read.
function makeFakeGql({ status = 'Idle' } = {}) {
  const calls = [];
  const fn = async (query, variables) => {
    calls.push({ query, variables });
    if (/change_multiple_column_values/.test(query)) return { change_multiple_column_values: { id: CONFIG.itemId } };
    if (/create_update/.test(query)) return { create_update: { id: 'u1' } };
    if (/create_notification/.test(query)) return { create_notification: { text: 'ok' } };
    if (/items\s*\(/.test(query)) return { items: [{ column_values: [{ id: CONFIG.statusColumnId, text: status }] }] };
    throw new Error(`fake gql: unrouted query: ${query.slice(0, 80)}`);
  };
  fn.calls = calls;
  fn.kinds = () => calls.map(c =>
    /change_multiple/.test(c.query) ? 'setStatus'
    : /create_update/.test(c.query) ? 'update'
    : /create_notification/.test(c.query) ? 'notify'
    : 'readStatus');
  fn.statusLabels = () => calls.filter(c => /change_multiple/.test(c.query))
    .map(c => JSON.parse(c.variables.cv)[CONFIG.statusColumnId].label);
  return fn;
}

function cleanResult() {
  return {
    validation: { accepted: [{ rowId: 'R1' }], conflicts: [], acceptedTuples: [] },
    finalPlan: { placements: [{}, {}, {}] },
    outputs: {
      acceptedTuples: [],
      capacityView: { ok: true, blocksDeleted: 66, blockIdsAdded: 306 },
      weeklyBriefing: { ok: true, weekISO: '2026-06-15', created: false, renamed: true },
    },
  };
}

const silentLogger = { log: () => {} };
const NOW = () => new Date('2026-06-13T18:00:00Z');

function baseDeps(gql, fakeFs, runPlannerFn) {
  return {
    gqlFn: gql,
    fsImpl: fakeFs.fs,
    lockFile: '/fake/logs/planner.lock',
    config: CONFIG,
    runPlannerFn: runPlannerFn || (async () => cleanResult()),
    now: NOW,
    logger: silentLogger,
  };
}

(async () => {

  console.log('Test 1: exports + constants');
  {
    check('runOnce is a function', typeof runOnce === 'function', `typeof=${typeof runOnce}`);
    check('labels frozen set', TRIGGER_LABELS.requested === 'Run Requested' && TRIGGER_LABELS.idle === 'Idle'
      && TRIGGER_LABELS.running === 'Running' && TRIGGER_LABELS.error === 'Error', JSON.stringify(TRIGGER_LABELS));
    check('Chris user id pinned', String(CHRIS_USER_ID) === '77398023', String(CHRIS_USER_ID));
  }

  console.log('\nTest 2: decideAction — only "Run Requested" runs');
  {
    check('Run Requested → run', decideAction('Run Requested') === 'run', decideAction('Run Requested'));
    for (const s of ['Idle', 'Running', 'Error', '', null, undefined, 'Pending']) {
      check(`${JSON.stringify(s)} → skip`, decideAction(s) === 'skip', decideAction(s));
    }
  }

  console.log('\nTest 3: lock — acquire, held, stale-steal, release');
  {
    const f = makeFakeFs();
    const opts = { fsImpl: f.fs, lockFile: '/fake/planner.lock', now: NOW, pid: 111 };
    const a1 = acquireLock(opts);
    check('fresh acquire ok', a1.ok === true, JSON.stringify(a1));
    check('lock file written with pid + startedAt', (() => {
      const l = JSON.parse(f.files.get('/fake/planner.lock'));
      return l.pid === 111 && typeof l.startedAt === 'string';
    })(), f.files.get('/fake/planner.lock'));

    const a2 = acquireLock({ ...opts, pid: 222 });
    check('held fresh lock → not acquired', a2.ok === false && /lock/i.test(a2.reason || ''), JSON.stringify(a2));

    // Stale: held since 2 hours before NOW.
    f.files.set('/fake/planner.lock', JSON.stringify({ pid: 111, startedAt: '2026-06-13T16:00:00.000Z' }));
    const a3 = acquireLock({ ...opts, pid: 333 });
    check('stale lock stolen', a3.ok === true && JSON.parse(f.files.get('/fake/planner.lock')).pid === 333, JSON.stringify(a3));

    releaseLock({ fsImpl: f.fs, lockFile: '/fake/planner.lock' });
    check('release removes file', !f.files.has('/fake/planner.lock'), '');
    // Releasing a missing lock must not throw.
    releaseLock({ fsImpl: f.fs, lockFile: '/fake/planner.lock' });
    check('double release safe', true, '');
  }

  console.log('\nTest 4: buildRunSummary — counts, outputs, error variants');
  {
    const meta = { mode: 'poll', startedAt: new Date('2026-06-13T18:00:00Z'), finishedAt: new Date('2026-06-13T18:03:00Z') };
    const s1 = buildRunSummary(cleanResult(), meta);
    check('clean: mentions accepted/conflict counts', /1 accepted/.test(s1) && /0 conflict/.test(s1), s1);
    check('clean: mentions placements', /3 placement/.test(s1), s1);
    check('clean: mentions Capacity View ok + briefing week', /Capacity View/.test(s1) && /2026-06-15/.test(s1), s1);
    check('clean: mode tagged', /poll/.test(s1), s1);

    const r2 = cleanResult();
    r2.validation.conflicts = [{ rowId: 'RX', reason: 'too tall' }];
    const s2 = buildRunSummary(r2, meta);
    check('conflicts: row id + reason surfaced', /RX/.test(s2) && /too tall/.test(s2), s2);

    const s3 = buildRunSummary({ validation: { accepted: [], conflicts: [] }, planError: 'hard rule: nope' }, meta);
    check('planError: surfaced + outputs marked not regenerated', /hard rule: nope/.test(s3) && /not regenerated|aborted/i.test(s3), s3);

    const r4 = cleanResult();
    r4.outputs.capacityView = { ok: false, error: 'chunk 3 failed' };
    const s4 = buildRunSummary(r4, meta);
    check('writer failure: error text surfaced', /chunk 3 failed/.test(s4), s4);

    const r5 = cleanResult();
    r5.outputs.leadTimes = { ok: false, error: 'lead-times boom' };
    const s5 = buildRunSummary(r5, meta);
    check('lead-times failure: error text surfaced in summary', /lead-times boom/.test(s5), s5);
    check('lead-times failure: mentions Lead-times / FAILED', /[Ll]ead-[Tt]imes.*FAIL/i.test(s5) || /FAIL.*[Ll]ead/i.test(s5), s5);

    const r6 = cleanResult();
    r6.progressWarnings = ['Nudge Me Panel: ⏳ Hrs Left is 0 but station not ticked — tick ✅ Stations Complete if truly done'];
    const s6 = buildRunSummary(r6, meta);
    check('progress warnings surfaced in summary', /Shop-floor progress: 1 note/.test(s6) && /Nudge Me Panel/.test(s6), s6);
    check('clean result has no progress block', !/Shop-floor progress/.test(buildRunSummary(cleanResult(), meta)), '');
    check('progress warnings alone do NOT notify (summary-only per spec)',
      shouldNotify(r6).notify === false, JSON.stringify(shouldNotify(r6)));
  }

  console.log('\nTest 5: shouldNotify — silent on clean success only');
  {
    check('clean → no notify', shouldNotify(cleanResult()).notify === false, JSON.stringify(shouldNotify(cleanResult())));
    const r2 = cleanResult(); r2.validation.conflicts = [{ rowId: 'R9' }];
    check('conflicts → notify', shouldNotify(r2).notify === true && /conflict/i.test(r2 && shouldNotify(r2).reasons.join()), JSON.stringify(shouldNotify(r2)));
    const r3 = { validation: { accepted: [], conflicts: [] }, planError: 'boom' };
    check('planError → notify', shouldNotify(r3).notify === true, JSON.stringify(shouldNotify(r3)));
    const r4 = cleanResult(); r4.outputs.weeklyBriefing = { ok: false, error: 'x' };
    check('writer failure → notify', shouldNotify(r4).notify === true, JSON.stringify(shouldNotify(r4)));
    const r5 = cleanResult(); r5.outputs.leadTimes = { ok: false, error: 'lead-times boom' };
    check('lead-times failure → notify', shouldNotify(r5).notify === true, JSON.stringify(shouldNotify(r5)));
    check('lead-times failure reason mentions lead-times',
      shouldNotify(r5).reasons.some(r => /lead-times/i.test(r)),
      JSON.stringify(shouldNotify(r5).reasons));
  }

  console.log('\nTest 6: loadTriggerConfig — missing → null, valid → object');
  {
    const f = makeFakeFs();
    check('missing → null', loadTriggerConfig({ fsImpl: f.fs, configFile: '/fake/cfg.json' }) === null, '');
    const ok = makeFakeFs({ '/fake/cfg.json': JSON.stringify(CONFIG) });
    check('valid → parsed', loadTriggerConfig({ fsImpl: ok.fs, configFile: '/fake/cfg.json' })?.itemId === '99100', '');
  }

  console.log('\nTest 7: runOnce poll + Idle → skip, read-only');
  {
    const gql = makeFakeGql({ status: 'Idle' });
    const f = makeFakeFs();
    const r = await runOnce({ mode: 'poll', deps: baseDeps(gql, f) });
    check('ran === false', r.ran === false, JSON.stringify(r));
    check('only the status read fired', gql.kinds().join(',') === 'readStatus', JSON.stringify(gql.kinds()));
    check('no lock left behind', !f.files.has('/fake/logs/planner.lock'), '');
  }

  console.log('\nTest 8: runOnce poll + Run Requested + clean → Running→Idle, update posted, NO notification');
  {
    const gql = makeFakeGql({ status: 'Run Requested' });
    const f = makeFakeFs();
    const r = await runOnce({ mode: 'poll', deps: baseDeps(gql, f) });
    check('ran === true', r.ran === true, JSON.stringify(r));
    check('status flipped Running then Idle', gql.statusLabels().join(',') === 'Running,Idle', JSON.stringify(gql.statusLabels()));
    check('run-summary update posted', gql.kinds().includes('update'), JSON.stringify(gql.kinds()));
    check('no notification on clean success', !gql.kinds().includes('notify'), JSON.stringify(gql.kinds()));
    check('lock released', !f.files.has('/fake/logs/planner.lock'), '');
  }

  console.log('\nTest 9: runOnce — conflicts → notification with conflict text');
  {
    const gql = makeFakeGql({ status: 'Run Requested' });
    const f = makeFakeFs();
    const result = cleanResult();
    result.validation.conflicts = [{ rowId: 'R7', reason: 'past delivery' }];
    const r = await runOnce({ mode: 'poll', deps: baseDeps(gql, f, async () => result) });
    check('notification fired', gql.kinds().includes('notify'), JSON.stringify(gql.kinds()));
    const notif = gql.calls.find(c => /create_notification/.test(c.query));
    check('notification targets Chris + trigger item', String(notif?.variables?.userId) === '77398023' && String(notif?.variables?.targetId) === CONFIG.itemId, JSON.stringify(notif?.variables));
    check('notification text mentions conflict', /conflict/i.test(notif?.variables?.text || ''), notif?.variables?.text);
    check('status still ends Idle (conflicts are a row outcome, not a run failure)', gql.statusLabels().pop() === 'Idle', JSON.stringify(gql.statusLabels()));
  }

  console.log('\nTest 10: runOnce — planError → status Error + notification');
  {
    const gql = makeFakeGql({ status: 'Run Requested' });
    const f = makeFakeFs();
    const r = await runOnce({ mode: 'poll', deps: baseDeps(gql, f, async () => ({ validation: { accepted: [], conflicts: [] }, planError: 'planner exploded' })) });
    check('status ends Error', gql.statusLabels().pop() === 'Error', JSON.stringify(gql.statusLabels()));
    check('notification fired with planner error', /planner exploded/.test(gql.calls.find(c => /create_notification/.test(c.query))?.variables?.text || ''), '');
    check('result.ran true with planError marker', r.ran === true && /exploded/.test(r.planError || ''), JSON.stringify(r));
  }

  console.log('\nTest 11: runOnce — lock held → skip WITHOUT touching status (request survives)');
  {
    const gql = makeFakeGql({ status: 'Run Requested' });
    const f = makeFakeFs({ '/fake/logs/planner.lock': JSON.stringify({ pid: 1, startedAt: NOW().toISOString() }) });
    const r = await runOnce({ mode: 'poll', deps: baseDeps(gql, f) });
    check('ran === false, skipped locked', r.ran === false && /lock/i.test(r.skipped || ''), JSON.stringify(r));
    check('status never written', gql.statusLabels().length === 0, JSON.stringify(gql.statusLabels()));
    check('foreign lock not deleted', f.files.has('/fake/logs/planner.lock'), '');
  }

  console.log('\nTest 12: runOnce scheduled — runs regardless of Idle status');
  {
    const gql = makeFakeGql({ status: 'Idle' });
    const f = makeFakeFs();
    const r = await runOnce({ mode: 'scheduled', deps: baseDeps(gql, f) });
    check('ran === true despite Idle', r.ran === true, JSON.stringify(r));
    check('status flipped Running then Idle', gql.statusLabels().join(',') === 'Running,Idle', JSON.stringify(gql.statusLabels()));
  }

  console.log('\nTest 13: runOnce — unexpected runPlanner throw → Error status, notify, lock released, no rethrow');
  {
    const gql = makeFakeGql({ status: 'Run Requested' });
    const f = makeFakeFs();
    let threw = false, r;
    try {
      r = await runOnce({ mode: 'poll', deps: baseDeps(gql, f, async () => { throw new Error('socket reset'); }) });
    } catch (e) { threw = true; }
    check('does not rethrow', threw === false, '');
    check('status ends Error', gql.statusLabels().pop() === 'Error', JSON.stringify(gql.statusLabels()));
    check('notified with the error', /socket reset/.test(gql.calls.find(c => /create_notification/.test(c.query))?.variables?.text || ''), '');
    check('lock released despite throw', !f.files.has('/fake/logs/planner.lock'), '');
    check('result carries error', /socket reset/.test(r?.error || ''), JSON.stringify(r));
  }

  console.log('\nTest 14: runOnce — missing config → throws with setup hint');
  {
    const gql = makeFakeGql();
    const f = makeFakeFs();
    const deps = { ...baseDeps(gql, f), config: null, configFile: '/fake/missing.json' };
    let msg = null;
    try { await runOnce({ mode: 'poll', deps }); } catch (e) { msg = e.message; }
    check('throws pointing at setup script', /setup-trigger-item/.test(msg || ''), msg);
  }

  // ===========================================================================
  // REVIEW FIXES (2026-06-11 adversarial review of the P3 diff)
  // ===========================================================================

  console.log('\nTest 15: REVIEW FIX — lock acquire is ATOMIC (wx), not check-then-write');
  {
    // Simulate the Saturday-18:00 race: existsSync says free (both processes
    // checked before either wrote), but the exclusive create loses. A
    // check-then-write implementation would claim ok:true and double-run.
    const f = makeFakeFs();
    const lyingFs = {
      ...f.fs,
      existsSync: (p) => /planner\.lock/.test(String(p)) ? false : f.fs.existsSync(p),
    };
    // Winner takes the lock for real…
    f.files.set('/fake/planner.lock', JSON.stringify({ pid: 1, token: 'winner', startedAt: NOW().toISOString() }));
    // …loser must fail via EEXIST despite existsSync lying.
    const a = acquireLock({ fsImpl: lyingFs, lockFile: '/fake/planner.lock', now: NOW, pid: 2 });
    check('loser of the race gets ok:false', a.ok === false, JSON.stringify(a));
    check('winner lock intact', JSON.parse(f.files.get('/fake/planner.lock')).token === 'winner', f.files.get('/fake/planner.lock'));
  }

  console.log('\nTest 16: REVIEW FIX — releaseLock only removes the lock it owns');
  {
    const f = makeFakeFs();
    const a = acquireLock({ fsImpl: f.fs, lockFile: '/fake/planner.lock', now: NOW, pid: 11 });
    check('acquire returns an ownership token', a.ok === true && typeof a.token === 'string' && a.token.length > 0, JSON.stringify(a));
    // A stealer replaces the lock (stale-steal scenario)…
    f.files.set('/fake/planner.lock', JSON.stringify({ pid: 99, token: 'stolen-by-99', startedAt: NOW().toISOString() }));
    releaseLock({ fsImpl: f.fs, lockFile: '/fake/planner.lock', token: a.token });
    check('foreign lock NOT deleted by stale owner', f.files.has('/fake/planner.lock'), '');
    releaseLock({ fsImpl: f.fs, lockFile: '/fake/planner.lock', token: 'stolen-by-99' });
    check('matching token releases', !f.files.has('/fake/planner.lock'), '');
  }

  console.log('\nTest 17: REVIEW FIX — poll + status Running + dead lock → self-heal to Error + notify');
  {
    // A killed run (logoff, reboot, battery-stop) leaves status=Running
    // forever; poll only acts on Run Requested. Recovery: Running with NO
    // live lock means the run died — flip to Error, post update, notify.
    const gql = makeFakeGql({ status: 'Running' });
    const f = makeFakeFs();   // no lock file
    const r = await runOnce({ mode: 'poll', deps: baseDeps(gql, f) });
    check('ran:false recovered:true', r.ran === false && r.recovered === true, JSON.stringify(r));
    check('status flipped to Error', gql.statusLabels().join(',') === 'Error', JSON.stringify(gql.statusLabels()));
    check('update posted explaining the dead run', /died|crash|interrupted/i.test(gql.calls.find(c => /create_update/.test(c.query))?.variables?.body || ''), '');
    check('Chris notified', gql.kinds().includes('notify'), JSON.stringify(gql.kinds()));
  }

  console.log('\nTest 18: REVIEW FIX — poll + status Running + LIVE lock → normal in-flight skip, no status writes');
  {
    const gql = makeFakeGql({ status: 'Running' });
    const f = makeFakeFs({ '/fake/logs/planner.lock': JSON.stringify({ pid: 5, token: 't', startedAt: NOW().toISOString() }) });
    const r = await runOnce({ mode: 'poll', deps: baseDeps(gql, f) });
    check('skipped (run in flight)', r.ran === false && !r.recovered, JSON.stringify(r));
    check('no status writes, no notify', gql.statusLabels().length === 0 && !gql.kinds().includes('notify'), JSON.stringify(gql.kinds()));
  }

  console.log('\nTest 19: REVIEW FIX — scheduled mode survives a failing status read');
  {
    // The Saturday run must not be killed by a transient gql failure on a
    // read it doesn't even gate on.
    const gql = async (q, v) => {
      if (/change_multiple/.test(q)) return { change_multiple_column_values: { id: '1' } };
      if (/create_update/.test(q)) return { create_update: { id: 'u' } };
      if (/create_notification/.test(q)) return { create_notification: { text: 'ok' } };
      if (/items\s*\(/.test(q)) throw new Error('GraphQL error: 502');
      throw new Error('unrouted: ' + q.slice(0, 50));
    };
    const f = makeFakeFs();
    const r = await runOnce({ mode: 'scheduled', deps: { ...baseDeps(gql, f), gqlFn: gql } });
    check('scheduled run still ran', r.ran === true, JSON.stringify(r));
  }

  console.log('\nTest 20: REVIEW FIX — poll + failing status read → quiet skip (network heals next tick)');
  {
    const gql = async (q) => { throw new Error('fetch failed'); };
    const f = makeFakeFs();
    const r = await runOnce({ mode: 'poll', deps: { ...baseDeps(gql, f), gqlFn: gql } });
    check('quiet skip, no throw', r.ran === false && /status read failed/i.test(r.skipped || ''), JSON.stringify(r));
  }

  console.log('\nTest 21: REVIEW FIX — scheduled + lock held → Chris notified about the skipped Saturday run');
  {
    const gql = makeFakeGql({ status: 'Idle' });
    const f = makeFakeFs({ '/fake/logs/planner.lock': JSON.stringify({ pid: 5, token: 't', startedAt: NOW().toISOString() }) });
    const r = await runOnce({ mode: 'scheduled', deps: baseDeps(gql, f) });
    check('skipped on lock', r.ran === false && /lock/i.test(r.skipped || ''), JSON.stringify(r));
    const notif = gql.calls.find(c => /create_notification/.test(c.query));
    check('notification fired about the skipped scheduled run', /skipped|lock/i.test(notif?.variables?.text || ''), notif?.variables?.text || '(none)');
  }

  console.log('\nTest 22: REVIEW FIX — post-run status-flip failure no longer swallows update + notification');
  {
    let statusWrites = 0;
    const calls = [];
    const gql = async (q, v) => {
      calls.push({ q, v });
      if (/change_multiple/.test(q)) {
        statusWrites++;
        if (statusWrites === 2) throw new Error('GraphQL error: complexity budget exhausted');  // the post-run flip
        return { change_multiple_column_values: { id: '1' } };
      }
      if (/items\s*\(/.test(q)) return { items: [{ column_values: [{ id: CONFIG.statusColumnId, text: 'Run Requested' }] }] };
      if (/create_update/.test(q)) return { create_update: { id: 'u' } };
      if (/create_notification/.test(q)) return { create_notification: { text: 'ok' } };
      throw new Error('unrouted');
    };
    const f = makeFakeFs();
    const result = cleanResult();
    result.validation.conflicts = [{ rowId: 'RX', reason: 'x' }];   // notification expected
    let threw = false;
    try {
      await runOnce({ mode: 'poll', deps: { ...baseDeps(gql, f), gqlFn: gql, runPlannerFn: async () => result } });
    } catch (e) { threw = true; }
    check('no throw', threw === false, '');
    check('summary update still posted', calls.some(c => /create_update/.test(c.q)), '');
    check('notification still sent', calls.some(c => /create_notification/.test(c.q)), '');
    check('lock released', !f.files.has('/fake/logs/planner.lock'), '');
  }

  console.log('\nTest 23: REVIEW FIX — unexpected-throw summary does NOT claim "previous good state preserved"');
  {
    const gql = makeFakeGql({ status: 'Run Requested' });
    const f = makeFakeFs();
    await runOnce({ mode: 'poll', deps: baseDeps(gql, f, async () => { throw new Error('disk full'); }) });
    const body = gql.calls.find(c => /create_update/.test(c.query))?.variables?.body || '';
    check('update mentions unexpected failure + the error', /unexpected/i.test(body) && /disk full/.test(body), body);
    check('update does NOT assert preservation it cannot verify', !/previous good state preserved/i.test(body), body);
  }

  console.log('\nTest 24: AUDIT FIX — auth failure is distinguished from quiet network skip');
  {
    // Token revocation/expiry previously looked IDENTICAL to healthy idle:
    // the status read failed, poll mode skipped quietly, and no human signal
    // existed anywhere. Auth-like errors now surface authFailure: true so
    // the CLI can log loudly (the monday notifier is useless here — it needs
    // the very token that died).
    const authGql = async () => { throw new Error('GraphQL error: [{"message":"Not Authenticated","error_code":"UserUnauthorizedException"}]'); };
    const f = makeFakeFs();
    const r = await runOnce({ mode: 'poll', deps: { ...baseDeps(authGql, f), gqlFn: authGql } });
    check('ran:false with authFailure flag', r.ran === false && r.authFailure === true, JSON.stringify(r));

    // Plain network failure stays a quiet skip without the flag.
    const netGql = async () => { throw new Error('fetch failed'); };
    const f2 = makeFakeFs();
    const r2 = await runOnce({ mode: 'poll', deps: { ...baseDeps(netGql, f2), gqlFn: netGql } });
    check('network failure NOT flagged as auth', r2.ran === false && !r2.authFailure, JSON.stringify(r2));
  }

  console.log('\nTest 25: DEPLOY — decideAction recognizes Deploy Requested');
  {
    check('Deploy Requested → deploy', decideAction('Deploy Requested') === 'deploy', decideAction('Deploy Requested'));
    check('Run Requested still → run', decideAction('Run Requested') === 'run', '');
  }

  console.log('\nTest 26: DEPLOY — plan then execute, Idle at end, Chris notified of the deploy');
  {
    const gql = makeFakeGql({ status: 'Deploy Requested' });
    const f = makeFakeFs();
    const modes = [];
    const runPlannerFn = async ({ mode: m } = {}) => {
      modes.push(m);
      if (m === 'plan') return cleanResult();
      return { plan: {}, executed: { deleted: 12, created: 9, subSkipped: 1, finishWrites: { ok: 3, fail: 0 } } };
    };
    const r = await runOnce({ mode: 'poll', deps: baseDeps(gql, f, runPlannerFn) });
    check('ran + deployed', r.ran === true && r.deployed === true, JSON.stringify(r));
    check('plan ran BEFORE execute', modes.join(',') === 'plan,execute', JSON.stringify(modes));
    check('status flipped Running then Idle', gql.statusLabels().join(',') === 'Running,Idle', JSON.stringify(gql.statusLabels()));
    const notif = gql.calls.find(c => /create_notification/.test(c.query));
    check('deploy notification sent (board rewritten — Chris should know)', /deploy/i.test(notif?.variables?.text || ''), notif?.variables?.text || '(none)');
    const update = gql.calls.find(c => /create_update/.test(c.query));
    check('summary update carries deploy counts', /12 deleted/.test(update?.variables?.body || '') && /9 created/.test(update?.variables?.body || ''), update?.variables?.body);
  }

  console.log('\nTest 27: DEPLOY — plan error aborts the deploy (no execute), status Error');
  {
    const gql = makeFakeGql({ status: 'Deploy Requested' });
    const f = makeFakeFs();
    const modes = [];
    const runPlannerFn = async ({ mode: m } = {}) => {
      modes.push(m);
      return { validation: { accepted: [], conflicts: [] }, planError: 'planner exploded' };
    };
    const r = await runOnce({ mode: 'poll', deps: baseDeps(gql, f, runPlannerFn) });
    check('execute never ran', modes.join(',') === 'plan', JSON.stringify(modes));
    check('status ends Error', gql.statusLabels().pop() === 'Error', JSON.stringify(gql.statusLabels()));
    check('deployed flag false/absent', !r.deployed, JSON.stringify(r));
  }

  console.log('\nTest 28: DEPLOY — execute failure → Error + notify; dryRun deploy skips execute');
  {
    const gql = makeFakeGql({ status: 'Deploy Requested' });
    const f = makeFakeFs();
    const runPlannerFn = async ({ mode: m } = {}) => {
      if (m === 'plan') return cleanResult();
      throw new Error('finishing-cycle gate blocked');
    };
    const r = await runOnce({ mode: 'poll', deps: baseDeps(gql, f, runPlannerFn) });
    check('execute failure → status Error', gql.statusLabels().pop() === 'Error', JSON.stringify(gql.statusLabels()));
    check('notification mentions the gate failure', /finishing-cycle gate/.test(gql.calls.find(c => /create_notification/.test(c.query))?.variables?.text || ''), '');

    // dryRun: plan runs dry, execute is skipped with a would-deploy note.
    const gql2 = makeFakeGql({ status: 'Deploy Requested' });
    const f2 = makeFakeFs();
    const modes2 = [];
    const prevEnv = process.env.DRY_RUN;
    process.env.DRY_RUN = '1';
    let r2;
    try {
      r2 = await runOnce({ mode: 'poll', deps: baseDeps(gql2, f2, async ({ mode: m } = {}) => { modes2.push(m); return cleanResult(); }) });
    } finally {
      if (prevEnv === undefined) delete process.env.DRY_RUN; else process.env.DRY_RUN = prevEnv;
    }
    check('dryRun: execute never invoked', modes2.join(',') === 'plan', JSON.stringify(modes2));
    check('dryRun: not marked deployed', !r2.deployed, JSON.stringify(r2));
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All P3.1 planner-trigger tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
