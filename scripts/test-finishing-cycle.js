#!/usr/bin/env node
/**
 * A2 test — finishing-cycle integrity for computeWindows().
 *
 * For each non-pLam fixture with finishingDays > 0, asserts:
 *   1. addBusinessDays(prefin.end, 1) <= finishDrop
 *      (Pre-Fin assembly completes the business day before the finisher arrives)
 *   2. finishReturn <= postfin.start
 *      (Finisher returns cabs no later than the Monday Post-Fin assembly starts)
 *
 * Fixtures are pinned to the values the four bug-affected jobs had in monday on
 * 2026-05-08 (the iter-8 baseline). Refresh via: node scripts/fetch-fixture-jobs.js.
 *
 * Runs without MONDAY_API_TOKEN — the script-under-test's CLI guard is gated
 * behind require.main === module so import is side-effect-free.
 */

const { computeWindows, addBusinessDays } = require('./rebalance-schedule.js');

const FIXTURES = [
  {
    id: '11693170191',
    name: 'SH - McMorris',
    delivery: '2026-06-19',
    finishingDays: 10,
    pLam: false,
    hours: { eng: 37.9, panel: 34.8, bench: 19, prefin: 90.4, postfin: 37 },
    customWindow: null,
    parallelPostFin: false,
  },
  {
    id: '11693177783',
    name: 'F&B - Quince Ave',
    delivery: '2026-05-29',
    finishingDays: 5,
    pLam: false,
    hours: { eng: 10.4, panel: 8.2, bench: 7, prefin: 12, postfin: 6.2 },
    customWindow: null,
    parallelPostFin: false,
  },
  {
    id: '11693164567',
    name: 'Liz Stapp - Laundry Room',
    delivery: '2026-06-03',
    finishingDays: 4,
    pLam: false,
    hours: { eng: 3, panel: 2.8, bench: 1.5, prefin: 5.5, postfin: 2.3 },
    customWindow: null,
    parallelPostFin: false,
  },
  {
    id: '11693166446',
    name: 'SHI - Huntington Hills',
    delivery: '2026-06-03',
    finishingDays: 4,
    pLam: false,
    hours: { eng: 0.6, panel: 1.6, bench: 0.2, prefin: 3.2, postfin: 1 },
    customWindow: null,
    parallelPostFin: false,
  },
  {
    id: '11693187209',
    name: 'Gilbert - Dining Room & Range Hood',
    delivery: '2026-05-22',
    finishingDays: 4,
    pLam: false,
    hours: { eng: 0, panel: 3.3, bench: 1, prefin: 8.9, postfin: 2 },
    customWindow: null,
    parallelPostFin: false,
  },
  {
    id: '11693166519',
    name: 'VV - Wrangler Way',
    delivery: '2026-07-06',
    finishingDays: 5,
    pLam: false,
    hours: { eng: 11.2, panel: 11.2, bench: 3.2, prefin: 11.3, postfin: 11.7 },
    customWindow: null,
    parallelPostFin: false,
  },
];

const failures = [];
let checked = 0;

for (const job of FIXTURES) {
  const w = computeWindows(job);
  if (!w) { failures.push(`${job.name}: computeWindows returned null`); continue; }
  if (job.pLam || job.finishingDays <= 0) continue;

  const issues = [];
  if (!w.prefin) issues.push('no prefin window');
  if (!w.postfin) issues.push('no postfin window');
  if (!w.finishDrop) issues.push('no finishDrop');
  if (!w.finishReturn) issues.push('no finishReturn');

  if (issues.length === 0) {
    const prefinEndPlus1 = addBusinessDays(w.prefin.end, 1);
    if (prefinEndPlus1 > w.finishDrop) {
      issues.push(`prefin.end+1BD (${prefinEndPlus1}) > finishDrop (${w.finishDrop})`);
    }
    if (w.finishReturn > w.postfin.start) {
      issues.push(`finishReturn (${w.finishReturn}) > postfin.start (${w.postfin.start})`);
    }
  }

  checked++;
  if (issues.length > 0) {
    failures.push(
      `${job.name} (delivery=${job.delivery}, finishingDays=${job.finishingDays}):\n` +
      `  prefin=${JSON.stringify(w.prefin)} postfin=${JSON.stringify(w.postfin)}\n` +
      `  finishDrop=${w.finishDrop} finishReturn=${w.finishReturn}\n` +
      `  ${issues.join('; ')}`
    );
  }
}

console.log(`\nChecked ${checked} non-pLam fixtures with finishingDays > 0`);
if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} failure(s):\n`);
  for (const f of failures) console.log(`- ${f}\n`);
  process.exit(1);
}
console.log('✅ All finishing-cycle invariants hold.');
