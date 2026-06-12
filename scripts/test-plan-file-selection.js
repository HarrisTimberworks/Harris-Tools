#!/usr/bin/env node
/**
 * Test for findLatestPlanFile — the executor's plan-file selector.
 *
 * Pinned to require .json suffix and ignore non-.json siblings (.bak,
 * .tmp, .old, etc.). See commit body for the 2026-05-10 incident that
 * motivated this — a stray .bak in logs/ outranked the real plan in
 * reverse-sorted order and got loaded by execute().
 *
 * Pure file-selection logic, no side effects on the production logs/
 * directory — uses os.tmpdir() fixtures.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { findLatestPlanFile } = require('./rebalance-schedule.js');

let checks = 0;
const failures = [];
function check(label, cond, detail) {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else { failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label} — ${detail}`); }
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-file-test-'));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('Test 1: empty directory → null');
{
  const dir = mkTmpDir();
  try {
    const result = findLatestPlanFile(dir);
    check('null on empty dir', result === null, `got: ${JSON.stringify(result)}`);
  } finally { cleanup(dir); }
}

console.log('\nTest 2: regression — .bak/.tmp/.old siblings DO NOT outrank the .json (the 5/10 incident)');
{
  const dir = mkTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'rebalance-plan-2026-05-09.json'), '{}');
    fs.writeFileSync(path.join(dir, 'rebalance-plan-2026-05-09.json.bak'), '{}');
    fs.writeFileSync(path.join(dir, 'rebalance-plan-2026-05-09.json.tmp'), '{}');
    fs.writeFileSync(path.join(dir, 'rebalance-plan-2026-05-09.json.old'), '{}');
    const result = findLatestPlanFile(dir);
    check('returns the .json file',
      result === 'rebalance-plan-2026-05-09.json',
      `got: ${result}`);
    check('result does not end in .bak/.tmp/.old',
      !/\.(bak|tmp|old)$/.test(result || ''),
      `got: ${result}`);
  } finally { cleanup(dir); }
}

console.log('\nTest 3: multiple .json files → returns lexicographically latest');
{
  const dir = mkTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'rebalance-plan-2026-05-08.json'), '{}');
    fs.writeFileSync(path.join(dir, 'rebalance-plan-2026-05-09.json'), '{}');
    fs.writeFileSync(path.join(dir, 'rebalance-plan-2026-05-10.json'), '{}');
    const result = findLatestPlanFile(dir);
    check('returns the 5/10 file (latest)',
      result === 'rebalance-plan-2026-05-10.json',
      `got: ${result}`);
  } finally { cleanup(dir); }
}

console.log('\nTest 4: files without rebalance-plan- prefix are ignored');
{
  const dir = mkTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'rebalance-plan-2026-05-09.json'), '{}');
    fs.writeFileSync(path.join(dir, 'unrelated.json'), '{}');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x');
    const result = findLatestPlanFile(dir);
    check('returns rebalance-plan-2026-05-09.json',
      result === 'rebalance-plan-2026-05-09.json',
      `got: ${result}`);
  } finally { cleanup(dir); }
}

console.log('\nTest 5: only non-.json siblings present → null (no real plan to load)');
{
  const dir = mkTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'rebalance-plan-2026-05-09.json.bak'), '{}');
    fs.writeFileSync(path.join(dir, 'rebalance-plan-2026-05-09.json.tmp'), '{}');
    const result = findLatestPlanFile(dir);
    check('null when only .bak/.tmp exist', result === null, `got: ${result}`);
  } finally { cleanup(dir); }
}

console.log('\nTest 6: AUDIT FIX — non-date suffixes never selected (snapshot/copy names sort after dates)');
{
  // 2026-06-11 audit: logs/rebalance-plan-pre-backfill-snapshot.json sorted
  // lexically AFTER every dated plan ('p' > '2') and would have been fed to
  // the next --execute. Only strict rebalance-plan-YYYY-MM-DD.json qualifies.
  const dir = mkTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'rebalance-plan-2026-06-12.json'), '{}');
    fs.writeFileSync(path.join(dir, 'rebalance-plan-pre-backfill-snapshot.json'), '{}');
    fs.writeFileSync(path.join(dir, 'rebalance-plan-2026-06-11-copy.json'), '{}');
    const result = findLatestPlanFile(dir);
    check('strict date name wins over snapshot/copy names',
      result === 'rebalance-plan-2026-06-12.json',
      `got: ${result}`);
  } finally { cleanup(dir); }
}

console.log();
if (failures.length > 0) {
  console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✅ All plan-file-selection tests passed (${checks} checks).`);
