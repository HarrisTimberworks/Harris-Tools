#!/usr/bin/env node
// test-quote-engine.js — hermetic; no API, no token needed.
const reb = require('./rebalance-schedule.js');

const failures = [];
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else { failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label} — ${detail}`); }
}

console.log('Test 1: crew constants exported for quote engine');
check('CREW_BASE_HOURS exported', reb.CREW_BASE_HOURS && reb.CREW_BASE_HOURS.Ken === 40,
  `got ${JSON.stringify(reb.CREW_BASE_HOURS)}`);
check('BOB_START_DATE exported', reb.BOB_START_DATE === '2026-05-18', `got ${reb.BOB_START_DATE}`);
check('CREW_END_DATES exported', reb.CREW_END_DATES && typeof reb.CREW_END_DATES === 'object',
  `got ${JSON.stringify(reb.CREW_END_DATES)}`);

console.log('Test 2: policy loads and lints');
const { loadQuotePolicy, lintQuotePolicy } = require('./quote-engine.js');
const policy = loadQuotePolicy();
check('preProductionWeeks is 2', policy.preProductionWeeks === 2, `got ${policy.preProductionWeeks}`);
check('minLeadWeeks keyed by ROUTING keys', policy.minLeadWeeks['Res - Face Frame'] === 12,
  `got ${JSON.stringify(policy.minLeadWeeks)}`);
check('referenceBasket has 3 entries', policy.referenceBasket.length === 3);

console.log('Test 3: lint rejects bad shapes with named reasons');
check('bad job-type key named', lintQuotePolicy({ preProductionWeeks: 2, minLeadWeeks: { 'Res FF': 12 },
  defaultFinishingDays: 5, referenceBasket: [] }).some(e => e.includes('Res FF')),
  'expected an error naming the non-ROUTING key');
check('non-numeric weeks named', lintQuotePolicy({ preProductionWeeks: 'two', minLeadWeeks: {},
  defaultFinishingDays: 5, referenceBasket: [] }).some(e => e.includes('preProductionWeeks')));
check('clean policy lints clean', lintQuotePolicy(policy).length === 0,
  JSON.stringify(lintQuotePolicy(policy)));

console.log(failures.length ? `\n❌ ${failures.length}/${checks} FAILED` : `\n✅ all ${checks} checks passed`);
process.exit(failures.length ? 1 : 0);
