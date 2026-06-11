#!/usr/bin/env node
/**
 * C7 — Weekly Briefing doc writer.
 *
 * write-weekly-briefing.js owns the briefing doc's lifecycle (plan doc §C C7
 * + §F.3, decided lean-(a): automatic creation):
 *
 *   - State file config/weekly-briefing-doc.json remembers { objectId, docId,
 *     url, createdAt } across runs. Lost state → a fresh doc is created (the
 *     orphan stays in monday for manual cleanup; acceptable Phase-1 cost).
 *   - First run: create_doc in workspace 11761515 / folder 20251829 (the
 *     Claude Handoffs folder, same home as the Capacity View), kind public.
 *     Verified live via introspection 2026-06-10: CreateDocWorkspaceInput =
 *     { workspace_id, name, kind, folder_id }, returns Document { id,
 *     object_id, url }. API-Version: next (same surface C4 already uses).
 *   - Subsequent runs: update_doc_name(docId, title) per D2 (single doc,
 *     name tracks the briefed week), then C4's delete-and-repopulate.
 *   - Recovery artifact logs/weekly-briefing-<date>.md saved BEFORE any
 *     mutation (W2 precedent), under dryRun too.
 *   - dryRun: zero mutations. Existing doc → read-only resolve + block count
 *     + "would" summary. No doc → "would create" summary.
 *
 * All monday I/O goes through injected gqlFn stubs here — no live calls.
 */

const path = require('path');
const {
  BRIEFING_STATE_FILE,
  BRIEFING_WORKSPACE_ID,
  BRIEFING_FOLDER_ID,
  loadBriefingDocState,
  saveBriefingDocState,
  ensureBriefingDoc,
  setDocName,
  writeWeeklyBriefing,
} = require('./write-weekly-briefing.js');
const { saveMarkdownToDisk } = require('./write-capacity-view.js');

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
  const writes = [];
  return {
    files, writes,
    fs: {
      existsSync: (p) => files.has(String(p)),
      mkdirSync: () => {},
      readFileSync: (p) => {
        if (!files.has(String(p))) throw new Error(`fake fs: no such file ${p}`);
        return files.get(String(p));
      },
      writeFileSync: (p, content) => {
        writes.push({ path: String(p), content });
        files.set(String(p), content);
      },
    },
  };
}

