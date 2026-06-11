#!/usr/bin/env node
// C7 — Weekly Briefing doc writer.
//
// Side-effectful sibling of write-capacity-view.js. Owns the briefing doc's
// lifecycle per plan doc §C C7 + §F.3 (decided lean-(a): automatic creation):
//
//   - State file config/weekly-briefing-doc.json remembers { objectId, docId,
//     url, createdAt } across runs. If the state file is lost or the doc was
//     deleted in monday, a fresh doc is created and the state re-persisted
//     (an orphaned old doc stays in monday for manual cleanup — acceptable
//     Phase-1 cost, noted in the plan doc).
//   - First run: create_doc in workspace 11761515 (Project Management),
//     folder 20251829 (Claude Handoffs — same home as the Capacity View),
//     kind public (matches the Capacity View's doc_kind). Signature verified
//     live via introspection 2026-06-10 on API-Version 'next':
//       create_doc(location: { workspace: { workspace_id, name, kind,
//       folder_id } }) → Document { id object_id url }
//   - Subsequent runs: update_doc_name(docId, title) keeps the single doc's
//     name tracking the briefed week (D2: one doc, overwritten each run),
//     then C4's delete-and-repopulate replaces the body.
//   - Recovery artifact logs/weekly-briefing-<date>.md is saved BEFORE any
//     mutation fires (W2 precedent), under dryRun too.
//   - dryRun: zero mutations. Existing doc → read-only resolve + block count
//     + "would" summary. No doc → "would create" summary (zero API calls).
//
// Reuses C4's exported plumbing: defaultGql, getDocIdByObjectId,
// getAllBlockIds, deleteBlocks, addMarkdownToDocChunked, saveMarkdownToDisk.

const fs = require('fs');
const path = require('path');
const {
  defaultGql,
  getDocIdByObjectId,
  getAllBlockIds,
  deleteBlocks,
  addMarkdownToDocChunked,
  saveMarkdownToDisk,
  RATE_LIMIT_MS,
} = require('./write-capacity-view.js');

const BRIEFING_WORKSPACE_ID = 11761515;   // Project Management
const BRIEFING_FOLDER_ID = 20251829;      // Claude Handoffs folder
const BRIEFING_DOC_KIND = 'public';       // matches Capacity View doc_kind
const BRIEFING_STATE_FILE = path.join(__dirname, '..', 'config', 'weekly-briefing-doc.json');

