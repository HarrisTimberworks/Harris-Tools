#!/usr/bin/env node
/**
 * P3.2 — setup-trigger-item.js: idempotent trigger-surface bootstrap.
 *
 * ensureTriggerItem({ deps }) → { boardId, groupId, itemId, statusColumnId, created }
 *   - config exists + item resolves → reuse, zero mutations
 *   - config missing/stale → create ⚙️ Control group + ▶️ Planner Trigger
 *     item (Status = Idle, create_labels_if_missing) on board 18413101550,
 *     persist config/planner-trigger.json
 *   - dryRun → never mutates, reports wouldCreate
 */

const {
  TRIGGER_BOARD_ID,
  TRIGGER_STATUS_COLUMN,
  ensureTriggerItem,
} = require('./setup-trigger-item.js');

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
      writeFileSync: (p, c) => { writes.push(String(p)); files.set(String(p), c); },
    },
  };
}

function makeFakeGql({ itemExists = true } = {}) {
  const calls = [];
  const fn = async (query, variables) => {
    calls.push({ query, variables });
    if (/create_group/.test(query)) return { create_group: { id: 'grp_control' } };
    if (/create_item/.test(query)) return { create_item: { id: '99100' } };
    if (/items\s*\(/.test(query)) return { items: itemExists ? [{ id: '88100', name: '▶️ Planner Trigger' }] : [] };
    throw new Error(`fake gql: unrouted: ${query.slice(0, 60)}`);
  };
  fn.calls = calls;
  return fn;
}

const CONFIG = JSON.stringify({ boardId: '18413101550', groupId: 'grp_old', itemId: '88100', statusColumnId: 'color_mm3aqx5g' });
const silentLogger = { log: () => {} };

(async () => {

  console.log('Test 1: constants pin board + status column');
  {
    check('board 18413101550', String(TRIGGER_BOARD_ID) === '18413101550', String(TRIGGER_BOARD_ID));
    check('status column color_mm3aqx5g', TRIGGER_STATUS_COLUMN === 'color_mm3aqx5g', TRIGGER_STATUS_COLUMN);
  }

  console.log('\nTest 2: existing config + item resolves → reuse, zero mutations');
  {
    const f = makeFakeFs({ '/fake/cfg.json': CONFIG });
    const gql = makeFakeGql({ itemExists: true });
    const r = await ensureTriggerItem({ deps: { gqlFn: gql, fsImpl: f.fs, configFile: '/fake/cfg.json', logger: silentLogger } });
    check('created === false', r.created === false, JSON.stringify(r));
    check('itemId from config', r.itemId === '88100', JSON.stringify(r));
    check('no mutations fired', gql.calls.every(c => !/create_group|create_item/.test(c.query)), JSON.stringify(gql.calls.map(c => c.query.slice(0, 40))));
    check('config not rewritten', f.writes.length === 0, JSON.stringify(f.writes));
  }

  console.log('\nTest 3: stale config (item gone) → creates group + item, persists');
  {
    const f = makeFakeFs({ '/fake/cfg.json': CONFIG });
    const gql = makeFakeGql({ itemExists: false });
    const r = await ensureTriggerItem({ deps: { gqlFn: gql, fsImpl: f.fs, configFile: '/fake/cfg.json', logger: silentLogger } });
    check('created === true', r.created === true, JSON.stringify(r));
    check('group then item created', gql.calls.some(c => /create_group/.test(c.query)) && gql.calls.some(c => /create_item/.test(c.query)), '');
    const createItem = gql.calls.find(c => /create_item/.test(c.query));
    check('item created in new group with Idle status + labels-if-missing',
      createItem?.variables?.group === 'grp_control'
      && /Idle/.test(createItem?.variables?.cv || '')
      && /create_labels_if_missing: true/.test(createItem?.query),
      JSON.stringify(createItem?.variables));
    const persisted = JSON.parse(f.files.get('/fake/cfg.json'));
    check('config persisted with new ids', persisted.itemId === '99100' && persisted.groupId === 'grp_control', JSON.stringify(persisted));
  }

  console.log('\nTest 4: no config → create from scratch');
  {
    const f = makeFakeFs();
    const gql = makeFakeGql();
    const r = await ensureTriggerItem({ deps: { gqlFn: gql, fsImpl: f.fs, configFile: '/fake/cfg.json', logger: silentLogger } });
    check('created === true', r.created === true, JSON.stringify(r));
    check('config file written', f.files.has('/fake/cfg.json'), '');
  }

  console.log('\nTest 5: dryRun — zero mutations, wouldCreate reported');
  {
    const f = makeFakeFs();
    const gql = makeFakeGql();
    const r = await ensureTriggerItem({ deps: { gqlFn: gql, fsImpl: f.fs, configFile: '/fake/cfg.json', logger: silentLogger, dryRun: true } });
    check('wouldCreate === true', r.wouldCreate === true && r.created === false, JSON.stringify(r));
    check('zero gql calls', gql.calls.length === 0, JSON.stringify(gql.calls.map(c => c.query.slice(0, 40))));
    check('no config written', f.writes.length === 0, '');
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All P3.2 setup-trigger-item tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