// gqlFn stub that routes on query text. `docExists` controls whether the
// docs() resolve query finds the doc. Captures every call.
function makeFakeGql({ docExists = true, blockPages = [[]], createdIds = { id: '99001', object_id: '18419999999', url: 'https://x/docs/18419999999' } } = {}) {
  const calls = [];
  let blockPageIdx = 0;
  const fn = async (query, variables) => {
    calls.push({ query, variables });
    if (/create_doc/.test(query)) {
      return { create_doc: { ...createdIds } };
    }
    if (/update_doc_name/.test(query)) {
      return { update_doc_name: true };
    }
    if (/delete_doc_block/.test(query)) {
      return { delete_doc_block: { id: variables.blockId } };
    }
    if (/add_content_to_doc_from_markdown/.test(query)) {
      return { add_content_to_doc_from_markdown: { success: true, block_ids: ['nb1', 'nb2'], error: null } };
    }
    if (/docs\s*\(/.test(query)) {
      if (!docExists) return { docs: [] };
      if (/blocks\s*\(/.test(query)) {
        const page = blockPages[Math.min(blockPageIdx, blockPages.length - 1)] || [];
        blockPageIdx++;
        return { docs: [{ blocks: page }] };
      }
      return { docs: [{ id: '88001', object_id: '18418888888' }] };
    }
    throw new Error(`fake gql: unrouted query: ${query.slice(0, 80)}`);
  };
  fn.calls = calls;
  return fn;
}

const silentLogger = { log: () => {} };

const STATE = JSON.stringify({ objectId: '18418888888', docId: '88001', url: 'https://x/docs/18418888888', createdAt: '2026-06-01' });

(async () => {

  console.log('Test 1: exports + constants');
  {
    check('writeWeeklyBriefing is a function', typeof writeWeeklyBriefing === 'function', `typeof=${typeof writeWeeklyBriefing}`);
    check('ensureBriefingDoc is a function', typeof ensureBriefingDoc === 'function', '');
    check('workspace id is 11761515', String(BRIEFING_WORKSPACE_ID) === '11761515', String(BRIEFING_WORKSPACE_ID));
    check('folder id is 20251829', String(BRIEFING_FOLDER_ID) === '20251829', String(BRIEFING_FOLDER_ID));
    check('state file default under config/', /config[\\\/]weekly-briefing-doc\.json$/.test(BRIEFING_STATE_FILE), BRIEFING_STATE_FILE);
  }

  console.log('\nTest 2: loadBriefingDocState — missing file → null, corrupt → null, valid → object');
  {
    const missing = makeFakeFs();
    check('missing → null', loadBriefingDocState({ fsImpl: missing.fs, stateFile: '/fake/state.json' }) === null, '');
    const corrupt = makeFakeFs({ '/fake/state.json': '{nope' });
    check('corrupt → null', loadBriefingDocState({ fsImpl: corrupt.fs, stateFile: '/fake/state.json' }) === null, '');
    const ok = makeFakeFs({ '/fake/state.json': STATE });
    const got = loadBriefingDocState({ fsImpl: ok.fs, stateFile: '/fake/state.json' });
    check('valid → parsed object', got?.docId === '88001' && got?.objectId === '18418888888', JSON.stringify(got));
  }

  console.log('\nTest 3: saveBriefingDocState — round-trips through the fs');
  {
    const f = makeFakeFs();
    saveBriefingDocState({ objectId: 'o', docId: 'd' }, { fsImpl: f.fs, stateFile: '/fake/dir/state.json' });
    check('write happened', f.writes.length === 1, JSON.stringify(f.writes));
    check('round-trip parse', JSON.parse(f.files.get('/fake/dir/state.json')).docId === 'd', '');
  }

  console.log('\nTest 4: ensureBriefingDoc — state present + doc resolves → reuse, no create');
  {
    const f = makeFakeFs({ '/fake/state.json': STATE });
    const gql = makeFakeGql({ docExists: true });
    const r = await ensureBriefingDoc({ gqlFn: gql, fsImpl: f.fs, stateFile: '/fake/state.json', title: 'T', logger: silentLogger });
    check('created === false', r.created === false, JSON.stringify(r));
    check('docId from resolve', r.docId === '88001', JSON.stringify(r));
    check('no create_doc call', !gql.calls.some(c => /create_doc/.test(c.query)), JSON.stringify(gql.calls.map(c => c.query.slice(0, 40))));
  }

  console.log('\nTest 5: ensureBriefingDoc — state present but doc gone → creates fresh + persists state');
  {
    const f = makeFakeFs({ '/fake/state.json': STATE });
    const gql = makeFakeGql({ docExists: false });
    const r = await ensureBriefingDoc({ gqlFn: gql, fsImpl: f.fs, stateFile: '/fake/state.json', title: 'New Title', logger: silentLogger });
    check('created === true', r.created === true, JSON.stringify(r));
    check('docId from create_doc response', r.docId === '99001', JSON.stringify(r));
    const create = gql.calls.find(c => /create_doc/.test(c.query));
    check('create_doc fired', !!create, '');
    const newState = JSON.parse(f.files.get('/fake/state.json'));
    check('state file updated with new ids', newState.docId === '99001' && newState.objectId === '18419999999', JSON.stringify(newState));
  }

  console.log('\nTest 6: ensureBriefingDoc — no state → create_doc carries workspace + folder + name + kind');
  {
    const f = makeFakeFs();
    const gql = makeFakeGql();
    const r = await ensureBriefingDoc({ gqlFn: gql, fsImpl: f.fs, stateFile: '/fake/state.json', title: '📋 HTW Weekly Briefing — Week of 2026-06-15', logger: silentLogger });
    check('created === true', r.created === true, JSON.stringify(r));
    const create = gql.calls.find(c => /create_doc/.test(c.query));
    const loc = create?.variables?.location;
    check('location.workspace.workspace_id = 11761515', String(loc?.workspace?.workspace_id) === '11761515', JSON.stringify(loc));
    check('location.workspace.folder_id = 20251829', String(loc?.workspace?.folder_id) === '20251829', JSON.stringify(loc));
    check('location.workspace.name = title', loc?.workspace?.name === '📋 HTW Weekly Briefing — Week of 2026-06-15', JSON.stringify(loc));
    check('location.workspace.kind set', typeof loc?.workspace?.kind === 'string' && loc.workspace.kind.length > 0, JSON.stringify(loc));
  }

  console.log('\nTest 7: ensureBriefingDoc — dryRun + no state → wouldCreate, ZERO gql calls');
  {
    const f = makeFakeFs();
    const gql = makeFakeGql();
    const r = await ensureBriefingDoc({ gqlFn: gql, fsImpl: f.fs, stateFile: '/fake/state.json', title: 'T', dryRun: true, logger: silentLogger });
    check('wouldCreate === true', r.wouldCreate === true, JSON.stringify(r));
    check('created === false', r.created === false, JSON.stringify(r));
    check('zero gql calls', gql.calls.length === 0, JSON.stringify(gql.calls.map(c => c.query.slice(0, 40))));
    check('state file untouched', f.writes.length === 0, JSON.stringify(f.writes));
  }

  console.log('\nTest 8: ensureBriefingDoc — dryRun + state present → read-only resolve, no create/persist');
  {
    const f = makeFakeFs({ '/fake/state.json': STATE });
    const gql = makeFakeGql({ docExists: true });
    const r = await ensureBriefingDoc({ gqlFn: gql, fsImpl: f.fs, stateFile: '/fake/state.json', title: 'T', dryRun: true, logger: silentLogger });
    check('resolved existing doc', r.docId === '88001' && r.created === false && !r.wouldCreate, JSON.stringify(r));
    check('only read queries fired', gql.calls.every(c => !/create_doc|update_doc_name|delete_doc_block|add_content/.test(c.query)), JSON.stringify(gql.calls.map(c => c.query.slice(0, 40))));
    check('state file untouched', f.writes.length === 0, '');
  }

  console.log('\nTest 9: setDocName — update_doc_name mutation with docId + name variables');
  {
    const gql = makeFakeGql();
    await setDocName('88001', 'New Name', { gqlFn: gql });
    const call = gql.calls.find(c => /update_doc_name/.test(c.query));
    check('mutation fired', !!call, '');
    check('variables carry docId + name', String(call?.variables?.docId) === '88001' && call?.variables?.name === 'New Name', JSON.stringify(call?.variables));
  }

  console.log('\nTest 10: saveMarkdownToDisk filePrefix opt → weekly-briefing-<date>.md artifact');
  {
    const f = makeFakeFs();
    const file = saveMarkdownToDisk('# md', {
      fsImpl: f.fs, logsDir: '/fake/logs',
      now: () => new Date(2026, 5, 13, 18, 0, 0),
      filePrefix: 'weekly-briefing',
    });
    check('filename is weekly-briefing-2026-06-13.md', /weekly-briefing-2026-06-13\.md$/.test(file), file);
    const fileDefault = saveMarkdownToDisk('# md', {
      fsImpl: f.fs, logsDir: '/fake/logs',
      now: () => new Date(2026, 5, 13, 18, 0, 0),
    });
    check('default prefix unchanged (capacity-view)', /capacity-view-2026-06-13\.md$/.test(fileDefault), fileDefault);
  }

  console.log('\nTest 11: writeWeeklyBriefing — live run, existing doc: artifact → rename → read → delete → add, in order');
  {
    const f = makeFakeFs({ '/fake/state.json': STATE });
    const gql = makeFakeGql({
      docExists: true,
      blockPages: [[{ id: 'b1', parent_block_id: null }, { id: 'b2', parent_block_id: null }, { id: 'kid', parent_block_id: 'b1' }]],
    });
    const r = await writeWeeklyBriefing(
      { title: '📋 HTW Weekly Briefing — Week of 2026-06-15', markdown: '# hello\n\n---\n' },
      { gqlFn: gql, fs: f.fs, stateFile: '/fake/state.json', logsDir: '/fake/logs',
        sleepFn: async () => {}, now: () => new Date(2026, 5, 13, 18, 0, 0), logger: silentLogger });

    check('result.created === false', r.created === false, JSON.stringify(r));
    check('renamed === true', r.renamed === true, JSON.stringify(r));
    check('blocksRead = 2 (child excluded)', r.blocksRead === 2, JSON.stringify(r));
    check('blocksDeleted = 2', r.blocksDeleted === 2, JSON.stringify(r));
    check('blocks added', r.blockIdsAdded.length === 2, JSON.stringify(r));
    check('artifact saved to logs/weekly-briefing-2026-06-13.md', /weekly-briefing-2026-06-13\.md$/.test(r.savedMarkdownPath || ''), r.savedMarkdownPath);

    const kinds = gql.calls.map(c =>
      /update_doc_name/.test(c.query) ? 'rename'
      : /delete_doc_block/.test(c.query) ? 'delete'
      : /add_content/.test(c.query) ? 'add'
      : /blocks\s*\(/.test(c.query) ? 'readBlocks'
      : 'resolve');
    const firstRename = kinds.indexOf('rename');
    const firstDelete = kinds.indexOf('delete');
    const firstAdd = kinds.indexOf('add');
    check('rename precedes deletes precedes add', firstRename !== -1 && firstDelete !== -1 && firstAdd !== -1 && firstRename < firstDelete && firstDelete < firstAdd, JSON.stringify(kinds));
    const artifactWrite = f.writes.find(w => /weekly-briefing-2026-06-13\.md$/.test(w.path));
    check('artifact written', !!artifactWrite, JSON.stringify(f.writes.map(w => w.path)));
  }

  console.log('\nTest 12: writeWeeklyBriefing — live first run (no state): create, NO rename, add content');
  {
    const f = makeFakeFs();
    const gql = makeFakeGql({ blockPages: [[]] });
    const r = await writeWeeklyBriefing(
      { title: 'T', markdown: '# hello\n' },
      { gqlFn: gql, fs: f.fs, stateFile: '/fake/state.json', logsDir: '/fake/logs',
        sleepFn: async () => {}, now: () => new Date(2026, 5, 13, 18, 0, 0), logger: silentLogger });
    check('created === true', r.created === true, JSON.stringify(r));
    check('no rename on fresh create (name already = title)', r.renamed === false && !gql.calls.some(c => /update_doc_name/.test(c.query)), JSON.stringify(r));
    check('content added', r.blockIdsAdded.length === 2, JSON.stringify(r));
    check('state persisted', f.files.has('/fake/state.json'), '');
  }

  console.log('\nTest 13: writeWeeklyBriefing — dryRun with existing doc: zero mutations, would-summary');
  {
    const f = makeFakeFs({ '/fake/state.json': STATE });
    const gql = makeFakeGql({
      docExists: true,
      blockPages: [[{ id: 'b1', parent_block_id: null }]],
    });
    const r = await writeWeeklyBriefing(
      { title: 'T', markdown: '# hello\n' },
      { gqlFn: gql, fs: f.fs, stateFile: '/fake/state.json', logsDir: '/fake/logs',
        sleepFn: async () => {}, now: () => new Date(2026, 5, 13, 18, 0, 0), logger: silentLogger, dryRun: true });
    check('dryRun echoed', r.dryRun === true, JSON.stringify(r));
    check('blocksRead = 1, blocksDeleted = 0', r.blocksRead === 1 && r.blocksDeleted === 0, JSON.stringify(r));
    check('no mutation queries fired', gql.calls.every(c => !/create_doc|update_doc_name|delete_doc_block|add_content/.test(c.query)), JSON.stringify(gql.calls.map(c => c.query.slice(0, 40))));
    check('artifact still saved (W2 under dryRun)', /weekly-briefing-2026-06-13\.md$/.test(r.savedMarkdownPath || ''), r.savedMarkdownPath);
  }

  console.log('\nTest 14: writeWeeklyBriefing — dryRun with no doc: would-create, zero gql calls');
  {
    const f = makeFakeFs();
    const gql = makeFakeGql();
    const r = await writeWeeklyBriefing(
      { title: 'T', markdown: '# hello\n' },
      { gqlFn: gql, fs: f.fs, stateFile: '/fake/state.json', logsDir: '/fake/logs',
        sleepFn: async () => {}, now: () => new Date(2026, 5, 13, 18, 0, 0), logger: silentLogger, dryRun: true });
    check('wouldCreate === true', r.wouldCreate === true, JSON.stringify(r));
    check('zero gql calls', gql.calls.length === 0, JSON.stringify(gql.calls.map(c => c.query.slice(0, 40))));
    check('artifact still saved', /weekly-briefing-2026-06-13\.md$/.test(r.savedMarkdownPath || ''), r.savedMarkdownPath);
  }

  console.log('\nTest 15: writeWeeklyBriefing — add failure surfaces fallback path and rethrows');
  {
    const f = makeFakeFs({ '/fake/state.json': STATE });
    const gql = makeFakeGql({ docExists: true, blockPages: [[{ id: 'b1', parent_block_id: null }]] });
    const origFn = gql; // wrap: fail the add call only
    const failingGql = async (q, v) => {
      if (/add_content_to_doc_from_markdown/.test(q)) throw new Error('synthetic add failure');
      return origFn(q, v);
    };
    const logLines = [];
    let threw = false;
    try {
      await writeWeeklyBriefing(
        { title: 'T', markdown: '# hello\n' },
        { gqlFn: failingGql, fs: f.fs, stateFile: '/fake/state.json', logsDir: '/fake/logs',
          sleepFn: async () => {}, now: () => new Date(2026, 5, 13, 18, 0, 0),
          logger: { log: (...a) => logLines.push(a.join(' ')) } });
    } catch (e) {
      threw = true;
    }
    check('throws on add failure', threw, '');
    check('fallback message mentions saved artifact path', logLines.some(l => /weekly-briefing-2026-06-13\.md/.test(l)), JSON.stringify(logLines.slice(-4)));
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All C7 write-weekly-briefing tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
