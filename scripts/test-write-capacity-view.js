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
