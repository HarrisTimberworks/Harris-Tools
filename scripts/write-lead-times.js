#!/usr/bin/env node
/**
 * Dealer-portal lead-times artifacts (spec §4.5). HEADLINE NUMBERS ONLY —
 * quotedWeek (post-policy-floor), never capacityWeek, never crew/job/load
 * detail: the transport may end up public. test-write-lead-times.js enforces.
 * Runs as the third independent writer in run-planner's outputs stage
 * (per-writer failure policy) and standalone: `node scripts/write-lead-times.js`.
 */
const fs = require('fs');
const path = require('path');
const DEFAULT_LOGS_DIR = path.join(__dirname, '..', 'logs');

function localDateISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildLeadTimesArtifacts(basketResults, { now = () => new Date() } = {}) {
  const asOf = localDateISO(now());
  const json = JSON.stringify({
    generatedAt: now().toISOString(),
    leadTimes: basketResults.map(r => ({ label: r.display, weeks: r.weeks, quotedWeek: r.quotedWeek })),
  }, null, 2);
  const parts = basketResults.map(r => `${r.display} ~${r.weeks} wks`);
  const html = `<div class="htw-lead-times">Current lead times: ${parts.join(' · ')} <span class="asof">· as of ${asOf}</span></div>\n`;
  return { json, html, asOf };
}

async function writeLeadTimes(basketResults, { logsDir = DEFAULT_LOGS_DIR, now = () => new Date(), dryRun = false } = {}) {
  const { json, html, asOf } = buildLeadTimesArtifacts(basketResults, { now });
  const files = [
    [path.join(logsDir, `lead-times-${asOf}.json`), json],
    [path.join(logsDir, 'lead-times.json'), json],
    [path.join(logsDir, 'lead-times-snippet.html'), html],
  ];
  if (dryRun) { console.log(`  [DRY RUN] would write: ${files.map(f => path.basename(f[0])).join(', ')}`); return { dryRun: true, files: files.map(f => f[0]) }; }
  fs.mkdirSync(logsDir, { recursive: true });
  for (const [p, content] of files) fs.writeFileSync(p, content);
  return { files: files.map(f => f[0]) };
}

module.exports = { buildLeadTimesArtifacts, writeLeadTimes };

if (require.main === module) {
  (async () => {
    const { loadAll } = require('./rebalance-schedule.js');
    const { loadQuotePolicy, leadTimesForBasket } = require('./quote-engine.js');
    const policy = loadQuotePolicy();
    const boards = await loadAll({});
    const basket = await leadTimesForBasket(boards, policy);
    const r = await writeLeadTimes(basket, { dryRun: process.env.DRY_RUN === '1' });
    console.log(`✓ lead-times artifacts: ${r.files.join(', ')}`);
  })().catch(e => { console.error(e); process.exit(1); });
}
