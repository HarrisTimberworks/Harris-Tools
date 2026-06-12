#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildLeadTimesArtifacts, writeLeadTimes } = require('./write-lead-times.js');
const { CREW_BASE_HOURS } = require('./rebalance-schedule.js');

const failures = [];
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else { failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label} — ${detail}`); }
}

const fakeBasketResults = [
  { label: 'Typical residential FF', jobType: 'Res - Face Frame', display: 'Face frame', quotedWeek: '2026-09-07', weeks: 12 },
  { label: 'Typical residential FL', jobType: 'Res - Frameless', display: 'Frameless', quotedWeek: '2026-09-07', weeks: 12 },
  { label: 'Typical commercial', jobType: 'Commercial', display: 'Commercial', quotedWeek: '2026-08-24', weeks: 10 },
];

console.log('Test 1: artifact shape + no-leak (spec §4.5)');
const arts = buildLeadTimesArtifacts(fakeBasketResults, { now: () => new Date('2026-06-12T12:00:00Z') });
const json = JSON.parse(arts.json);
check('json has generatedAt + leadTimes', !!json.generatedAt && json.leadTimes.length === 3);
check('json entries carry display label + weeks + quotedWeek only',
  Object.keys(json.leadTimes[0]).sort().join(',') === 'label,quotedWeek,weeks',
  JSON.stringify(json.leadTimes[0]));
const allText = arts.json + arts.html;
check('NO capacityWeek anywhere', !allText.includes('capacityWeek') && !allText.includes('apacity'));
for (const crew of Object.keys(CREW_BASE_HOURS)) {
  check(`no crew name '${crew}' leaks`, !allText.includes(crew), 'shop internals in a public artifact');
}
check('html mentions all three types', arts.html.includes('Face frame') && arts.html.includes('Frameless') && arts.html.includes('Commercial'));
check('html carries as-of date', arts.html.includes('2026-06-12'));

console.log('Test 2: writeLeadTimes writes dated + stable + snippet files');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leadtimes-'));
(async () => {
  await writeLeadTimes(fakeBasketResults, { logsDir: tmp, now: () => new Date('2026-06-12T12:00:00Z') });
  check('dated json', fs.existsSync(path.join(tmp, 'lead-times-2026-06-12.json')));
  check('stable json', fs.existsSync(path.join(tmp, 'lead-times.json')));
  check('snippet html', fs.existsSync(path.join(tmp, 'lead-times-snippet.html')));

  console.log(failures.length ? `\n❌ ${failures.length}/${checks} FAILED` : `\n✅ all ${checks} checks passed`);
  process.exit(failures.length ? 1 : 0);
})();
