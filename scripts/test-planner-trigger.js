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
      writeFileSync: (p, c) => { files.set(String(p), c); },
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
