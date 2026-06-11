#!/usr/bin/env node
// C4 — Capacity View doc writer.
//
// Side-effectful: replaces the live Capacity View doc (object_id
// 18410103423) body with freshly-generated markdown from C3
// (buildCapacityViewDoc). Reads existing block IDs (paginated), saves a
// recovery artifact to logs/, deletes each block, then inserts the new
// markdown via a single GraphQL call.
//
// === API surface notes ===
//
// monday's GraphQL API does NOT expose a batched `update_doc(operations)`
// mutation. Each block deletion is a separate `delete_doc_block(block_id)`
// call. The C3 markdown is inserted via `add_content_to_doc_from_markdown`,
// which is **only available on API-Version: 'next' or 'beta'** (the
// pre-release surface). The stable versions (2024-01 / 2024-10 / 2025-01)
// all reject the mutation as unknown.
//
// We accept this risk because:
//   1. monday's own MCP server (github.com/mondaycom/mcp, MIT-licensed)
//      uses this mutation in their production tool — that's the strongest
//      stability signal we'll get short of monday flipping it to stable.
//   2. The blast radius of a future API rename is small — one constant
//      (API_VERSION) at the top of this file.
//   3. Fallback path is fully preserved: if the mutation breaks at runtime,
//      the operator has the C3 markdown on disk at
//      logs/capacity-view-<date>.md (saved BEFORE deletes fire) and can
//      paste it manually via monday UI or the capacity-view-refresh skill.
//
// === Failure mode ===
//
// Delete-first then add-once. If the add fails AFTER deletes succeeded, the
// doc is empty mid-operation. Mitigation:
//   - logs/capacity-view-<date>.md is saved before any mutation fires (W2)
//   - on add failure, console log surfaces the saved-markdown path + the
//     capacity-view-refresh skill as recovery options
//   - --dry-run mode reads + saves markdown WITHOUT firing any mutations
//     so operators can preview before triggering live (E1)
//
// === Rate-limiting ===
//
// 150ms between delete_doc_block calls (matches B6 writeback precedent).
// At 1027 blocks (current live Capacity View size) that's ~2.5 minutes per
// regen. Acceptable for operator-triggered runs; the alternative
// (parallel deletes) risks 429s from monday's rate limiter.

const fs = require('fs');
const path = require('path');

const API_URL = 'https://api.monday.com/v2';
const API_VERSION = 'next';
const CAPACITY_VIEW_OBJECT_ID = 18410103423;
const CAPACITY_VIEW_DOC_URL = `https://harristimberworks.monday.com/docs/${CAPACITY_VIEW_OBJECT_ID}`;
const RATE_LIMIT_MS = 150;
const READ_BATCH_SIZE = 100;
const PROGRESS_EVERY = 50;

// Default gql function used in production. Hardcoded to API-Version: 'next'
// because that's where add_content_to_doc_from_markdown lives (see header
// docstring). Tests inject a stub via opts.gqlFn — this function is never
// reached in unit tests.
async function defaultGql(query, variables = {}) {
  if (!process.env.MONDAY_API_TOKEN) {
    throw new Error('MONDAY_API_TOKEN env var required');
  }
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: process.env.MONDAY_API_TOKEN,
      'API-Version': API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) {
    throw new Error('GraphQL error: ' + JSON.stringify(data.errors));
  }
  return data.data;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolves a doc's object_id (the externally-known ID, e.g. 18410103423) to
// its internal docId (used by add_content_to_doc_from_markdown and the
// blocks query). Throws if no doc found — fail loud, matches the
// existing --execute "no plan file" pattern.
async function getDocIdByObjectId(objectId, { gqlFn = defaultGql } = {}) {
  const q = 'query ($oid: [ID!]) { docs(object_ids: $oid) { id object_id } }';
  const r = await gqlFn(q, { oid: [String(objectId)] });
  const doc = r?.docs?.[0];
  if (!doc) {
    throw new Error(`No doc found for object_id ${objectId}`);
  }
  return doc.id;
}

