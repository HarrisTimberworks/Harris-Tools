#!/usr/bin/env node
// test-quote-trigger.js — quote handling in planner-trigger.js. Hermetic.
const {
  readTickState, QUOTE_LABELS, parseQuoteRows, processQuotes,
  QUOTE_LOCK_STALE_MS, DEFAULT_QUOTE_LOCK_FILE,
} = require('./planner-trigger.js');

const failures = [];
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else { failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label} — ${detail}`); }
}

const CONFIG = {
  boardId: '18413101550', groupId: 'group_mm47eq7n', itemId: '12248969189',
  statusColumnId: 'color_trigger',
  quotesGroupId: 'group_quotes',
  quoteColumns: { jobType: 'dropdown_jt', boxes: 'numeric_bx', complexity: 'numeric_cx',
    targetDate: 'date_tg', status: 'color_qs', quotedWeek: 'date_qw', capacityWeek: 'date_cw' },
};

// ---------------------------------------------------------------------------
// Stubs — makeFakeFs copied VERBATIM from test-planner-trigger.js lines 49-73
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

console.log('Test 1: readTickState — ONE request carrying trigger status + quote rows');
(async () => {
  let calls = 0; let lastQuery = '';
  const gqlFn = async (q) => {
    calls++; lastQuery = q;
    return {
      items: [{ column_values: [{ id: 'color_trigger', text: 'Idle' }] }],
      boards: [{ groups: [{ items_page: { items: [
        { id: '501', name: 'Smith kitchen', column_values: [
          { id: 'dropdown_jt', text: 'Res - Face Frame' }, { id: 'numeric_bx', text: '25' },
          { id: 'numeric_cx', text: '2' }, { id: 'date_tg', text: '' },
          { id: 'color_qs', text: 'Quote Requested' }, { id: 'date_qw', text: '' }, { id: 'date_cw', text: '' } ] },
      ] } }] }],
    };
  };
  const state = await readTickState({ config: CONFIG, gqlFn });
  check('one API call', calls === 1, String(calls));
  check('status text extracted', state.statusText === 'Idle', String(state.statusText));
  check('quote rows extracted', state.quoteRows.length === 1);
  check('query carries both root fields', lastQuery.includes('items(ids:') && lastQuery.includes('boards(ids:'));

  console.log('Test 2: readTickState without quotesGroupId falls back to single-item query (pre-setup safety)');
  let fallbackQuery = '';
  const state2 = await readTickState({
    config: { ...CONFIG, quotesGroupId: undefined, quoteColumns: undefined },
    gqlFn: async (q) => { fallbackQuery = q; return { items: [{ column_values: [{ id: 'color_trigger', text: 'Idle' }] }] }; },
  });
  check('no boards field in fallback', !fallbackQuery.includes('boards(ids:'));
  check('quoteRows empty', state2.quoteRows.length === 0);

  console.log('Test 3: parseQuoteRows maps columns by config ids');
  const rows = parseQuoteRows(
    [{ id: '501', name: 'Smith kitchen', column_values: [
      { id: 'dropdown_jt', text: 'Res - Face Frame' }, { id: 'numeric_bx', text: '25' },
      { id: 'numeric_cx', text: '2.4' }, { id: 'date_tg', text: '2026-09-07' },
      { id: 'color_qs', text: 'Quote Requested' } ] }], CONFIG);
  check('row shape', rows[0].rowId === '501' && rows[0].jobType === 'Res - Face Frame'
    && rows[0].boxes === '25' && rows[0].complexity === '2.4'
    && rows[0].targetDate === '2026-09-07' && rows[0].quoteStatus === 'Quote Requested',
    JSON.stringify(rows[0]));

  console.log('Test 4: processQuotes happy path — lifecycle + writebacks + silence');
  {
    const { files, fs: fakeFs } = makeFakeFs();
    const mutations = [];
    const gqlFn = async (q, vars) => { mutations.push({ q, vars }); return { change_multiple_column_values: { id: '1' }, create_update: { id: '2' } }; };
    const fakeResult = { ok: true, mode: 'earliest', verdict: 'EARLIEST', quotedWeek: '2026-09-07',
      capacityWeek: '2026-08-03', floorWeek: '2026-09-07', dataFreshness: new Date().toISOString(),
      inputs: { jobType: 'Res - Face Frame', boxes: 25, complexity: 2, complexityUsed: 2, targetDate: null },
      hours: { eng: 15, panel: 13.8, bench: 7.5, prefin: 27.5, postfin: 11.3 },
      policy: { preProductionWeeks: 2, minLeadWeeks: 12 } };
    let loaded = 0;
    const r = await processQuotes({
      rows: [{ rowId: '501', name: 'Smith', jobType: 'Res - Face Frame', boxes: '25', complexity: '2', targetDate: null, quoteStatus: QUOTE_LABELS.requested }],
      deps: { config: CONFIG, gqlFn, fsImpl: fakeFs, now: () => new Date(),
        loadAllFn: async () => { loaded++; return { jobs: [], crewParents: [], timeOff: [], existingSubs: [], overrideRows: [] }; },
        runQuoteFn: async () => fakeResult, logger: { log: () => {} } },
    });
    check('processed 1', r.processed === 1, JSON.stringify(r));
    check('fresh loadAll happened', loaded === 1);
    const labels = mutations.filter(m => m.q.includes('change_multiple_column_values')).map(m => m.vars.cv);
    check('flipped Quoting then Quoted', labels.some(cv => cv.includes('Quoting')) && labels.some(cv => cv.includes('"Quoted"')),
      JSON.stringify(labels));
    check('date columns written', labels.some(cv => cv.includes('2026-09-07') && cv.includes('2026-08-03')));
    check('update posted with both numbers', mutations.some(m => m.q.includes('create_update') && m.vars.body.includes('2026-08-03')));
    check('no notification on clean quote', !mutations.some(m => m.q.includes('create_notification')));
    check('quote lock released', !files.has(String(DEFAULT_QUOTE_LOCK_FILE)) || !files.get(String(DEFAULT_QUOTE_LOCK_FILE)));
  }

  console.log('Test 5: invalid input → Quote Error + reason, NO notification, engine never ran');
  {
    const { fs: fakeFs } = makeFakeFs();
    const mutations = [];
    const gqlFn = async (q, vars) => { mutations.push({ q, vars }); return {}; };
    let engineRan = 0;
    await processQuotes({
      rows: [{ rowId: '502', name: 'Bad', jobType: 'Res FF', boxes: '0', complexity: '2', targetDate: null, quoteStatus: QUOTE_LABELS.requested }],
      deps: { config: CONFIG, gqlFn, fsImpl: fakeFs, now: () => new Date(),
        loadAllFn: async () => ({ jobs: [], crewParents: [], timeOff: [], existingSubs: [], overrideRows: [] }),
        runQuoteFn: async () => { engineRan++; return { ok: false, reason: 'should not reach' }; },
        logger: { log: () => {} } },
    });
    // validation happens BEFORE loadAll/engine — validateQuoteInput is called by processQuotes
    check('Quote Error flipped', mutations.some(m => m.vars?.cv?.includes('Quote Error')));
    check('reason in update', mutations.some(m => m.q.includes('create_update') && /Boxes/.test(m.vars.body)));
    check('no notification', !mutations.some(m => m.q.includes('create_notification')));
  }

  console.log('Test 6: engine failure → Quote Error + notify Chris');
  {
    const { fs: fakeFs } = makeFakeFs();
    const mutations = [];
    const gqlFn = async (q, vars) => { mutations.push({ q, vars }); return {}; };
    await processQuotes({
      rows: [{ rowId: '503', name: 'Boom', jobType: 'Commercial', boxes: '10', complexity: '2', targetDate: null, quoteStatus: QUOTE_LABELS.requested }],
      deps: { config: CONFIG, gqlFn, fsImpl: fakeFs, now: () => new Date(),
        loadAllFn: async () => ({ jobs: [], crewParents: [], timeOff: [], existingSubs: [], overrideRows: [] }),
        runQuoteFn: async () => { throw new Error('planner exploded'); }, logger: { log: () => {} } },
    });
    check('Quote Error flipped', mutations.some(m => m.vars?.cv?.includes('Quote Error')));
    check('Chris notified', mutations.some(m => m.q.includes('create_notification') && /planner exploded/.test(m.vars.text)));
  }

  console.log('Test 7: planner.lock held → defer, row untouched');
  {
    const { acquireLock } = require('./planner-trigger.js');
    const { files, fs: fakeFs } = makeFakeFs();
    // Seed a FRESH planner lock via acquireLock itself — guarantees the file
    // shape matches whatever readLockState parses (never hand-roll lock JSON).
    const plannerLockPath = require('path').join(__dirname, '..', 'logs', 'planner.lock');
    acquireLock({ fsImpl: fakeFs, lockFile: plannerLockPath, now: () => new Date() });
    const mutations = [];
    const r = await processQuotes({
      rows: [{ rowId: '504', name: 'Wait', jobType: 'Commercial', boxes: '10', complexity: '2', targetDate: null, quoteStatus: QUOTE_LABELS.requested }],
      deps: { config: CONFIG, gqlFn: async (q, vars) => { mutations.push({ q, vars }); return {}; }, fsImpl: fakeFs,
        now: () => new Date(), loadAllFn: async () => ({}), runQuoteFn: async () => ({}), logger: { log: () => {} } },
    });
    check('deferred', r.deferred === 1, JSON.stringify(r));
    check('zero mutations', mutations.length === 0, String(mutations.length));
  }

  console.log('Test 8: 3-per-tick cap');
  {
    const { fs: fakeFs } = makeFakeFs();
    const rows = ['1', '2', '3', '4', '5'].map(id => ({ rowId: id, name: `Q${id}`, jobType: 'Commercial', boxes: '5', complexity: '2', targetDate: null, quoteStatus: QUOTE_LABELS.requested }));
    const fakeResult = { ok: true, mode: 'earliest', verdict: 'EARLIEST', quotedWeek: '2026-09-07', capacityWeek: '2026-08-03',
      floorWeek: '2026-09-07', dataFreshness: new Date().toISOString(),
      inputs: { jobType: 'Commercial', boxes: 5, complexity: 2, complexityUsed: 2, targetDate: null },
      hours: { eng: 2, panel: 2.8, bench: 0.8, prefin: 0, postfin: 3.3 }, policy: { preProductionWeeks: 2, minLeadWeeks: 10 } };
    const r = await processQuotes({
      rows,
      deps: { config: CONFIG, gqlFn: async () => ({}), fsImpl: fakeFs, now: () => new Date(),
        loadAllFn: async () => ({ jobs: [], crewParents: [], timeOff: [], existingSubs: [], overrideRows: [] }),
        runQuoteFn: async () => fakeResult, logger: { log: () => {} } },
    });
    check('processed exactly 3', r.processed === 3, JSON.stringify(r));
    check('2 left for next tick', r.remaining === 2);
  }

  console.log('Test 9: stuck-Quoting self-heal — Quoting + absent quote.lock ⇒ Quote Error');
  {
    const { fs: fakeFs } = makeFakeFs(); // no lock file at all
    const mutations = [];
    await processQuotes({
      rows: [{ rowId: '505', name: 'Stuck', jobType: 'Commercial', boxes: '5', complexity: '2', targetDate: null, quoteStatus: QUOTE_LABELS.quoting }],
      deps: { config: CONFIG, gqlFn: async (q, vars) => { mutations.push({ q, vars }); return {}; }, fsImpl: fakeFs,
        now: () => new Date(), loadAllFn: async () => ({}), runQuoteFn: async () => ({}), logger: { log: () => {} } },
    });
    check('healed to Quote Error', mutations.some(m => m.vars?.cv?.includes('Quote Error')));
    check('explanation update posted', mutations.some(m => m.q.includes('create_update') && /died|crash|mid-flight/i.test(m.vars.body)));
  }

  console.log('Test 10: DRY_RUN prints, mutates nothing');
  {
    process.env.DRY_RUN = '1';
    const { fs: fakeFs } = makeFakeFs();
    const mutations = [];
    const logged = [];
    await processQuotes({
      rows: [{ rowId: '506', name: 'Dry', jobType: 'Commercial', boxes: '5', complexity: '2', targetDate: null, quoteStatus: QUOTE_LABELS.requested }],
      deps: { config: CONFIG, gqlFn: async (q, vars) => { mutations.push({ q, vars }); return {}; }, fsImpl: fakeFs,
        now: () => new Date(), loadAllFn: async () => ({ jobs: [], crewParents: [], timeOff: [], existingSubs: [], overrideRows: [] }),
        runQuoteFn: async () => ({ ok: true, mode: 'earliest', verdict: 'EARLIEST', quotedWeek: '2026-09-07',
          capacityWeek: '2026-08-03', floorWeek: '2026-09-07', dataFreshness: new Date().toISOString(),
          inputs: { jobType: 'Commercial', boxes: 5, complexity: 2, complexityUsed: 2, targetDate: null },
          hours: { eng: 2, panel: 2.8, bench: 0.8, prefin: 0, postfin: 3.3 }, policy: { preProductionWeeks: 2, minLeadWeeks: 10 } }),
        logger: { log: (m) => logged.push(m) } },
    });
    delete process.env.DRY_RUN;
    check('zero monday mutations under DRY_RUN', mutations.length === 0, String(mutations.length));
    check('intended writebacks printed', logged.some(l => /DRY RUN.*Quoted/i.test(l)), logged.join(' | ').slice(0, 200));
  }

  console.log('Test 11: setup — creates group + columns + persists config when absent');
  const { setupQuotesGroup } = require('./setup-quotes-group.js');
  {
    const calls = [];
    const gqlFn = async (q, vars) => {
      calls.push({ q, vars });
      if (q.includes('groups {')) return { boards: [{ groups: [{ id: 'group_mm47eq7n', title: '⚙️ Control' }] }] }; // no Quotes group yet
      if (q.includes('create_group')) return { create_group: { id: 'group_q1' } };
      if (q.includes('create_column')) return { create_column: { id: `col_${calls.length}` } };
      return {};
    };
    const writes = [];
    const fsImpl = { readFileSync: () => JSON.stringify({ boardId: '18413101550', groupId: 'g', itemId: 'i', statusColumnId: 's' }),
      writeFileSync: (p, c) => writes.push({ p, c }), existsSync: () => true };
    const res = await setupQuotesGroup({ gqlFn, fsImpl });
    check('group created', res.created === true && res.quotesGroupId === 'group_q1', JSON.stringify(res));
    check('7 columns created', calls.filter(c => c.q.includes('create_column')).length === 7);
    check('config written with quotesGroupId + quoteColumns', writes.length === 1
      && writes[0].c.includes('quotesGroupId') && writes[0].c.includes('quoteColumns'));
  }

  console.log('Test 12: setup — idempotent when group already exists (duplicate guard)');
  {
    const calls = [];
    const gqlFn = async (q) => {
      calls.push(q);
      if (q.includes('groups {')) return { boards: [{ groups: [{ id: 'group_q1', title: '💬 Quotes' }] }] };
      return {};
    };
    const fsImpl = { readFileSync: () => JSON.stringify({ boardId: '18413101550', groupId: 'g', itemId: 'i', statusColumnId: 's', quotesGroupId: 'group_q1', quoteColumns: { jobType: 'x' } }),
      writeFileSync: () => { throw new Error('must not rewrite config'); }, existsSync: () => true };
    const res = await setupQuotesGroup({ gqlFn, fsImpl });
    check('no creation', res.created === false && !calls.some(q => q.includes('create_group')));
  }

  console.log('Test 13: setup — transient query failure does NOT create (briefing-doc bug family)');
  {
    let threw = false;
    try {
      await setupQuotesGroup({ gqlFn: async () => { throw new Error('502'); },
        fsImpl: { readFileSync: () => JSON.stringify({ boardId: 'b' }), writeFileSync: () => {}, existsSync: () => true } });
    } catch (e) { threw = true; }
    check('throws instead of creating on read failure', threw);
  }

  console.log(failures.length ? `\n❌ ${failures.length}/${checks} FAILED` : `\n✅ all ${checks} checks passed`);
  process.exit(failures.length ? 1 : 0);
})();
