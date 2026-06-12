#!/usr/bin/env node
/**
 * One-time, idempotent: create the 💬 Quotes group + columns on the Manual
 * Overrides board (18413101550) and persist ids into config/planner-trigger.json.
 * Duplicate guard: only a SUCCESSFUL zero-result group query triggers creation
 * (a transient failure throws — the briefing-doc duplicate bug family).
 * After running: COMMIT config/planner-trigger.json immediately, then do the
 * one manual step — create a "Quotes" board view showing these columns and
 * hide them in the Main view (monday UI). Also verify no board automation
 * touches the Quotes group (spec §4.4).
 */
const fs = require('fs');
const path = require('path');
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'planner-trigger.json');
const GROUP_TITLE = '💬 Quotes';

const COLUMNS = [
  { key: 'jobType',      title: 'Job Type',      type: 'dropdown',
    defaults: { settings_str: JSON.stringify({ labels: [ { id: 1, name: 'Res - Face Frame' }, { id: 2, name: 'Res - Frameless' }, { id: 3, name: 'Commercial' } ] }) } },
  { key: 'boxes',        title: 'Boxes',         type: 'numbers' },
  { key: 'complexity',   title: 'Complexity',    type: 'numbers' },
  { key: 'targetDate',   title: 'Target Date',   type: 'date' },
  { key: 'status',       title: 'Quote Status',  type: 'status',
    defaults: { settings_str: JSON.stringify({ labels: { 1: 'Quote Requested', 2: 'Quoting', 3: 'Quoted', 4: 'Quote Error' } }) } },
  { key: 'quotedWeek',   title: 'Quoted Week',   type: 'date' },
  { key: 'capacityWeek', title: 'Capacity Week', type: 'date' },
];

async function setupQuotesGroup({ gqlFn, fsImpl = fs, configPath = CONFIG_PATH } = {}) {
  const config = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
  const boardId = String(config.boardId);

  const read = await gqlFn(`query ($board: [ID!]) { boards(ids: $board) { groups { id title } } }`, { board: [boardId] });
  if (!read?.boards?.[0]) throw new Error('setup-quotes-group: board groups query returned nothing — aborting (no blind create)');
  const existing = (read.boards[0].groups || []).find(g => g.title === GROUP_TITLE);

  if (existing && config.quotesGroupId === existing.id && config.quoteColumns) {
    console.log(`✓ Quotes group already set up (${existing.id}) — nothing to do`);
    return { created: false, quotesGroupId: existing.id };
  }

  let groupId = existing?.id;
  if (!groupId) {
    const g = await gqlFn(`mutation ($board: ID!, $name: String!) { create_group(board_id: $board, group_name: $name) { id } }`,
      { board: boardId, name: GROUP_TITLE });
    groupId = g?.create_group?.id;
    if (!groupId) throw new Error('setup-quotes-group: create_group returned no id');
    console.log(`✓ created group ${groupId}`);
  }

  const quoteColumns = config.quoteColumns || {};
  for (const col of COLUMNS) {
    if (quoteColumns[col.key]) continue;
    const c = await gqlFn(
      `mutation ($board: ID!, $title: String!, $type: ColumnType!${col.defaults ? ', $defaults: JSON' : ''}) {
        create_column(board_id: $board, title: $title, column_type: $type${col.defaults ? ', defaults: $defaults' : ''}) { id }
      }`,
      { board: boardId, title: col.title, type: col.type, ...(col.defaults ? { defaults: col.defaults.settings_str } : {}) });
    quoteColumns[col.key] = c?.create_column?.id;
    if (!quoteColumns[col.key]) throw new Error(`setup-quotes-group: create_column '${col.title}' returned no id`);
    console.log(`✓ created column ${col.title} → ${quoteColumns[col.key]}`);
  }

  const next = { ...config, quotesGroupId: groupId, quoteColumns };
  fsImpl.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
  console.log(`✓ config persisted → ${configPath} — COMMIT THIS NOW (parallel-session rule)`);
  console.log(`→ manual step: create the 'Quotes' board view + hide quote columns in Main view`);
  console.log(`→ manual step: verify board automations (cross-training doc §automations) don't touch ${GROUP_TITLE}`);
  return { created: true, quotesGroupId: groupId, quoteColumns };
}

module.exports = { setupQuotesGroup, COLUMNS, GROUP_TITLE };

if (require.main === module) {
  const TOKEN = process.env.MONDAY_API_TOKEN || (fs.existsSync(path.join(__dirname, '..', '.token'))
    ? fs.readFileSync(path.join(__dirname, '..', '.token'), 'utf8').trim() : null);
  if (!TOKEN) { console.error('ERROR: MONDAY_API_TOKEN or .token required'); process.exit(1); }
  const gqlFn = async (query, variables) => {
    const r = await fetch('https://api.monday.com/v2', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: TOKEN, 'API-Version': 'next' },
      body: JSON.stringify({ query, variables }) });
    const j = await r.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    return j.data;
  };
  setupQuotesGroup({ gqlFn }).catch(e => { console.error(e); process.exit(1); });
}