// Reads all top-level block IDs in a doc, paginated. monday's
// `blocks(page, limit)` param works on the docs query (verified via direct
// probe). Continues until a page returns < batchSize blocks.
//
// C4-followup Item A — cascade-delete skip: monday's delete_doc_block
// cascade-deletes children when a parent is deleted (table cells inside
// table, layout cells inside layout, notice_box children, etc.). We
// fetch parent_block_id alongside id and filter to top-level blocks
// only — firing deletes against children that monday will cascade away
// is wasted API calls (~485 such 404s during the 2026-05-25 first
// regen out of 1027 blocks read).
//
// Pagination subtlety (load-bearing): the stop condition uses RAW
// `blocks.length` (API page size), NOT the filtered top-level count.
// If a page returns 100 blocks of which 80 are children, raw length
// equals batchSize → we paginate. Using filtered length here would
// stop pagination prematurely.
async function getAllBlockIds(docId, { gqlFn = defaultGql, batchSize = READ_BATCH_SIZE } = {}) {
  const ids = [];
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const q = 'query ($docId: [ID!], $page: Int, $limit: Int) { docs(ids: $docId) { blocks(page: $page, limit: $limit) { id parent_block_id } } }';
    const r = await gqlFn(q, { docId: [String(docId)], page, limit: batchSize });
    const blocks = r?.docs?.[0]?.blocks || [];
    for (const b of blocks) {
      if (!b.parent_block_id) ids.push(b.id);
    }
    if (blocks.length < batchSize) break;
    page++;
  }
  return ids;
}

// Deletes blocks sequentially via delete_doc_block. Per-block error capture
// (loop continues on failure). Rate-limited at RATE_LIMIT_MS between calls
// (not after the last). dryRun skips all gqlFn AND sleep calls.
async function deleteBlocks(blockIds, opts = {}) {
  const {
    gqlFn = defaultGql,
    sleep = defaultSleep,
    rateLimitMs = RATE_LIMIT_MS,
    dryRun = false,
    logger = console,
    progressEvery = PROGRESS_EVERY,
  } = opts;

  let deleted = 0;
  const errors = [];
  const total = blockIds.length;

  for (let i = 0; i < blockIds.length; i++) {
    const id = blockIds[i];
    if (dryRun) continue;
    try {
      await gqlFn('mutation ($blockId: String!) { delete_doc_block(block_id: $blockId) { id } }', { blockId: id });
      deleted++;
    } catch (e) {
      errors.push({ blockId: id, error: e.message || String(e) });
    }
    if ((deleted + errors.length) % progressEvery === 0 && (deleted + errors.length) > 0) {
      logger.log(`  Deleted ${deleted}/${total} (${errors.length} errors)...`);
    }
    if (i < blockIds.length - 1 && rateLimitMs > 0) {
      await sleep(rateLimitMs);
    }
  }
  return { deleted, errors };
}

// Inserts markdown via add_content_to_doc_from_markdown. Single call —
// monday's mutation handles markdown parsing internally (tables, bold,
// italic, lists, dividers all preserved). Throws on success:false or any
// gqlFn rejection.
//
// NOT used directly by replaceCapacityViewBody anymore (see Item B
// below — full C3 output exceeds monday's undocumented per-call block-
// count limit). Kept exported for tests + direct small-markdown
// callers; the orchestrator uses addMarkdownToDocChunked.
async function addMarkdownToDoc(docId, markdown, { gqlFn = defaultGql } = {}) {
  const q = 'mutation ($docId: ID!, $markdown: String!) { add_content_to_doc_from_markdown(docId: $docId, markdown: $markdown) { success block_ids error } }';
  const r = await gqlFn(q, { docId: String(docId), markdown });
  const result = r?.add_content_to_doc_from_markdown;
  if (!result?.success) {
    throw new Error(`add_content_to_doc_from_markdown failed: ${result?.error || 'no result'}`);
  }
  return { blockIds: result.block_ids || [] };
}

