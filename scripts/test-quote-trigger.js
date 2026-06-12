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

  console.log(failures.length ? `\n❌ ${failures.length}/${checks} FAILED` : `\n✅ all ${checks} checks passed`);
  process.exit(failures.length ? 1 : 0);
})();
