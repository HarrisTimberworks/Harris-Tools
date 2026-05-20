#!/usr/bin/env node
/**
 * Tests for scripts/clean-stale-subitems.js — A6 cleanup utility.
 *
 * The CLI wrapper isn't unit-tested (exercises live monday). The pure helper
 *   identifyStaleSubitems(subitems, plRows)
 * is tested here with synthetic fixtures (no live monday calls).
 *
 * Criterion (B-refined per design review):
 *   stale = subitem.masterPmId resolves to a PL row with status === 'Complete'
 *           OR resolves to no PL row at all (orphan link).
 *   NOT stale = subitem.masterPmId resolves to a PL row with any non-Complete
 *               status (Not Started, In Production, On Hold, Cancelled, …).
 *
 * The orphan clause exists because monday's PL→Master PM link
 * (board_relation_mm26mhea) is often null on Complete rows (cleared on
 * close-out, or never populated for older rows). The strict-spec join path
 * misses the Westridge-style failure mode the spec was written to address;
 * the orphan clause restores that coverage while staying conservative — On
 * Hold and Cancelled subitems are explicitly preserved.
 *
 * Each returned subitem is augmented with `staleReason: 'complete' | 'orphan'`
 * so the CLI can group its output by which clause fired without re-deriving.
 */

const { identifyStaleSubitems } = require('./clean-stale-subitems.js');