// C4-followup Item B — chunked markdown insert.
//
// monday's add_content_to_doc_from_markdown has an undocumented
// per-call block-count limit (somewhere around 500-600 blocks).
// 2026-05-25 first live regen: full 8-week C3 output (9173 bytes,
// ~720 blocks) returned INTERNAL_SERVER_ERROR from the docs-api
// service. Manual recovery via splitting at `---` boundaries (10
// chunks, 14-266 blocks each) succeeded on all sequential calls.
//
// chunkMarkdownAtDividers splits at lines matching the divider
// pattern. The trailing divider STAYS with the preceding chunk so
// monday renders it correctly as part of that chunk's block tree.
// The final chunk has no trailing divider if the input didn't end
// with one.
//
// Known limitation (Phase 5 polish): if a single section (heavy-load
// week with many table cells, say 25+ placements) exceeds the per-
// call block limit, that chunk still fails. Recursive sub-section
// chunking is the fix — defer until a real-load week trips it.
function chunkMarkdownAtDividers(markdown) {
  if (!markdown) return [];
  const lines = markdown.split('\n');
  const chunks = [];
  let cur = [];
  for (const line of lines) {
    cur.push(line);
    if (line === '---') {
      chunks.push(cur.join('\n'));
      cur = [];
    }
  }
  if (cur.length > 0) {
    const tail = cur.join('\n');
    if (tail.trim().length > 0) chunks.push(tail);
  }
  return chunks;
}

// Inserts markdown via repeated add_content_to_doc_from_markdown
// calls, one per chunk (split at `---` divider boundaries). Sequential
// with rate-limit between chunks (B6/deleteBlocks precedent). On
// per-chunk failure, throws with chunk index + total; caller surfaces
// the saved-markdown recovery artifact.
async function addMarkdownToDocChunked(docId, markdown, opts = {}) {
  const {
    gqlFn = defaultGql,
    sleep = defaultSleep,
    rateLimitMs = RATE_LIMIT_MS,
    logger = console,
  } = opts;

  const chunks = chunkMarkdownAtDividers(markdown);
  const blockIds = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const r = await addMarkdownToDoc(docId, chunk, { gqlFn });
      blockIds.push(...r.blockIds);
      logger.log(`  Chunk ${i + 1}/${chunks.length} (${chunk.length} bytes) → ${r.blockIds.length} blocks (running total ${blockIds.length})`);
    } catch (e) {
      logger.log(`  ✗ Chunk ${i + 1}/${chunks.length} (${chunk.length} bytes) FAILED: ${e.message}`);
      throw new Error(`addMarkdownToDocChunked: chunk ${i + 1} / ${chunks.length} failed: ${e.message}`);
    }
    if (i < chunks.length - 1 && rateLimitMs > 0) {
      await sleep(rateLimitMs);
    }
  }
  return { blockIds, chunkCount: chunks.length };
}

// Saves generated markdown to logs/<filePrefix>-<date>.md (default prefix
// capacity-view; C7's briefing writer passes 'weekly-briefing').
// E1: this fires under dryRun too — operators can inspect what WOULD be
// written before triggering the live run. Latest-wins overwrite is
// deliberate (E2).
function saveMarkdownToDisk(markdown, opts = {}) {
  const {
    fsImpl = fs,
    logsDir = path.join(__dirname, '..', 'logs'),
    now = () => new Date(),
    filePrefix = 'capacity-view',
  } = opts;

  if (!fsImpl.existsSync(logsDir)) {
    fsImpl.mkdirSync(logsDir, { recursive: true });
  }
  const d = now();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const file = path.join(logsDir, `${filePrefix}-${dateStr}.md`);
  fsImpl.writeFileSync(file, markdown);
  return file;
}

