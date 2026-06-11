#!/usr/bin/env node
// P3.2 — idempotent trigger-surface bootstrap (docs/phase-3-manual-overrides-plan.md P3-D1).
//
// Creates the ⚙️ Control group + "▶️ Planner Trigger" item on the Manual
// Overrides board (18413101550) and persists ids to
// config/planner-trigger.json. Safe to re-run: an existing config whose item
// still resolves is reused with zero mutations. The Control group is
// invisible to the planner's B4 read (which only reads the Active group
// 'topics'), so the trigger item can never enter validation.
//
//   node scripts/setup-trigger-item.js            # live
//   DRY_RUN=1 node scripts/setup-trigger-item.js  # preview

const fs = require('fs');
const path = require('path');

const TRIGGER_BOARD_ID = 18413101550;
const TRIGGER_STATUS_COLUMN = 'color_mm3aqx5g';   // board's existing Status column
const TRIGGER_GROUP_NAME = '⚙️ Control';
const TRIGGER_ITEM_NAME = '▶️ Planner Trigger';
const DEFAULT_CONFIG_FILE = path.join(__dirname, '..', 'config', 'planner-trigger.json');

async function ensureTriggerItem({ deps = {} } = {}) {
  const _gqlFn  = deps.gqlFn;
  const _fsImpl = deps.fsImpl || fs;
  const _configFile = deps.configFile || DEFAULT_CONFIG_FILE;
  const _logger = deps.logger || console;
  const dryRun  = deps.dryRun === true;

  // Reuse path: config exists AND the item still resolves.
  let existing = null;
  try {
    if (_fsImpl.existsSync(_configFile)) {
      existing = JSON.parse(_fsImpl.readFileSync(_configFile, 'utf8'));
    }
  } catch (e) { existing = null; }

  if (existing && existing.itemId) {
    if (dryRun) {
      // Read-only resolve is fine under dryRun, but keep the no-config case
      // at zero API calls; with config we verify before reporting.
    }
    // REVIEW FIX (2026-06-11): only a SUCCESSFUL query with zero items means
    // "genuinely deleted → recreate". A transient gql failure must rethrow —
    // swallowing it here would create a duplicate Control group + trigger
    // item and silently orphan the one Bob uses (same bug family as the
    // briefing-doc duplicate guard).
    const r = await _gqlFn('query ($item: [ID!]) { items(ids: $item) { id name } }', { item: [String(existing.itemId)] });
    const read = (r && r.items && r.items[0]) || null;
    if (read) {
      _logger.log(`Trigger item ${existing.itemId} resolves — reusing.`);
      return { ...existing, created: false };
    }
    _logger.log(`Trigger item ${existing.itemId} no longer resolves (query succeeded, zero items) — recreating.`);
  }

  if (dryRun) {
    _logger.log(`[DRY RUN] would create group "${TRIGGER_GROUP_NAME}" + item "${TRIGGER_ITEM_NAME}" on board ${TRIGGER_BOARD_ID}.`);
    return { created: false, wouldCreate: true };
  }

  const grp = await _gqlFn(
    'mutation ($board: ID!, $name: String!) { create_group(board_id: $board, group_name: $name) { id } }',
    { board: String(TRIGGER_BOARD_ID), name: TRIGGER_GROUP_NAME });
  const groupId = grp.create_group.id;

  const item = await _gqlFn(
    `mutation ($board: ID!, $group: String!, $name: String!, $cv: JSON!) {
      create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $cv, create_labels_if_missing: true) { id }
    }`,
    {
      board: String(TRIGGER_BOARD_ID),
      group: groupId,
      name: TRIGGER_ITEM_NAME,
      cv: JSON.stringify({ [TRIGGER_STATUS_COLUMN]: { label: 'Idle' } }),
    });

  const config = {
    boardId: String(TRIGGER_BOARD_ID),
    groupId,
    itemId: String(item.create_item.id),
    statusColumnId: TRIGGER_STATUS_COLUMN,
    createdAt: new Date().toISOString().slice(0, 10),
  };
  const dir = path.dirname(_configFile);
  if (!_fsImpl.existsSync(dir)) _fsImpl.mkdirSync(dir, { recursive: true });
  _fsImpl.writeFileSync(_configFile, JSON.stringify(config, null, 2) + '\n');
  _logger.log(`Created trigger item ${config.itemId} in group ${groupId}; config persisted to ${_configFile}.`);
  return { ...config, created: true };
}

module.exports = { TRIGGER_BOARD_ID, TRIGGER_STATUS_COLUMN, TRIGGER_GROUP_NAME, TRIGGER_ITEM_NAME, ensureTriggerItem };

if (require.main === module) {
  if (!process.env.MONDAY_API_TOKEN) {
    console.error('ERROR: MONDAY_API_TOKEN env var required');
    process.exit(1);
  }
  const reb = require('./rebalance-schedule.js');
  ensureTriggerItem({ deps: { gqlFn: reb.gql, dryRun: process.env.DRY_RUN === '1' } })
    .then(r => console.log(JSON.stringify(r)))
    .catch(e => { console.error('Fatal:', e); process.exit(1); });
}