let checks = 0;
const failures = [];
function check(label, cond, detail) {
  checks++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}: ${detail}`);
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Fixture helpers — synthetic subitems and PL rows.
// Shapes match what loadSubitems() and PL queries return in production.
// ──────────────────────────────────────────────────────────────────────────

function sub({ id, name = 'Test Job — Benchwork', masterPmId, parentCrew = 'Bob',
               parentWeek = '2026-05-04', station = 'Benchwork', hours = 8 }) {
  return { id, name, masterPmId, parentCrew, parentWeek, station, hours };
}

function pl({ masterPmLink, status, plId = 'pl-' + Math.random().toString(36).slice(2, 8), name = 'PL Row' }) {
  return { id: plId, name, masterPmLink, status };
}

// ──────────────────────────────────────────────────────────────────────────

console.log('Test 1: no subitems → empty stale list');
{
  const stale = identifyStaleSubitems([], []);
  check('returns empty array', Array.isArray(stale) && stale.length === 0,
        `got ${JSON.stringify(stale)}`);
}

console.log('\nTest 2: all linked jobs are active → empty stale list');
{
  const subitems = [
    sub({ id: 's1', masterPmId: 'mpm1' }),
    sub({ id: 's2', masterPmId: 'mpm2' }),
  ];
  const plRows = [
    pl({ masterPmLink: 'mpm1', status: 'In Production' }),
    pl({ masterPmLink: 'mpm2', status: 'Not Started' }),
  ];
  const stale = identifyStaleSubitems(subitems, plRows);
  check('no stale subitems', stale.length === 0, JSON.stringify(stale));
}

console.log('\nTest 3: one stale (PL exists, status=Complete) → staleReason=complete');
{
  const subitems = [sub({ id: 's1', masterPmId: 'mpm1' })];
  const plRows = [pl({ masterPmLink: 'mpm1', status: 'Complete' })];
  const stale = identifyStaleSubitems(subitems, plRows);
  check('exactly one stale', stale.length === 1, `got ${stale.length}`);
  check('subitem object returned',  stale[0]?.id === 's1', JSON.stringify(stale[0]));
  check('staleReason=complete',     stale[0]?.staleReason === 'complete', `staleReason=${stale[0]?.staleReason}`);
}

console.log('\nTest 4: multiple stale (all Complete-linked)');
{
  const subitems = [
    sub({ id: 's1', masterPmId: 'mpm1' }),
    sub({ id: 's2', masterPmId: 'mpm1' }),
    sub({ id: 's3', masterPmId: 'mpm2' }),
  ];
  const plRows = [
    pl({ masterPmLink: 'mpm1', status: 'Complete' }),
    pl({ masterPmLink: 'mpm2', status: 'Complete' }),
  ];
  const stale = identifyStaleSubitems(subitems, plRows);
  check('all three stale', stale.length === 3, `got ${stale.length}`);
  check('all reason=complete', stale.every(s => s.staleReason === 'complete'),
        JSON.stringify(stale.map(s => s.staleReason)));
}

console.log('\nTest 5: mixed — some Complete, some active');
{
  const subitems = [
    sub({ id: 's1', masterPmId: 'mpm-complete' }),
    sub({ id: 's2', masterPmId: 'mpm-active' }),
    sub({ id: 's3', masterPmId: 'mpm-complete' }),
    sub({ id: 's4', masterPmId: 'mpm-not-started' }),
  ];
  const plRows = [
    pl({ masterPmLink: 'mpm-complete',    status: 'Complete' }),
    pl({ masterPmLink: 'mpm-active',      status: 'In Production' }),
    pl({ masterPmLink: 'mpm-not-started', status: 'Not Started' }),
  ];
  const stale = identifyStaleSubitems(subitems, plRows);
  check('only Complete-linked subitems are stale', stale.length === 2, `got ${stale.length}`);
  const ids = new Set(stale.map(s => s.id));
  check('stale set is {s1, s3}', ids.has('s1') && ids.has('s3') && !ids.has('s2') && !ids.has('s4'),
        JSON.stringify([...ids]));
}

console.log('\nTest 6: subitem.masterPmId null → NOT stale, no crash');
{
  // Subitems with no relatedJob link can't be evaluated. Conservative: skip
  // (no risk of erroneous delete) rather than treating null as orphan.
  const subitems = [
    sub({ id: 's1', masterPmId: null }),
    sub({ id: 's2', masterPmId: undefined }),
  ];
  const plRows = [];
  const stale = identifyStaleSubitems(subitems, plRows);
  check('did not throw', true, 'reached here');
  check('null/undefined masterPmId → not stale', stale.length === 0, JSON.stringify(stale));
}

console.log('\nTest 7: orphan PL link (masterPmId resolves to no PL row) → staleReason=orphan');
{
  // The real-world Westridge case: subitem.masterPmId is valid (set when
  // subitem was created), but PL no longer has a row linking to that
  // Master PM (close-out cleared the link, or PL row was archived).
  const subitems = [sub({ id: 's1', masterPmId: 'mpm-no-pl-row' })];
  const plRows = [pl({ masterPmLink: 'mpm-other', status: 'In Production' })];
  const stale = identifyStaleSubitems(subitems, plRows);
  check('orphan is stale', stale.length === 1 && stale[0]?.id === 's1', JSON.stringify(stale));
  check('staleReason=orphan', stale[0]?.staleReason === 'orphan', `staleReason=${stale[0]?.staleReason}`);
}

console.log('\nTest 8: cross-type id comparison (string vs. numeric masterPmId)');
{
  const subitems = [
    sub({ id: 's1', masterPmId: '12345' }),
    sub({ id: 's2', masterPmId: 67890 }),
  ];
  const plRows = [
    pl({ masterPmLink: 12345,    status: 'Complete' }),
    pl({ masterPmLink: '67890',  status: 'Complete' }),
  ];
  const stale = identifyStaleSubitems(subitems, plRows);
  check('cross-type match works both ways', stale.length === 2, `got ${stale.length}`);
}

console.log('\nTest 9: returned objects preserve fields needed for CLI output');
{
  const subitems = [sub({
    id: 's1', name: 'F&B Westridge Dr — Benchwork', masterPmId: 'mpm-westridge',
    parentCrew: 'Ian', parentWeek: '2026-05-04', station: 'Benchwork', hours: 12.6,
  })];
  const plRows = [];  // no matching PL row → orphan
  const stale = identifyStaleSubitems(subitems, plRows);
  const s = stale[0];
  check('preserves name',        s?.name === 'F&B Westridge Dr — Benchwork', `name=${s?.name}`);
  check('preserves parentCrew',  s?.parentCrew === 'Ian',                    `parentCrew=${s?.parentCrew}`);
  check('preserves parentWeek',  s?.parentWeek === '2026-05-04',             `parentWeek=${s?.parentWeek}`);
  check('preserves station',     s?.station === 'Benchwork',                 `station=${s?.station}`);
  check('preserves hours',       s?.hours === 12.6,                          `hours=${s?.hours}`);
}

console.log('\nTest 10: PL row exists with status=On Hold → NOT stale');
{
  // Conservative safety case: On Hold and Cancelled subitems are NOT deleted
  // even though they're not currently in the active set. Only Complete (or
  // truly missing/orphan) qualifies.
  const subitems = [sub({ id: 's1', masterPmId: 'mpm-on-hold' })];
  const plRows = [pl({ masterPmLink: 'mpm-on-hold', status: 'On Hold' })];
  const stale = identifyStaleSubitems(subitems, plRows);
  check('On Hold is not stale', stale.length === 0, JSON.stringify(stale));
}

console.log('\nTest 11: union criterion — Complete + orphan in the same input');
{
  // Verifies both clauses fire in one pass and tag correctly.
  const subitems = [
    sub({ id: 's-complete', masterPmId: 'mpm-complete' }),
    sub({ id: 's-orphan',   masterPmId: 'mpm-ghost' }),
    sub({ id: 's-active',   masterPmId: 'mpm-active' }),
  ];
  const plRows = [
    pl({ masterPmLink: 'mpm-complete', status: 'Complete' }),
    pl({ masterPmLink: 'mpm-active',   status: 'In Production' }),
  ];
  const stale = identifyStaleSubitems(subitems, plRows);
  check('two stale (Complete + orphan, not active)', stale.length === 2, `got ${stale.length}`);
  const byId = Object.fromEntries(stale.map(s => [s.id, s.staleReason]));
  check('s-complete tagged complete', byId['s-complete'] === 'complete', `got ${byId['s-complete']}`);
  check('s-orphan tagged orphan',     byId['s-orphan']   === 'orphan',   `got ${byId['s-orphan']}`);
  check('s-active not in stale list', !('s-active' in byId), JSON.stringify(byId));
}

console.log('\nTest 12: PL row with masterPmLink=null is ignored (can\'t be cross-referenced)');
{
  // PL rows where the Master PM link was never populated (or was cleared)
  // can't be joined against subitems. They shouldn't cause crashes or affect
  // unrelated subitems. The relevant subitem in this test has a valid link
  // pointing to a different Master PM ID that ISN'T in plRows → orphan → stale.
  const subitems = [sub({ id: 's1', masterPmId: 'mpm-real' })];
  const plRows = [
    pl({ masterPmLink: null,   status: 'Complete' }),
    pl({ masterPmLink: 'mpm-other', status: 'Complete' }),
  ];
  const stale = identifyStaleSubitems(subitems, plRows);
  check('s1 is stale (orphan — its mpm not in plRows)', stale.length === 1 && stale[0]?.id === 's1',
        JSON.stringify(stale));
  check('staleReason=orphan', stale[0]?.staleReason === 'orphan', `staleReason=${stale[0]?.staleReason}`);
}

// ──────────────────────────────────────────────────────────────────────────

console.log();
if (failures.length > 0) {
  console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✅ All clean-stale-subitems tests passed (${checks} checks).`);