// Orchestrator: getDocId → read blocks → save md (recovery artifact) →
// delete blocks → add markdown. dryRun returns early after saving the
// markdown artifact (no mutations fire). Returns:
//   {
//     docId,                  // internal doc id resolved from object_id
//     blocksRead,             // count of blocks discovered during read
//     blocksDeleted,          // count of blocks actually deleted (dryRun: 0)
//     deleteErrors,           // [{ blockId, error }, ...] per-block failures
//     blockIdsAdded,          // ids returned by add_content_to_doc_from_markdown
//     dryRun,                 // echo of opts.dryRun
//     savedMarkdownPath,      // logs/capacity-view-<date>.md
//   }
async function replaceCapacityViewBody(objectId, newMarkdown, opts = {}) {
  const _gqlFn   = opts.gqlFn    || defaultGql;
  const _sleep   = opts.sleepFn  || defaultSleep;
  const _fs      = opts.fs       || fs;
  const _logger  = opts.logger   || console;
  const _now     = opts.now      || (() => new Date());
  const _logsDir = opts.logsDir  || path.join(__dirname, '..', 'logs');
  const dryRun   = opts.dryRun === true;

  _logger.log('=== Capacity View regeneration ===');
  if (dryRun) _logger.log('DRY RUN MODE — no mutations will fire.');

  // W2 recovery artifact — saved BEFORE any API call (REVIEW FIX 2026-06-10:
  // previously saved after the doc reads, so a read-phase failure left no
  // artifact while failure messages pointed operators at one; the briefing
  // writer's save-first ordering is now the shared convention).
  const savedMarkdownPath = saveMarkdownToDisk(newMarkdown, { fsImpl: _fs, logsDir: _logsDir, now: _now });
  _logger.log(`Saved markdown artifact: ${savedMarkdownPath}`);

  _logger.log('Reading current doc state...');
  const docId = await getDocIdByObjectId(objectId, { gqlFn: _gqlFn });
  const blockIds = await getAllBlockIds(docId, { gqlFn: _gqlFn });
  _logger.log(`Found ${blockIds.length} blocks in doc ${docId} (object_id ${objectId}).`);

  if (dryRun) {
    _logger.log(`Would delete ${blockIds.length} blocks, then add ${newMarkdown.split('\n').length} lines of markdown (${newMarkdown.length} bytes).`);
    return {
      docId,
      blocksRead: blockIds.length,
      blocksDeleted: 0,
      deleteErrors: [],
      blockIdsAdded: [],
      dryRun: true,
      savedMarkdownPath,
    };
  }

  _logger.log(`Deleting ${blockIds.length} blocks (${RATE_LIMIT_MS}ms rate-limit)...`);
  const { deleted, errors: deleteErrors } = await deleteBlocks(blockIds, {
    gqlFn: _gqlFn,
    sleep: _sleep,
    logger: _logger,
  });
  _logger.log(`Deleted ${deleted}/${blockIds.length} blocks (${deleteErrors.length} errors).`);

  _logger.log('Adding new markdown (chunked at `---` boundaries; see addMarkdownToDocChunked docstring)...');
  let blockIdsAdded = [];
  let chunkCount = 0;
  try {
    const r = await addMarkdownToDocChunked(docId, newMarkdown, {
      gqlFn: _gqlFn,
      sleep: _sleep,
      logger: _logger,
    });
    blockIdsAdded = r.blockIds;
    chunkCount = r.chunkCount;
    _logger.log(`Added ${blockIdsAdded.length} blocks across ${chunkCount} chunk(s).`);
  } catch (e) {
    _logger.log(`✗ chunked add failed: ${e.message}`);
    _logger.log(`  FALLBACK: paste ${savedMarkdownPath} into ${CAPACITY_VIEW_DOC_URL} via monday UI, or invoke the capacity-view-refresh skill.`);
    throw e;
  }

  _logger.log(`Doc regenerated: ${CAPACITY_VIEW_DOC_URL}`);
  return {
    docId,
    blocksRead: blockIds.length,
    blocksDeleted: deleted,
    deleteErrors,
    blockIdsAdded,
    dryRun: false,
    savedMarkdownPath,
  };
}

