#!/usr/bin/env node
/**
 * Stations-Complete tracking (2026-06-11, per Chris).
 *
 * New PLB multi-select column "✅ Stations Complete" (dropdown_mm48p4zs,
 * labels Eng/Panel/Bench/PreFin/PostFin) lets the shop mark each station
 * done in real time. Pure helpers under test:
 *
 *   computeRemainingHours(formulaHours, overrideRemaining, stationsComplete)
 *     Precedence per station: board-done → 0 (ALWAYS wins, kills config
 *     staleness) → else config remainingHours → else formula.
 *
 *   isReadyToShip(formulaHours, stationsComplete)
 *     True when EVERY station with formula hours > 0 is marked done.
 *     Drives the derived "Ready to Ship" status (planner keeps the job
 *     active so P&S/Delivery still plan — the Liz Stapp Complete-cliff fix).
 */

const {
  computeRemainingHours,
  isReadyToShip,
  STATION_LABEL_TO_KEY,
} = require('./rebalance-schedule.js');

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

const FORMULA = { eng: 8.6, panel: 19.5, bench: 2.3, prefin: 0, postfin: 13.5 };

(async () => {

  console.log('Test 1: exports + label mapping');
  {
    check('computeRemainingHours is a function', typeof computeRemainingHours === 'function', typeof computeRemainingHours);
    check('isReadyToShip is a function', typeof isReadyToShip === 'function', typeof isReadyToShip);
    check('label map covers the 5 production stations',
      STATION_LABEL_TO_KEY.Eng === 'eng' && STATION_LABEL_TO_KEY.Panel === 'panel'
      && STATION_LABEL_TO_KEY.Bench === 'bench' && STATION_LABEL_TO_KEY.PreFin === 'prefin'
      && STATION_LABEL_TO_KEY.PostFin === 'postfin',
      JSON.stringify(STATION_LABEL_TO_KEY));
  }

  console.log('\nTest 2: no marks, no override → formula passthrough');
  {
    const h = computeRemainingHours(FORMULA, null, []);
    check('formula values intact', h.eng === 8.6 && h.panel === 19.5 && h.bench === 2.3 && h.prefin === 0 && h.postfin === 13.5, JSON.stringify(h));
  }

  console.log('\nTest 3: no marks + override → override wins (legacy behavior)');
  {
    const h = computeRemainingHours(FORMULA, { eng: 0, panel: 8, bench: 2.3, prefin: 0, postfin: 0 }, []);
    check('override values intact', h.eng === 0 && h.panel === 8 && h.postfin === 0, JSON.stringify(h));
  }

  console.log('\nTest 4: board-done beats BOTH override and formula');
  {
    // Station marked done on the board while a stale config override still
    // claims hours — the board wins (the whole point of the feature).
    const h = computeRemainingHours(FORMULA, { eng: 0, panel: 8, bench: 2.3, prefin: 0, postfin: 5 }, ['Panel', 'PostFin']);
    check('Panel zeroed despite override 8', h.panel === 0, JSON.stringify(h));
    check('PostFin zeroed despite override 5', h.postfin === 0, JSON.stringify(h));
    check('unmarked Bench keeps override 2.3', h.bench === 2.3, JSON.stringify(h));
  }

  console.log('\nTest 5: unknown labels ignored, missing/null stationsComplete safe');
  {
    const h1 = computeRemainingHours(FORMULA, null, ['Garbage', 'Eng']);
    check('unknown label ignored, Eng zeroed', h1.eng === 0 && h1.panel === 19.5, JSON.stringify(h1));
    const h2 = computeRemainingHours(FORMULA, null, null);
    check('null stationsComplete → formula passthrough', h2.panel === 19.5, JSON.stringify(h2));
  }

  console.log('\nTest 6: isReadyToShip — every formula>0 station done');
  {
    check('all-but-one done → false', isReadyToShip(FORMULA, ['Eng', 'Panel', 'Bench']) === false, '');
    check('all formula>0 stations done → true (PreFin=0 need not be marked)',
      isReadyToShip(FORMULA, ['Eng', 'Panel', 'Bench', 'PostFin']) === true, '');
    check('empty marks → false', isReadyToShip(FORMULA, []) === false, '');
    check('all-zero formulas → false (defensive: nothing to complete ≠ ready)',
      isReadyToShip({ eng: 0, panel: 0, bench: 0, prefin: 0, postfin: 0 }, ['Eng']) === false, '');
    check('missing args safe', isReadyToShip(undefined, undefined) === false, '');
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All stations-complete tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
