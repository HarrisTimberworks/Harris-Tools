#!/usr/bin/env node
/**
 * C4 — write-capacity-view (Capacity View doc writer).
 *
 * Side-effectful writer that replaces the Capacity View doc body via:
 *   1. Read all block IDs (paginated, monday docs API)
 *   2. Save C3-generated markdown to logs/capacity-view-<date>.md (recovery
 *      artifact — preserved even in dry-run, E1)
 *   3. Delete each block sequentially via delete_doc_block (no batched
 *      operation surface exists; ~150ms rate-limit, B6 precedent)
 *   4. Add markdown via add_content_to_doc_from_markdown — single call
 *
 * Pre-release API-Version: the add_content_to_doc_from_markdown mutation is
 * only available via API-Version: 'next' (or 'beta'). Confirmed by direct
 * probe (the cascade findings doc); rationale + fallback path documented in
 * the writer's docstring.
 *
 * Tests use stubbed gqlFn / sleepFn / fs / logger — no MONDAY_API_TOKEN
 * required, no monday I/O fired.
 */

const path = require('path');
const {
  API_VERSION,
  CAPACITY_VIEW_OBJECT_ID,
  CAPACITY_VIEW_DOC_URL,
  getAllBlockIds,
  deleteBlocks,
  addMarkdownToDoc,
  saveMarkdownToDisk,
  getDocIdByObjectId,
  replaceCapacityViewBody,
  // C4-followup additions
  chunkMarkdownAtDividers,
  addMarkdownToDocChunked,
} = require('./write-capacity-view.js');

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

// Silence logger by default for tests.
const silentLogger = { log: () => {} };

// ---------------------------------------------------------------------------
// Stub builders
// ---------------------------------------------------------------------------

function makeFakeFs() {
  const writes = {};       // path → content
  const existing = new Set();
  return {
    writes,
    existing,
    fs: {
      existsSync: (p) => existing.has(p) || Object.keys(writes).some(w => w.startsWith(p)),
      mkdirSync: (p) => { existing.add(p); },
      writeFileSync: (p, content) => { writes[p] = content; },
    },
  };
}

// ---------------------------------------------------------------------------