module.exports = {
  API_URL,
  API_VERSION,
  CAPACITY_VIEW_OBJECT_ID,
  CAPACITY_VIEW_DOC_URL,
  RATE_LIMIT_MS,
  READ_BATCH_SIZE,
  // Exposed for sibling writers (C7 write-weekly-briefing.js).
  defaultGql,
  getDocIdByObjectId,
  getAllBlockIds,
  deleteBlocks,
  addMarkdownToDoc,
  chunkMarkdownAtDividers,
  addMarkdownToDocChunked,
  saveMarkdownToDisk,
  replaceCapacityViewBody,
};

// ============================================================================
// CLI entry
// ============================================================================
//
// Reads the latest plan JSON + latest validation JSON from logs/, calls
// loadAll() for jobs + timeOff (not stored in plan JSON), generates the
// markdown via C3, and writes to the live Capacity View doc.
//
// Modes:
//   node scripts/write-capacity-view.js          # live (delete + add)
//   DRY_RUN=1 node scripts/write-capacity-view.js # preview only
//
// Fail-loud if no plan JSON exists yet — matches the --execute pattern.
if (require.main === module) {
  (async () => {
    const dryRun = process.env.DRY_RUN === '1';
    const reb = require('./rebalance-schedule.js');
    const { buildCapacityViewDoc, tuplesFromPersistedValidation, timeOffEntriesFromPlan } = require('./capacity-view-generator.js');

    const logsDir = path.join(__dirname, '..', 'logs');
    const latest = reb.findLatestPlanFile(logsDir);
    if (!latest) {
      console.error('No plan file found. Run `node scripts/run-planner.js --plan` first.');
      process.exit(1);
    }
    const planPath = path.join(logsDir, latest);
    console.log(`Loading plan: ${planPath}`);
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

    // Latest validation JSON for acceptedOverrides (🔧 indicator hook).
    // If absent (e.g., pre-B6 runs), proceed without overrides.
    let acceptedOverrides = [];
    const validationFile = latest.replace(/^rebalance-plan-/, 'override-validation-');
    const validationPath = path.join(logsDir, validationFile);
    if (fs.existsSync(validationPath)) {
      const validation = JSON.parse(fs.readFileSync(validationPath, 'utf8'));
      // C5: prefer the acceptedTuples persisted by run-planner.js (full
      // semantics, incl. pure-clear diffs); legacy fallback maps to-side
      // rows only. See tuplesFromPersistedValidation docstring.
      acceptedOverrides = tuplesFromPersistedValidation(validation);
      console.log(`Loaded ${acceptedOverrides.length} accepted-override tuple(s) for 🔧 indicator.`);
    }

    console.log('Fetching jobs from monday for markdown generation...');
    const boards = await reb.loadAll();
    const jobsById = {};
    for (const j of boards.jobs) jobsById[j.id] = j;

    // PTO rows derive from the plan's capacityGrid — boards.timeOff carries
    // the raw Time Off board shape (no crew/week fields) and renders nothing.
    const markdown = buildCapacityViewDoc(plan, jobsById, timeOffEntriesFromPlan(plan), {
      generatedAt: new Date(),
      acceptedOverrides,
    });
    console.log(`Generated ${markdown.length} bytes of markdown.\n`);

    try {
      const result = await replaceCapacityViewBody(CAPACITY_VIEW_OBJECT_ID, markdown, { dryRun });
      console.log('\nDone.', JSON.stringify({
        blocksRead: result.blocksRead,
        blocksDeleted: result.blocksDeleted,
        deleteErrors: result.deleteErrors.length,
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
