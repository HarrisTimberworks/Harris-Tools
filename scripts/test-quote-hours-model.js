#!/usr/bin/env node
// test-quote-hours-model.js — factors are spec §4.1; live-board drift guarded by Task 3.
const { JOB_TYPES, COMPLEXITY_MULT, STATION_FACTORS, computeQuoteHours, normalizeComplexity } =
  require('./quote-hours-model.js');
const { ROUTING } = require('./rebalance-schedule.js');

const failures = [];
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else { failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label} — ${detail}`); }
}

console.log('Test 1: every job type is a real planner ROUTING key (spec §2 — one vocabulary)');
for (const jt of Object.keys(JOB_TYPES)) {
  check(`'${jt}' in ROUTING`, !!ROUTING[jt], `ROUTING keys: ${Object.keys(ROUTING).join(', ')}`);
}

console.log('Test 2: FF 25-box complexity 2 (mult 1.0) — exact station hours');
const r = computeQuoteHours('Res - Face Frame', 25, 2);
check('eng 15',      r.hours.eng === 15,      `got ${r.hours.eng}`);        // 0.6  * 25
check('panel 13.8',  r.hours.panel === 13.8,  `got ${r.hours.panel}`);      // 0.55 * 25 = 13.75 → 13.8
check('bench 7.5',   r.hours.bench === 7.5,   `got ${r.hours.bench}`);      // 0.3  * 25
check('prefin 27.5', r.hours.prefin === 27.5, `got ${r.hours.prefin}`);     // 1.10 * 25
check('postfin 11.3',r.hours.postfin === 11.3,`got ${r.hours.postfin}`);    // 0.45 * 25 = 11.25 → 11.3

console.log('Test 3: FL job — prefin is zero (spec table)');
const fl = computeQuoteHours('Res - Frameless', 10, 2);
check('prefin 0', fl.hours.prefin === 0, `got ${fl.hours.prefin}`);
check('postfin 6.5', fl.hours.postfin === 6.5, `got ${fl.hours.postfin}`);  // 0.65 * 10

console.log('Test 4: Commercial maps to FL boxes');
const co = computeQuoteHours('Commercial', 10, 2);
check('eng 4 (FL 0.4)', co.hours.eng === 4, `got ${co.hours.eng}`);

console.log('Test 5: complexity multiplies ALL five stations (live-board behavior)');
const c5 = computeQuoteHours('Res - Face Frame', 10, 5);   // mult 1.75
check('eng 10.5', c5.hours.eng === 10.5, `got ${c5.hours.eng}`);            // 0.6*10*1.75
check('panel 9.6', c5.hours.panel === 9.6, `got ${c5.hours.panel}`);        // 0.55*10*1.75=9.625→9.6

console.log('Test 6: complexity rounding + bounds (spec §4.4)');
check('2.4 → 2', normalizeComplexity(2.4) === 2);
check('2.5 → 3', normalizeComplexity(2.5) === 3);
check('empty/NaN → null', normalizeComplexity('abc') === null);
check('6 → null (out of range)', normalizeComplexity(6) === null);
check('0 → null', normalizeComplexity(0) === null);
check('computeQuoteHours echoes complexityUsed', computeQuoteHours('Commercial', 5, 3.4).complexityUsed === 3);

let threw = false;
try { computeQuoteHours('Res FF', 5, 2); } catch (e) { threw = true; }
console.log('Test 7: shorthand job type rejected (the routing-key bug class)');
check('throws on unknown job type', threw);

console.log(failures.length ? `\n❌ ${failures.length}/${checks} FAILED` : `\n✅ all ${checks} checks passed`);
process.exit(failures.length ? 1 : 0);
