#!/usr/bin/env node
/**
 * Stations-Complete tracking (2026-06-11, per Chris).
 *
 * New PLB multi-select column "✅ Stations Complete" (dropdown_mm48p4zs,
 * labels Eng/Panel/Bench/PreFin/PostFin) lets the shop mark each station
 * done in real time. Pure helpers under test:
 *
 *   computeRemainingHours(formulaHours, overrideRemaining, stationsComplete, hrsLeft)
 *     Precedence per station: board-done → 0 (ALWAYS wins, kills config
 *     staleness) → else board ⏳ Hrs Left (valid number ≥ 0, verbatim,
 *     never clamped) → else config remainingHours → else formula.
 *
 *   isReadyToShip(formulaHours, stationsComplete, hrsLeft)
 *     True when EVERY required station is marked done. Required = formula
 *     hours > 0 OR board ⏳ Hrs Left > 0 (board-added work can't be
 *     skipped). Drives the derived "Ready to Ship" status (planner keeps
 *     the job active so P&S/Delivery still plan — the Liz Stapp
 *     Complete-cliff fix).
 */

const {
  computeRemainingHours,
  isReadyToShip,
  isValidHrsLeft,
  parseHrsLeftCell,
  shopProgressWarnings,
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

  console.log('\nTest 7: ⏳ Hrs Left tier — between tick and config');
  {
    const HL = { eng: 7, panel: 5, bench: 0, prefin: null, postfin: 12 };
    const CFG = { eng: 4, panel: 8, bench: 2.3, prefin: 6, postfin: 5 };
    const h = computeRemainingHours(FORMULA, CFG, ['Eng'], HL);
    check('tick beats Hrs Left (Eng 0 despite ⏳7)', h.eng === 0, JSON.stringify(h));
    check('Hrs Left beats config (Panel 5 not 8)', h.panel === 5, JSON.stringify(h));
    check('explicit 0 honored (Bench 0 not 2.3)', h.bench === 0, JSON.stringify(h));
    check('empty cell falls through to config (PreFin 6)', h.prefin === 6, JSON.stringify(h));
    check('Hrs Left beats config (PostFin 12 not 5)', h.postfin === 12, JSON.stringify(h));
  }

  console.log('\nTest 8: ⏳ Hrs Left — formula fallback, overrun unclamped, invalid ignored, back-compat');
  {
    const h0 = computeRemainingHours(FORMULA, null, [], { eng: null, panel: null, bench: 1, prefin: null, postfin: null });
    check('no config: Hrs Left beats formula (Bench 1 not 2.3)', h0.bench === 1 && h0.panel === 19.5, JSON.stringify(h0));
    const h1 = computeRemainingHours(FORMULA, null, [], { eng: null, panel: 99, bench: null, prefin: null, postfin: null });
    check('overrun passes verbatim (99 > formula 19.5, never clamped)', h1.panel === 99, JSON.stringify(h1));
    const h2 = computeRemainingHours(FORMULA, null, [], { eng: -3, panel: NaN, bench: null, prefin: null, postfin: null });
    check('negative ignored → formula', h2.eng === 8.6, JSON.stringify(h2));
    check('NaN ignored → formula', h2.panel === 19.5, JSON.stringify(h2));
    const h3 = computeRemainingHours(FORMULA, null, []);
    check('missing 4th arg ≡ legacy behavior', h3.panel === 19.5 && h3.eng === 8.6, JSON.stringify(h3));
  }

  console.log('\nTest 9: isReadyToShip — ⏳ required-set extension');
  {
    const F = { eng: 4, panel: 8, bench: 0, prefin: 0, postfin: 5 };
    check('legacy 2-arg: all formula>0 ticked → true',
      isReadyToShip(F, ['Eng', 'Panel', 'PostFin']) === true, '');
    check('board-added work blocks RTS (bench formula 0, ⏳5, unticked)',
      isReadyToShip(F, ['Eng', 'Panel', 'PostFin'], { bench: 5 }) === false, '');
    check('ticking the board-added station restores RTS (tick wins per spec)',
      isReadyToShip(F, ['Eng', 'Panel', 'PostFin', 'Bench'], { bench: 5 }) === true, '');
    check('⏳0 does not add a required station',
      isReadyToShip(F, ['Eng', 'Panel', 'PostFin'], { bench: 0 }) === true, '');
    check('all-zero formulas + empty hrsLeft → still false',
      isReadyToShip({ eng: 0, panel: 0, bench: 0, prefin: 0, postfin: 0 }, ['Eng'], {}) === false, '');
    check('⏳-only required set: all-zero formulas + ⏳5 unticked → false',
      isReadyToShip({ eng: 0, panel: 0, bench: 0, prefin: 0, postfin: 0 }, [], { bench: 5 }) === false, '');
    check('⏳-only required set: ticking the station completes it → true',
      isReadyToShip({ eng: 0, panel: 0, bench: 0, prefin: 0, postfin: 0 }, ['Bench'], { bench: 5 }) === true, '');
  }

  console.log('\nTest 10: parseHrsLeftCell — monday numbers-column text');
  {
    check('empty string → null (empty cell ≠ 0)', parseHrsLeftCell('') === null, '');
    check('undefined → null', parseHrsLeftCell(undefined) === null, '');
    check('whitespace → null', parseHrsLeftCell('  ') === null, '');
    check('"0" → 0 (explicit zero)', parseHrsLeftCell('0') === 0, '');
    check('"102" → 102', parseHrsLeftCell('102') === 102, '');
    check('"2.3" → 2.3', parseHrsLeftCell('2.3') === 2.3, '');
    check('"1,234" → 1234 (thousands separator)', parseHrsLeftCell('1,234') === 1234, '');
    check('"-5" → -5 (sanitized downstream by isValidHrsLeft)', parseHrsLeftCell('-5') === -5, '');
    check('isValidHrsLeft rejects null/-5/NaN, accepts 0/2.3',
      !isValidHrsLeft(null) && !isValidHrsLeft(-5) && !isValidHrsLeft(NaN)
      && isValidHrsLeft(0) && isValidHrsLeft(2.3), '');
    check('isValidHrsLeft rejects strings and Infinity (type-strict gate)',
      !isValidHrsLeft('5') && !isValidHrsLeft(Infinity) && !isValidHrsLeft(parseHrsLeftCell('Infinity')), '');
  }

  console.log('\nTest 11: shopProgressWarnings — nudges, contradictions, overrun info');
  {
    const F = { eng: 4, panel: 8, bench: 10, prefin: 0, postfin: 5 };
    const empty = { eng: null, panel: null, bench: null, prefin: null, postfin: null };
    const jobs = [
      { name: 'NudgeJob', status: 'Scheduled', formulaHours: F,
        stationsComplete: [], hrsLeft: { ...empty, panel: 0 } },
      { name: 'ContraJob', status: 'Finishing', formulaHours: F,
        stationsComplete: ['Bench'], hrsLeft: { ...empty, bench: 6 } },
      { name: 'OverrunJob', status: 'Not Started', formulaHours: F,
        stationsComplete: [], hrsLeft: { ...empty, panel: 30 } },
      { name: 'InvalidJob', status: 'Scheduled', formulaHours: F,
        stationsComplete: [], hrsLeft: { ...empty, eng: -2 } },
      { name: 'CompleteJob', status: 'Complete', formulaHours: F,
        stationsComplete: [], hrsLeft: { ...empty, panel: 0 } },
      { name: 'QuietJob', status: 'Scheduled', formulaHours: F,
        stationsComplete: [], hrsLeft: { ...empty, panel: 5 } },
    ];
    const w = shopProgressWarnings(jobs);
    check('tick nudge fired', w.some(x => /NudgeJob Panel: .*0 but station not ticked/.test(x)), JSON.stringify(w));
    check('contradiction fired (tick wins)', w.some(x => /ContraJob Bench: ticked complete but/.test(x)), JSON.stringify(w));
    check('overrun info fired', w.some(x => /OverrunJob Panel: .*30 exceeds formula 8/.test(x)), JSON.stringify(w));
    check('invalid value fired', w.some(x => /InvalidJob Eng: invalid/.test(x)), JSON.stringify(w));
    check('Complete jobs skipped', !w.some(x => /CompleteJob/.test(x)), JSON.stringify(w));
    check('healthy partial entry silent (5 < formula 8)', !w.some(x => /QuietJob/.test(x)), JSON.stringify(w));
    check('exactly 4 warnings', w.length === 4, JSON.stringify(w));
    check('null/empty jobs safe', Array.isArray(shopProgressWarnings(null)) && shopProgressWarnings([]).length === 0, '');
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