// Reads the persisted doc identity. Missing or corrupt file → null (the
// caller treats both as "no doc yet").
function loadBriefingDocState({ fsImpl = fs, stateFile = BRIEFING_STATE_FILE } = {}) {
  try {
    if (!fsImpl.existsSync(stateFile)) return null;
    const parsed = JSON.parse(fsImpl.readFileSync(stateFile, 'utf8'));
    if (!parsed || !parsed.objectId || !parsed.docId) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function saveBriefingDocState(state, { fsImpl = fs, stateFile = BRIEFING_STATE_FILE } = {}) {
  const dir = path.dirname(stateFile);
  if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
}

// update_doc_name(docId: ID!, name: String!) — verified via introspection
// 2026-06-10 (API-Version 'next').
async function setDocName(docId, name, { gqlFn = defaultGql } = {}) {
  const q = 'mutation ($docId: ID!, $name: String!) { update_doc_name(docId: $docId, name: $name) }';
  await gqlFn(q, { docId: String(docId), name });
}

// Resolve-or-create. Returns:
//   { docId, objectId, created, wouldCreate? }
// dryRun: never mutates, never persists. With state → read-only resolve
// (stale state + dryRun also reports wouldCreate). Without state →
// { wouldCreate: true } with zero API calls.
async function ensureBriefingDoc({
  gqlFn = defaultGql,
  fsImpl = fs,
  stateFile = BRIEFING_STATE_FILE,
  title,
  dryRun = false,
  logger = console,
} = {}) {
  const state = loadBriefingDocState({ fsImpl, stateFile });

  if (state) {
    try {
      const docId = await getDocIdByObjectId(state.objectId, { gqlFn });
      return { docId, objectId: state.objectId, created: false };
    } catch (e) {
      // REVIEW FIX (2026-06-10): only the deliberate "doc genuinely absent"
      // signal may fall through to create-fresh. getDocIdByObjectId throws
      // 'No doc found for object_id …' when the query SUCCEEDS with zero
      // docs; every other throw (rate-limit/complexity GraphQL errors, 5xx,
      // network) is transient — rethrowing lets run-planner's per-writer
      // failure policy surface it instead of silently creating a duplicate
      // doc and repointing the state file at it.
      if (!/^No doc found for object_id/.test(e.message || '')) throw e;
      logger.log(`  Briefing doc object_id ${state.objectId} no longer exists (${e.message}) — will create fresh.`);
    }
  }

  if (dryRun) {
    logger.log(`  [DRY RUN] would create briefing doc "${title}" in workspace ${BRIEFING_WORKSPACE_ID} / folder ${BRIEFING_FOLDER_ID}.`);
    return { docId: null, objectId: null, created: false, wouldCreate: true };
  }

  const q = `mutation ($location: CreateDocInput!) {
    create_doc(location: $location) { id object_id url }
  }`;
  const r = await gqlFn(q, {
    location: {
      workspace: {
        workspace_id: String(BRIEFING_WORKSPACE_ID),
        folder_id: String(BRIEFING_FOLDER_ID),
        name: title,
        kind: BRIEFING_DOC_KIND,
      },
    },
  });
  const doc = r && r.create_doc;
  if (!doc || !doc.id) {
    throw new Error(`create_doc returned no document: ${JSON.stringify(r).slice(0, 200)}`);
  }
  const newState = {
    objectId: String(doc.object_id),
    docId: String(doc.id),
    url: doc.url || null,
    createdAt: new Date().toISOString().slice(0, 10),
  };
  saveBriefingDocState(newState, { fsImpl, stateFile });
  logger.log(`  Created briefing doc ${newState.objectId} (docId ${newState.docId}); state persisted to ${stateFile}.`);
  return { docId: newState.docId, objectId: newState.objectId, created: true };
}

// Orchestrator. Mirrors replaceCapacityViewBody's shape and failure handling:
// artifact saved before mutations; add failure surfaces the artifact path as
// the recovery fallback and rethrows.
//
// Returns { docId, objectId, created, renamed, wouldCreate?, blocksRead,
//           blocksDeleted, deleteErrors, blockIdsAdded, dryRun,
//           savedMarkdownPath }.
async function writeWeeklyBriefing({ title, markdown }, opts = {}) {
  const _gqlFn     = opts.gqlFn     || defaultGql;
  const _sleep     = opts.sleepFn   || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const _fs        = opts.fs        || fs;
  const _logger    = opts.logger    || console;
  const _now       = opts.now       || (() => new Date());
  const _logsDir   = opts.logsDir   || path.join(__dirname, '..', 'logs');
  const _stateFile = opts.stateFile || BRIEFING_STATE_FILE;
  const dryRun     = opts.dryRun === true;

  _logger.log('=== Weekly Briefing regeneration ===');
  if (dryRun) _logger.log('DRY RUN MODE — no mutations will fire.');

  // W2 recovery artifact — before anything else, dryRun included.
  const savedMarkdownPath = saveMarkdownToDisk(markdown, {
    fsImpl: _fs, logsDir: _logsDir, now: _now, filePrefix: 'weekly-briefing',
  });
  _logger.log(`Saved markdown artifact: ${savedMarkdownPath}`);

  const ensured = await ensureBriefingDoc({
    gqlFn: _gqlFn, fsImpl: _fs, stateFile: _stateFile, title, dryRun, logger: _logger,
  });

  if (ensured.wouldCreate) {
    _logger.log(`Would create doc "${title}" and add ${markdown.split('\n').length} lines of markdown (${markdown.length} bytes).`);
    return {
      docId: null, objectId: null, created: false, renamed: false, wouldCreate: true,
      blocksRead: 0, blocksDeleted: 0, deleteErrors: [], blockIdsAdded: [],
      dryRun, savedMarkdownPath,
    };
  }

  // Rename only when reusing an existing doc — a freshly-created doc was
  // already created with name = title.
  let renamed = false;
  if (!ensured.created && !dryRun) {
    await setDocName(ensured.docId, title, { gqlFn: _gqlFn });
    renamed = true;
    _logger.log(`Renamed doc to "${title}".`);
  }

  const blockIds = await getAllBlockIds(ensured.docId, { gqlFn: _gqlFn });
  _logger.log(`Found ${blockIds.length} blocks in briefing doc ${ensured.docId} (object_id ${ensured.objectId}).`);

  if (dryRun) {
    _logger.log(`Would rename to "${title}", delete ${blockIds.length} blocks, then add ${markdown.split('\n').length} lines of markdown (${markdown.length} bytes).`);
    return {
      docId: ensured.docId, objectId: ensured.objectId, created: false, renamed: false,
      blocksRead: blockIds.length, blocksDeleted: 0, deleteErrors: [], blockIdsAdded: [],
      dryRun: true, savedMarkdownPath,
    };
  }

  const { deleted, errors: deleteErrors } = await deleteBlocks(blockIds, {
    gqlFn: _gqlFn, sleep: _sleep, logger: _logger,
  });
  if (blockIds.length > 0) {
    _logger.log(`Deleted ${deleted}/${blockIds.length} blocks (${deleteErrors.length} errors).`);
  }

  let blockIdsAdded = [];
  try {
    const r = await addMarkdownToDocChunked(ensured.docId, markdown, {
      gqlFn: _gqlFn, sleep: _sleep, logger: _logger,
    });
    blockIdsAdded = r.blockIds;
    _logger.log(`Added ${blockIdsAdded.length} blocks across ${r.chunkCount} chunk(s).`);
  } catch (e) {
    _logger.log(`✗ chunked add failed: ${e.message}`);
    _logger.log(`  FALLBACK: paste ${savedMarkdownPath} into the briefing doc via monday UI (object_id ${ensured.objectId}).`);
    throw e;
  }

  return {
    docId: ensured.docId,
    objectId: ensured.objectId,
    created: ensured.created,
    renamed,
    blocksRead: blockIds.length,
    blocksDeleted: deleted,
    deleteErrors,
    blockIdsAdded,
    dryRun: false,
    savedMarkdownPath,
  };
}

module.exports = {
  BRIEFING_WORKSPACE_ID,
  BRIEFING_FOLDER_ID,
  BRIEFING_DOC_KIND,
  BRIEFING_STATE_FILE,
  loadBriefingDocState,
  saveBriefingDocState,
  setDocName,
  ensureBriefingDoc,
  writeWeeklyBriefing,
};

// ============================================================================
// CLI entry
// ============================================================================
//
// Reads the latest plan JSON + validation JSON from logs/, generates the
// briefing via C6, writes the doc.
//
//   node scripts/write-weekly-briefing.js            # live
//   DRY_RUN=1 node scripts/write-weekly-briefing.js  # preview only
if (require.main === module) {
  (async () => {
    const dryRun = process.env.DRY_RUN === '1';
    const reb = require('./rebalance-schedule.js');
    const { tuplesFromPersistedValidation, timeOffEntriesFromPlan } = require('./capacity-view-generator.js');
    const { buildWeeklyBriefingDoc } = require('./weekly-briefing-generator.js');

    const logsDir = path.join(__dirname, '..', 'logs');
    const latest = reb.findLatestPlanFile(logsDir);
    if (!latest) {
      console.error('No plan file found. Run `node scripts/run-planner.js --plan` first.');
      process.exit(1);
    }
    const plan = JSON.parse(fs.readFileSync(path.join(logsDir, latest), 'utf8'));

    let acceptedOverrides = [];
    const validationPath = path.join(logsDir, latest.replace(/^rebalance-plan-/, 'override-validation-'));
    if (fs.existsSync(validationPath)) {
      acceptedOverrides = tuplesFromPersistedValidation(JSON.parse(fs.readFileSync(validationPath, 'utf8')));
      console.log(`Loaded ${acceptedOverrides.length} accepted-override tuple(s) for 🔧 indicator.`);
    }

    console.log('Fetching jobs from monday for markdown generation...');
    const boards = await reb.loadAll();
    const jobsById = {};
    for (const j of boards.jobs) jobsById[j.id] = j;

    // PTO rows derive from the plan's capacityGrid — boards.timeOff carries
    // the raw Time Off board shape (no crew/week fields) and renders nothing.
    const briefing = buildWeeklyBriefingDoc(plan, jobsById, timeOffEntriesFromPlan(plan), { acceptedOverrides });
    console.log(`Briefing week ${briefing.weekISO}: ${briefing.markdown.length} bytes of markdown.\n`);

    try {
      const result = await writeWeeklyBriefing(briefing, { dryRun });
      console.log('\nDone.', JSON.stringify({
        objectId: result.objectId,
        created: result.created,
        renamed: result.renamed,
        wouldCreate: result.wouldCreate || false,
        blocksRead: result.blocksRead,
        blocksDeleted: result.blocksDeleted,
        blockIdsAdded: result.blockIdsAdded.length,
        dryRun: result.dryRun,
        savedMarkdownPath: result.savedMarkdownPath,
      }));
    } catch (e) {
      console.error('Writer failed:', e.message);
      process.exit(1);
    }
  })().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