(async () => {

  console.log('Test 1: API_VERSION constant is "next" (pre-release surface required for add_content_to_doc_from_markdown)');
  check('API_VERSION === "next"', API_VERSION === 'next', `got ${API_VERSION}`);

  console.log('\nTest 2: CAPACITY_VIEW_OBJECT_ID constant === 18410103423 (per Phase 2 §B/D7)');
  check('object id matches', CAPACITY_VIEW_OBJECT_ID === 18410103423, `got ${CAPACITY_VIEW_OBJECT_ID}`);

  console.log('\nTest 3: getAllBlockIds — single-page response (blocks.length < batchSize → no second call)');
  {
    let calls = 0;
    const stub = async () => {
      calls++;
      return { docs: [{ blocks: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }] }] };
    };
    const ids = await getAllBlockIds('doc-1', { gqlFn: stub, batchSize: 100 });
    check('returned 3 ids', ids.length === 3 && ids[0] === 'b1', JSON.stringify(ids));
    check('only 1 gqlFn call (no pagination needed)', calls === 1, `calls=${calls}`);
  }

  console.log('\nTest 4: getAllBlockIds — multi-page pagination (page 1 full + page 2 partial)');
  {
    const responses = [
      { docs: [{ blocks: Array.from({ length: 5 }, (_, i) => ({ id: `p1-${i}` })) }] },
      { docs: [{ blocks: Array.from({ length: 5 }, (_, i) => ({ id: `p2-${i}` })) }] },
      { docs: [{ blocks: Array.from({ length: 3 }, (_, i) => ({ id: `p3-${i}` })) }] },
    ];
    const calls = [];
    const stub = async (_q, vars) => {
      calls.push(vars.page);
      return responses[vars.page - 1];
    };
    const ids = await getAllBlockIds('doc-multi', { gqlFn: stub, batchSize: 5 });
    check('paginates until page returns < batchSize', ids.length === 13, `ids=${ids.length}`);
    check('called with pages 1, 2, 3', JSON.stringify(calls) === JSON.stringify([1, 2, 3]), JSON.stringify(calls));
    check('first id is p1-0', ids[0] === 'p1-0', ids[0]);
    check('last id is p3-2',  ids[12] === 'p3-2', ids[12]);
  }

  console.log('\nTest 5: getAllBlockIds — empty doc returns []');
  {
    const stub = async () => ({ docs: [{ blocks: [] }] });
    const ids = await getAllBlockIds('empty-doc', { gqlFn: stub, batchSize: 100 });
    check('returns []', Array.isArray(ids) && ids.length === 0, JSON.stringify(ids));
  }

  console.log('\nTest 6: getAllBlockIds — defensive on malformed response (docs is [])');
  {
    const stub = async () => ({ docs: [] });
    const ids = await getAllBlockIds('missing-doc', { gqlFn: stub, batchSize: 100 });
    check('returns [] (no crash)', Array.isArray(ids) && ids.length === 0, JSON.stringify(ids));
  }

  console.log('\nTest 7: deleteBlocks — calls gqlFn once per block ID (sequential)');
  {
    const calls = [];
    const stub = async (q, vars) => { calls.push(vars.blockId); return { delete_doc_block: { id: vars.blockId } }; };
    const out = await deleteBlocks(['b1', 'b2', 'b3'], { gqlFn: stub, sleep: async () => {}, logger: silentLogger });
    check('3 gqlFn calls', calls.length === 3, JSON.stringify(calls));
    check('called in order',
      JSON.stringify(calls) === JSON.stringify(['b1', 'b2', 'b3']),
      JSON.stringify(calls));
    check('deleted = 3', out.deleted === 3, JSON.stringify(out));
    check('errors empty', out.errors.length === 0, JSON.stringify(out));
  }

  console.log('\nTest 8: deleteBlocks — sleep called between calls (not after last)');
  {
    const sleepCalls = [];
    const stubGql = async () => ({});
    const stubSleep = async (ms) => { sleepCalls.push(ms); };
    await deleteBlocks(['b1', 'b2', 'b3'], { gqlFn: stubGql, sleep: stubSleep, rateLimitMs: 150, logger: silentLogger });
    check('sleep called 2 times (n-1 for 3 blocks)', sleepCalls.length === 2, `sleepCalls=${sleepCalls.length}`);
    check('sleep called with 150ms each', sleepCalls.every(ms => ms === 150), JSON.stringify(sleepCalls));
  }

  console.log('\nTest 9: deleteBlocks — empty input is a no-op (0 calls, 0 sleeps)');
  {
    let gqlCalls = 0, sleepCalls = 0;
    const out = await deleteBlocks([], {
      gqlFn: async () => { gqlCalls++; return {}; },
      sleep: async () => { sleepCalls++; },
      logger: silentLogger,
    });
    check('0 gqlFn calls', gqlCalls === 0, `gqlCalls=${gqlCalls}`);
    check('0 sleep calls', sleepCalls === 0, `sleepCalls=${sleepCalls}`);
    check('deleted = 0',   out.deleted === 0, JSON.stringify(out));
  }

  console.log('\nTest 10: deleteBlocks — per-block error captured, loop continues');
  {
    const stub = async (q, vars) => {
      if (vars.blockId === 'b2') throw new Error('synthetic gql error');
      return { delete_doc_block: { id: vars.blockId } };
    };
    const out = await deleteBlocks(['b1', 'b2', 'b3'], { gqlFn: stub, sleep: async () => {}, logger: silentLogger });
    check('deleted = 2 (b1 + b3)', out.deleted === 2, JSON.stringify(out));
    check('1 error captured',      out.errors.length === 1, JSON.stringify(out.errors));
    check('error references b2',   out.errors[0]?.blockId === 'b2', JSON.stringify(out.errors[0]));
    check('error message preserved', /synthetic gql error/.test(out.errors[0]?.error || ''), out.errors[0]?.error);
  }

  console.log('\nTest 11: deleteBlocks — dryRun skips all gqlFn calls AND all sleeps');
  {
    let gqlCalls = 0, sleepCalls = 0;
    const out = await deleteBlocks(['b1', 'b2', 'b3'], {
      gqlFn: async () => { gqlCalls++; return {}; },
      sleep: async () => { sleepCalls++; },
      dryRun: true,
      logger: silentLogger,
    });
    check('0 gqlFn calls under dryRun', gqlCalls === 0, `gqlCalls=${gqlCalls}`);
    check('0 sleep calls under dryRun', sleepCalls === 0, `sleepCalls=${sleepCalls}`);
    check('deleted = 0 under dryRun',   out.deleted === 0, JSON.stringify(out));
  }

  console.log('\nTest 12: addMarkdownToDoc — calls gqlFn with add_content_to_doc_from_markdown mutation');
  {
    let recordedQ, recordedVars;
    const stub = async (q, vars) => {
      recordedQ = q; recordedVars = vars;
      return { add_content_to_doc_from_markdown: { success: true, block_ids: ['n1', 'n2', 'n3'], error: null } };
    };
    const out = await addMarkdownToDoc('doc-1', '# Hello\n', { gqlFn: stub });
    check('called add_content_to_doc_from_markdown mutation',
      /add_content_to_doc_from_markdown/.test(recordedQ),
      recordedQ);
    check('docId variable passed', recordedVars?.docId === 'doc-1', JSON.stringify(recordedVars));
    check('markdown variable passed', recordedVars?.markdown === '# Hello\n', JSON.stringify(recordedVars));
    check('returns block_ids', JSON.stringify(out.blockIds) === JSON.stringify(['n1', 'n2', 'n3']), JSON.stringify(out));
  }

  console.log('\nTest 13: addMarkdownToDoc — throws when result.success === false');
  {
    const stub = async () => ({ add_content_to_doc_from_markdown: { success: false, block_ids: [], error: 'monday rejected the markdown' } });
    let threw = false;
    try {
      await addMarkdownToDoc('doc-1', '# Bad\n', { gqlFn: stub });
    } catch (e) {
      threw = /monday rejected/.test(e.message);
    }
    check('throws with monday error message included', threw === true, 'expected throw with error message');
  }

  console.log('\nTest 14: addMarkdownToDoc — gqlFn rejection propagates');
  {
    const stub = async () => { throw new Error('network down'); };
    let threw = false;
    try {
      await addMarkdownToDoc('doc-1', 'x', { gqlFn: stub });
    } catch (e) {
      threw = /network down/.test(e.message);
    }
    check('rejection propagates as throw', threw === true, 'expected throw');
  }

  console.log('\nTest 15: saveMarkdownToDisk — writes to logs/capacity-view-<date>.md and returns path');
  {
    const fakeFs = makeFakeFs();
    const fixedDate = () => new Date('2026-05-26T14:32:00');
    const file = saveMarkdownToDisk('# content\n', { fsImpl: fakeFs.fs, logsDir: '/fake/logs', now: fixedDate });
    check('returned path is dated', /capacity-view-2026-05-26\.md$/.test(file), file);
    check('writes recorded',        Object.keys(fakeFs.writes).length === 1, JSON.stringify(Object.keys(fakeFs.writes)));
    check('content matches input',  fakeFs.writes[file] === '# content\n', fakeFs.writes[file]);
  }

  console.log('\nTest 16: saveMarkdownToDisk — creates logs dir if missing');
  {
    const fakeFs = makeFakeFs();
    saveMarkdownToDisk('x', { fsImpl: fakeFs.fs, logsDir: '/fresh/logs', now: () => new Date('2026-05-26') });
    check('mkdirSync called for logsDir', fakeFs.existing.has('/fresh/logs'), JSON.stringify([...fakeFs.existing]));
  }

  console.log('\nTest 17: getDocIdByObjectId — resolves docs(object_ids: [..]) → docs[0].id');
  {
    const stub = async (q, vars) => {
      // Verify the query targets docs(object_ids: $oid)
      return { docs: [{ id: '42303072', object_id: '18414773242' }] };
    };
    const id = await getDocIdByObjectId(18414773242, { gqlFn: stub });
    check('returned internal docId', id === '42303072', `got ${id}`);
  }

  console.log('\nTest 18: getDocIdByObjectId — throws when no doc found');
  {
    const stub = async () => ({ docs: [] });
    let threw = false;
    try { await getDocIdByObjectId(99999, { gqlFn: stub }); } catch (e) { threw = /no doc|not found|99999/i.test(e.message); }
    check('throws with object_id in message', threw === true, 'expected throw');
  }

  console.log('\nTest 19: replaceCapacityViewBody — orchestration order (getDocId → read → save md → delete → add)');
  {
    const callLog = [];
    let pageCounter = 0;
    const stubGql = async (q, vars) => {
      if (/docs\(object_ids/.test(q))          { callLog.push('getDocId');     return { docs: [{ id: 'd1', object_id: String(vars.oid?.[0] || '') }] }; }
      if (/blocks\(page:/.test(q) || /docs.*blocks/.test(q)) {
        pageCounter++;
        if (pageCounter === 1) return { docs: [{ blocks: [{ id: 'old-1' }, { id: 'old-2' }] }] };
        return { docs: [{ blocks: [] }] };
      }
      if (/delete_doc_block/.test(q))           { callLog.push(`delete:${vars.blockId}`); return {}; }
      if (/add_content_to_doc_from_markdown/.test(q)) { callLog.push('add');               return { add_content_to_doc_from_markdown: { success: true, block_ids: ['new-1'], error: null } }; }
      return {};
    };
    const wraps = (label) => async (...args) => { callLog.push(label); return stubGql(...args); };
    // Wrap getDocId in callLog manually since we want to track it
    const fakeFs = makeFakeFs();
    const out = await replaceCapacityViewBody(18414773242, '# fresh md\n', {
      gqlFn: async (q, vars) => {
        if (/docs\(object_ids/.test(q))          { callLog.push('getDocId');     return { docs: [{ id: 'd1', object_id: String(vars.oid?.[0] || '') }] }; }
        if (/blocks\(page:/.test(q)) {
          pageCounter++;
          if (pageCounter === 1) {
            callLog.push('readBlocksP1');
            return { docs: [{ blocks: [{ id: 'old-1' }, { id: 'old-2' }] }] };
          }
          callLog.push('readBlocksP2');
          return { docs: [{ blocks: [] }] };
        }
        if (/delete_doc_block/.test(q))           { callLog.push(`delete:${vars.blockId}`); return {}; }
        if (/add_content_to_doc_from_markdown/.test(q)) { callLog.push('addMarkdown');     return { add_content_to_doc_from_markdown: { success: true, block_ids: ['new-1', 'new-2'], error: null } }; }
        return {};
      },
      sleepFn: async () => {},
      fs: fakeFs.fs,
      logger: silentLogger,
      now: () => new Date('2026-05-26'),
    });
    check('getDocId fired first', callLog[0] === 'getDocId', JSON.stringify(callLog));
    check('readBlocks before deletes', callLog.indexOf('readBlocksP1') < callLog.indexOf('delete:old-1'), JSON.stringify(callLog));
    check('delete:old-1 before delete:old-2', callLog.indexOf('delete:old-1') < callLog.indexOf('delete:old-2'), JSON.stringify(callLog));
    check('addMarkdown after deletes', callLog.indexOf('delete:old-2') < callLog.indexOf('addMarkdown'), JSON.stringify(callLog));
    check('markdown saved to disk before delete fires',
      Object.keys(fakeFs.writes).length > 0,
      'expected markdown saved to disk');
    check('summary fields populated',
      out.blocksRead === 2 && out.blocksDeleted === 2 && out.blockIdsAdded?.length === 2 && out.dryRun === false,
      JSON.stringify(out));
  }

  console.log('\nTest 20: replaceCapacityViewBody — dryRun: read + save md + return early (no delete, no add)');
  {
    const callLog = [];
    const fakeFs = makeFakeFs();
    const out = await replaceCapacityViewBody(18414773242, '# preview\n', {
      gqlFn: async (q, vars) => {
        if (/docs\(object_ids/.test(q))     { callLog.push('getDocId'); return { docs: [{ id: 'd1', object_id: String(vars.oid?.[0] || '') }] }; }
        if (/blocks\(page:/.test(q))        { callLog.push('readBlocks'); return { docs: [{ blocks: [{ id: 'b1' }, { id: 'b2' }] }] }; }
        if (/delete_doc_block/.test(q))     { callLog.push('UNEXPECTED_DELETE'); return {}; }
        if (/add_content/.test(q))           { callLog.push('UNEXPECTED_ADD'); return {}; }
        return {};
      },
      sleepFn: async () => {},
      fs: fakeFs.fs,
      logger: silentLogger,
      now: () => new Date('2026-05-26'),
      dryRun: true,
    });
    check('getDocId fired', callLog.includes('getDocId'), JSON.stringify(callLog));
    check('readBlocks fired', callLog.includes('readBlocks'), JSON.stringify(callLog));
    check('NO delete calls under dryRun', !callLog.includes('UNEXPECTED_DELETE'), JSON.stringify(callLog));
    check('NO add call under dryRun',     !callLog.includes('UNEXPECTED_ADD'), JSON.stringify(callLog));
    check('markdown still saved to disk under dryRun (E1)',
      Object.keys(fakeFs.writes).length > 0,
      'E1: dryRun should still save markdown');
    check('out.dryRun === true',          out.dryRun === true, JSON.stringify(out));
    check('out.blocksDeleted === 0',      out.blocksDeleted === 0, JSON.stringify(out));
    check('out.blockIdsAdded === []',     Array.isArray(out.blockIdsAdded) && out.blockIdsAdded.length === 0, JSON.stringify(out));
  }

  console.log('\nTest 21: replaceCapacityViewBody — add failure surfaces fallback path in error');
  {
    const fakeFs = makeFakeFs();
    let threw = false;
    let errMsg = '';
    try {
      await replaceCapacityViewBody(18414773242, '# md\n', {
        gqlFn: async (q, vars) => {
          if (/docs\(object_ids/.test(q))           return { docs: [{ id: 'd1', object_id: '18414773242' }] };
          if (/blocks\(page:/.test(q))              return { docs: [{ blocks: [{ id: 'b1' }] }] };
          if (/delete_doc_block/.test(q))           return {};
          if (/add_content_to_doc_from_markdown/.test(q)) {
            return { add_content_to_doc_from_markdown: { success: false, block_ids: [], error: 'monday API error' } };
          }
        },
        sleepFn: async () => {},
        fs: fakeFs.fs,
        logger: silentLogger,
        now: () => new Date('2026-05-26'),
      });
    } catch (e) {
      threw = true;
      errMsg = e.message;
    }
    check('throws when add fails', threw === true, 'expected throw');
    check('error references monday API error', /monday API error/.test(errMsg), errMsg);
    check('markdown still on disk for recovery',
      Object.keys(fakeFs.writes).length > 0,
      'recovery artifact should be preserved');
  }

  console.log('\nTest 22: replaceCapacityViewBody — savedMarkdownPath in return value points at the disk artifact');
  {
    const fakeFs = makeFakeFs();
    const out = await replaceCapacityViewBody(18414773242, '# md\n', {
      gqlFn: async (q, vars) => {
        if (/docs\(object_ids/.test(q))           return { docs: [{ id: 'd1', object_id: '18414773242' }] };
        if (/blocks\(page:/.test(q))              return { docs: [{ blocks: [] }] };
        if (/add_content/.test(q))                return { add_content_to_doc_from_markdown: { success: true, block_ids: [], error: null } };
        return {};
      },
      sleepFn: async () => {},
      fs: fakeFs.fs,
      logger: silentLogger,
      // Noon local — safe across timezones. Bare '2026-05-26' parses as
      // UTC midnight, which is the 25th in any negative-UTC-offset locale.
      now: () => new Date('2026-05-26T12:00:00'),
    });
    check('savedMarkdownPath returned', typeof out.savedMarkdownPath === 'string' && /capacity-view-2026-05-26\.md$/.test(out.savedMarkdownPath),
      out.savedMarkdownPath);
    check('savedMarkdownPath matches an actual write', fakeFs.writes[out.savedMarkdownPath] === '# md\n',
      `path=${out.savedMarkdownPath}, writes=${Object.keys(fakeFs.writes)}`);
  }

  // ==========================================================================
  // C4-followup Item A: cascade-delete skip (getAllBlockIds filters children)
  // ==========================================================================
  //
  // monday's delete_doc_block cascade-deletes children when a parent is
  // deleted (table cells inside a table parent, layout cells inside a
  // layout, notice_box children). Pre-followup, getAllBlockIds returned
  // every block ID; the writer then attempted N deletes that 404'd after
  // their parents already cascaded. 5/25 first regen: 485 cascade-noise
  // errors out of 1027 blocks read.
  //
  // Fix: read parent_block_id alongside id; filter to top-level blocks
  // (parent_block_id null/undefined) so we never fire pointless deletes.

  console.log('\nTest 23: Item A — getAllBlockIds filters out children (parent_block_id set), keeps only top-level');
  {
    const stub = async () => ({
      docs: [{ blocks: [
        { id: 't1', parent_block_id: null },        // table top-level
        { id: 'c1', parent_block_id: 't1' },        // cell child — filter out
        { id: 'c2', parent_block_id: 't1' },        // cell child — filter out
        { id: 'h1', parent_block_id: null },        // top-level heading
        { id: 'd1', parent_block_id: null },        // top-level divider
        { id: 'nb1', parent_block_id: null },       // notice_box top-level
        { id: 'nb-child', parent_block_id: 'nb1' }, // notice_box child — filter out
      ]}],
    });
    const ids = await getAllBlockIds('doc-1', { gqlFn: stub, batchSize: 100 });
    check('returned only top-level IDs',
      JSON.stringify(ids) === JSON.stringify(['t1', 'h1', 'd1', 'nb1']),
      JSON.stringify(ids));
    check('child IDs (c1, c2, nb-child) excluded',
      !ids.includes('c1') && !ids.includes('c2') && !ids.includes('nb-child'),
      JSON.stringify(ids));
  }

  console.log('\nTest 24: Item A — pagination uses RAW blocks.length (batchSize check), NOT filtered count');
  {
    // Page 1: batch of 100 blocks of which 80 are children (only 20 top-level).
    // raw length 100 === batchSize → must paginate to page 2.
    // Page 2: 50 blocks of which 30 top-level → raw length 50 < batchSize → stop.
    const calls = [];
    const stub = async (_q, vars) => {
      calls.push(vars.page);
      if (vars.page === 1) {
        const blocks = [];
        for (let i = 0; i < 20; i++) blocks.push({ id: `top-p1-${i}`, parent_block_id: null });
        for (let i = 0; i < 80; i++) blocks.push({ id: `child-p1-${i}`, parent_block_id: 'parent-x' });
        return { docs: [{ blocks }] };
      }
      const blocks = [];
      for (let i = 0; i < 30; i++) blocks.push({ id: `top-p2-${i}`, parent_block_id: null });
      for (let i = 0; i < 20; i++) blocks.push({ id: `child-p2-${i}`, parent_block_id: 'parent-y' });
      return { docs: [{ blocks }] };
    };
    const ids = await getAllBlockIds('doc-pag', { gqlFn: stub, batchSize: 100 });
    check('paginated to page 2 (raw page-1 length 100 === batchSize triggers next page)',
      JSON.stringify(calls) === JSON.stringify([1, 2]),
      JSON.stringify(calls));
    check('stopped after page 2 (raw page-2 length 50 < batchSize)', calls.length === 2,
      JSON.stringify(calls));
    check('returned 50 top-level IDs (20 from p1 + 30 from p2)',
      ids.length === 50, `len=${ids.length}`);
  }

  // ==========================================================================
  // C4-followup Item B: chunkMarkdownAtDividers + addMarkdownToDocChunked
  // ==========================================================================
  //
  // monday's add_content_to_doc_from_markdown has an undocumented per-call
  // block-count limit (somewhere around 500-600 blocks). Full 8-week C3
  // output produces ~720+ blocks and returns INTERNAL_SERVER_ERROR
  // (5/25 first live regen). Mitigation: split markdown at `---` divider
  // boundaries before calling, one chunk per call, sequential.
  //
  // chunkMarkdownAtDividers is a pure helper; addMarkdownToDocChunked
  // wraps the per-chunk add_content call.

  console.log('\nTest 25: Item B — chunkMarkdownAtDividers empty/null input → []');
  {
    check('null → []',      Array.isArray(chunkMarkdownAtDividers(null)) && chunkMarkdownAtDividers(null).length === 0, JSON.stringify(chunkMarkdownAtDividers(null)));
    check('undefined → []', Array.isArray(chunkMarkdownAtDividers()) && chunkMarkdownAtDividers().length === 0, JSON.stringify(chunkMarkdownAtDividers()));
    check('"" → []',        Array.isArray(chunkMarkdownAtDividers('')) && chunkMarkdownAtDividers('').length === 0, JSON.stringify(chunkMarkdownAtDividers('')));
  }

  console.log('\nTest 26: Item B — no dividers → single chunk equal to input');
  {
    const md = '# Just text\n\nNo dividers here.\n';
    const chunks = chunkMarkdownAtDividers(md);
    check('1 chunk', chunks.length === 1, JSON.stringify(chunks));
    check('chunk equals input', chunks[0] === md, JSON.stringify(chunks));
  }

  console.log('\nTest 27: Item B — single divider mid-stream → 2 chunks, first chunk includes the divider');
  {
    const md = 'A\n---\nB';
    const chunks = chunkMarkdownAtDividers(md);
    check('2 chunks',                 chunks.length === 2,                              JSON.stringify(chunks));
    check('first chunk includes ---', chunks[0] === 'A\n---',                            JSON.stringify(chunks));
    check('second chunk is "B"',      chunks[1] === 'B',                                 JSON.stringify(chunks));
  }

  console.log('\nTest 28: Item B — trailing divider does not produce empty chunk');
  {
    const md = 'A\n---\nB\n---\n';
    const chunks = chunkMarkdownAtDividers(md);
    check('2 chunks (no empty trailing)', chunks.length === 2, JSON.stringify(chunks));
    check('first chunk includes its ---',  /---$/.test(chunks[0]), JSON.stringify(chunks));
    check('second chunk includes its ---', /---\n?$/.test(chunks[1]), JSON.stringify(chunks));
  }

  console.log('\nTest 29: Item B — C3-shape (10 sections) → 10 chunks');
  {
    // Simulate the real C3 output: header --- (8 week sections each ending with ---) Legend
    const md = [
      '**Generated:** ... • **Source:** ... • **Edit:** ...',
      '',
      '---',
      '## Week of 5/25 — 50.00 crew hrs',
      '...table + priority...',
      '---',
      '## Week of 6/1 — 30.00 crew hrs',
      '...content...',
      '---',
      '## Week of 6/8 — 0.00 crew hrs',
      '...content...',
      '---',
      '## Week of 6/15 — 0.00 crew hrs',
      '...content...',
      '---',
      '## Week of 6/22 — 0.00 crew hrs',
      '...content...',
      '---',
      '## Week of 6/29 — 0.00 crew hrs',
      '...content...',
      '---',
      '## Week of 7/6 — 0.00 crew hrs',
      '...content...',
      '---',
      '## Week of 7/13 — 0.00 crew hrs',
      '...content...',
      '---',
      '## Legend',
      '- ...legend body...',
      '',
    ].join('\n');
    const chunks = chunkMarkdownAtDividers(md);
    check('produces 10 chunks (header + 8 weeks + legend)',
      chunks.length === 10,
      `chunks.length=${chunks.length}: ${chunks.map(c => c.split('\n')[0]).join(' | ')}`);
    check('each chunk except the last ends with ---',
      chunks.slice(0, -1).every(c => /---$/.test(c)),
      'all middle chunks should end with their divider');
    check('last chunk (legend) does not need trailing ---',
      chunks[chunks.length - 1].includes('Legend'),
      `last: ${chunks[chunks.length - 1].slice(0, 50)}`);
  }

  console.log('\nTest 30: Item B — addMarkdownToDocChunked: single-chunk markdown → 1 gqlFn call');
  {
    const md = '# small\n\nno dividers\n';
    const calls = [];
    const stub = async (q, vars) => {
      calls.push(vars.markdown);
      return { add_content_to_doc_from_markdown: { success: true, block_ids: ['b1', 'b2'], error: null } };
    };
    const out = await addMarkdownToDocChunked('doc-1', md, { gqlFn: stub, sleep: async () => {}, logger: silentLogger });
    check('1 gqlFn call', calls.length === 1, `calls=${calls.length}`);
    check('chunkCount === 1', out.chunkCount === 1, JSON.stringify(out));
    check('aggregated 2 block_ids', out.blockIds.length === 2 && out.blockIds[0] === 'b1',
      JSON.stringify(out.blockIds));
  }

  console.log('\nTest 31: Item B — addMarkdownToDocChunked: 3 chunks → 3 sequential gqlFn calls, block_ids aggregated');
  {
    const md = 'A\n---\nB\n---\nC';
    const calls = [];
    const stub = async (q, vars) => {
      calls.push(vars.markdown);
      const idx = calls.length;
      return { add_content_to_doc_from_markdown: { success: true, block_ids: [`b${idx}-1`, `b${idx}-2`], error: null } };
    };
    const out = await addMarkdownToDocChunked('doc-1', md, { gqlFn: stub, sleep: async () => {}, logger: silentLogger });
    check('3 gqlFn calls in sequence', calls.length === 3, JSON.stringify(calls.map(c => c.slice(0, 20))));
    check('first call sees chunk 1',   calls[0].includes('A'),  calls[0]);
    check('second call sees chunk 2',  calls[1].includes('B'),  calls[1]);
    check('third call sees chunk 3',   calls[2].includes('C'),  calls[2]);
    check('aggregated 6 block_ids',    out.blockIds.length === 6, JSON.stringify(out.blockIds));
    check('chunkCount === 3',          out.chunkCount === 3, JSON.stringify(out));
  }

  console.log('\nTest 32: Item B — addMarkdownToDocChunked: rate-limit sleep between chunks (n-1 for n chunks)');
  {
    const md = 'A\n---\nB\n---\nC';
    const sleepCalls = [];
    const stub = async () => ({ add_content_to_doc_from_markdown: { success: true, block_ids: [], error: null } });
    await addMarkdownToDocChunked('doc-1', md, {
      gqlFn: stub,
      sleep: async (ms) => { sleepCalls.push(ms); },
      rateLimitMs: 150,
      logger: silentLogger,
    });
    check('sleep called 2 times (n-1 for 3 chunks)', sleepCalls.length === 2, `sleepCalls=${sleepCalls.length}`);
    check('each sleep is 150ms', sleepCalls.every(ms => ms === 150), JSON.stringify(sleepCalls));
  }

  console.log('\nTest 33: Item B — addMarkdownToDocChunked: per-chunk failure aborts; later chunks not fired');
  {
    const md = 'A\n---\nB\n---\nC\n---\nD\n---\nE';
    const calls = [];
    const stub = async (q, vars) => {
      calls.push(vars.markdown);
      if (calls.length === 3) throw new Error('Internal server error');
      return { add_content_to_doc_from_markdown: { success: true, block_ids: [`b${calls.length}`], error: null } };
    };
    let threw = false;
    let errMsg = '';
    try {
      await addMarkdownToDocChunked('doc-1', md, { gqlFn: stub, sleep: async () => {}, logger: silentLogger });
    } catch (e) {
      threw = true;
      errMsg = e.message;
    }
    check('throws on chunk failure', threw === true, 'expected throw');
    check('error message includes chunk index 3 / 5',
      /chunk 3.*\/\s*5|chunk 3 of 5/i.test(errMsg),
      errMsg);
    check('chunks 4 + 5 not fired (calls stopped at 3)', calls.length === 3, `calls=${calls.length}`);
  }

  // ==========================================================================
  // C4-followup Item C: integration smoke — buildCapacityViewDoc output IS
  // chunked by chunkMarkdownAtDividers. Regression catch: if C3 ever emits
  // a structure without `---` boundaries, this test fails.
  // ==========================================================================

  console.log('\nTest 34: Item C — integration smoke: buildCapacityViewDoc output produces multi-chunk via chunkMarkdownAtDividers');
  {
    const { buildCapacityViewDoc } = require('./capacity-view-generator.js');
    const plan = { placements: [], capacityGrid: {}, finishingCycleReport: { rows: [] } };
    const jobsById = { 'PL-A': { name: 'Test Job', delivery: '2026-06-12', status: 'Scheduled' } };
    const markdown = buildCapacityViewDoc(plan, jobsById, [], { generatedAt: new Date('2026-06-03T12:00:00') });
    const chunks = chunkMarkdownAtDividers(markdown);
    // 8 week sections each ending with ---, plus header divider, plus legend
    // → at minimum: 1 header + 8 weeks + 1 legend = 10 chunks
    check('C3 output produces 8+ chunks',
      chunks.length >= 8,
      `chunks=${chunks.length}, first lines: ${chunks.slice(0, 3).map(c => c.split('\n')[0]).join(' | ')}`);
    check('no chunk is empty', chunks.every(c => c.trim().length > 0), JSON.stringify(chunks.map(c => c.length)));
  }

  console.log('\nTest 35: REVIEW FIX — W2 artifact saved BEFORE any API call (save-first ordering)');
  {
    // Adversarial-review finding (2026-06-10, LOW): the artifact used to be
    // saved only after getDocIdByObjectId + getAllBlockIds succeeded, so a
    // read-phase failure left no artifact while run-planner's failure message
    // pointed operators at one. Save-first (the briefing writer's ordering)
    // makes the recovery message universally true.
    const writes = [];
    const fakeFs = {
      existsSync: () => true,
      mkdirSync: () => {},
      writeFileSync: (p, c) => writes.push(String(p)),
    };
    const failingGql = async () => { throw new Error('synthetic resolve failure'); };
    let threw = false;
    try {
      await replaceCapacityViewBody(18410103423, '# md\n', {
        gqlFn: failingGql, fs: fakeFs, logsDir: '/fake/logs',
        sleepFn: async () => {}, now: () => new Date(2026, 5, 13, 18, 0, 0),
        logger: { log: () => {} },
      });
    } catch (e) {
      threw = true;
    }
    check('throws on resolve failure', threw, '');
    check('artifact was saved before the failing API call',
      writes.some(p => /capacity-view-2026-06-13\.md$/.test(p)),
      JSON.stringify(writes));
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All C4 write-capacity-view tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
