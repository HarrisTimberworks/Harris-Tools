#!/usr/bin/env node
/**
 * Ian departure (2026-06-11) — validate-cross-training.js regression test.
 *
 * Commit 816c8ce rewrote ROUTING/SECONDARY in the schedulers and the matrix
 * doc (§3-§5), but validate-cross-training.js MATRIX was missed:
 *   - Ian still listed Bench/PreFin/PostFin as Primary, so post-departure
 *     subitems assigned to Ian would flag "Primary" instead of surfacing as
 *     a mis-assignment ("Not Trained").
 *   - Jonathan had no Benchwork key despite the new bench chain
 *     (Bob > Spencer > Jonathan), so a legit Jonathan bench row would flag
 *     "Not Trained".
 *
 * Asserts (matrix doc §3/§4/§6; rebalance-schedule.js read-only reference):
 *   1. validate-cross-training.js loads as a module (no token check / main()
 *      at require time — same require.main guard pattern as the schedulers)
 *   2. MATRIX matches the doc §3/§4/§6 per-person shapes, collapsed to
 *      station level (Primary for any subtype wins over Secondary)
 *   3. MATRIX hygiene: valid stations/levels, every mapped person present
 *   4. Jonathan Benchwork flags Secondary (the index-2 bug)
 *   5. Ian is week-gated: 'Not Trained' for week >= 2026-06-11, historical
 *      Primary/Secondary preserved for earlier weeks
 *   6. Ian gating parity with rebalance-schedule.js hardRuleViolation
 *   7. Cross-consistency: every rebalance ROUTING primary is MATRIX
 *      'Primary'; every SECONDARY crew is trained at that station
 *   8. resolveCrewName still resolves historical rows + Ken's text column
 *
 * Runs without MONDAY_API_TOKEN.
 */

const vct = require('./validate-cross-training.js');
const rebal = require('./rebalance-schedule.js');

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

// Canonical JSON (sorted keys) so insertion-order differences don't matter
function canon(obj) {
  if (Array.isArray(obj)) return obj.map(canon);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj).sort()) out[k] = canon(obj[k]);
    return out;
  }
  return obj;
}
const cjson = obj => JSON.stringify(canon(obj));

const STATIONS = ['Engineering', 'Panel Processing', 'Benchwork', 'Pre Fin Cab Assembly',
                  'Post Fin Cab Assembly', 'Pack & Ship', 'Delivery'];

// Doc §3 (primaries) + §4 (secondaries, union over subtypes) + §6 (profiles),
// collapsed to station level: Primary for ANY subtype wins, else Secondary if
// listed for any subtype, else absent (= Not Trained).
const EXPECTED_MATRIX = {
  // §6 Chris: Eng Primary FF/FL/Mixed (Comm/CS Secondary collapses up)
  Chris:    { Engineering: 'Primary' },
  // §6 Jonathan: Eng Primary Comm/CS; §4 bench chain Spencer > Jonathan;
  // §4/§6 P&S + Delivery Secondary. PreFin/PostFin dropped in the 6/11 chains.
  Jonathan: {
    Engineering:            'Primary',
    Benchwork:              'Secondary',
    'Pack & Ship':          'Secondary',
    Delivery:               'Secondary',
  },
  // §6 Paisios: P&S/Delivery Primary; Eng Secondary (in training, never §3
  // primary); Bench light-work Secondary; PostFin Secondary. No PreFin.
  Paisios: {
    Engineering:            'Secondary',
    Benchwork:              'Secondary',
    'Post Fin Cab Assembly':'Secondary',
    'Pack & Ship':          'Primary',
    Delivery:               'Primary',
  },
  // §6 Rob: Engineering fill-only, remote PT
  Rob:      { Engineering: 'Secondary' },
  // §6 Ian historical shape, preserved verbatim so pre-departure rows keep
  // validating as they did; the DEPARTED gate handles week >= 2026-06-11.
  Ian: {
    Benchwork:              'Primary',
    'Pre Fin Cab Assembly': 'Primary',
    'Post Fin Cab Assembly':'Primary',
    'Pack & Ship':          'Secondary',
    Delivery:               'Secondary',
  },
  // §3 PreFin primary uniform Spencer; §6 Spencer: Bench Primary FF/Mixed,
  // PostFin/P&S/Delivery Secondary
  Spencer: {
    Benchwork:              'Primary',
    'Pre Fin Cab Assembly': 'Primary',
    'Post Fin Cab Assembly':'Secondary',
    'Pack & Ship':          'Secondary',
    Delivery:               'Secondary',
  },
  // §6 Ken: Panel Primary; PreFin Commercial-emergency / PostFin
  // Commercial-only (station-level MATRIX can't carry the subtype nuance)
  Ken: {
    'Panel Processing':     'Primary',
    'Pre Fin Cab Assembly': 'Secondary',
    'Post Fin Cab Assembly':'Secondary',
    'Pack & Ship':          'Secondary',
    Delivery:               'Secondary',
  },
  // §3 Bench/PostFin primary uniform Bob; §6 Bob: PreFin now Secondary
  // (Spencer took Primary in the 6/11 chains), Panel/P&S/Delivery Secondary
  Bob: {
    'Panel Processing':     'Secondary',
    Benchwork:              'Primary',
    'Pre Fin Cab Assembly': 'Secondary',
    'Post Fin Cab Assembly':'Primary',
    'Pack & Ship':          'Secondary',
    Delivery:               'Secondary',
  },
};

console.log('Test 1: module exports present (require.main guard, no token needed)');
{
  check('MATRIX exported', !!vct.MATRIX, 'module.exports.MATRIX missing');
  check('DEPARTED exported', !!vct.DEPARTED, 'module.exports.DEPARTED missing');
  check('getExpectedFlag exported', typeof vct.getExpectedFlag === 'function',
        `got ${typeof vct.getExpectedFlag}`);
  check('resolveCrewName exported', typeof vct.resolveCrewName === 'function',
        `got ${typeof vct.resolveCrewName}`);
  check('FLAG_INDEX exported', !!vct.FLAG_INDEX, 'module.exports.FLAG_INDEX missing');
  check('PERSON_TO_NAME exported', !!vct.PERSON_TO_NAME, 'module.exports.PERSON_TO_NAME missing');
}

if (failures.length > 0) {
  console.log(`\n❌ aborting — module not loadable/exported correctly`);
  process.exit(1);
}

console.log('\nTest 2: MATRIX matches matrix doc §3/§4/§6 (post-departure, revised 2026-06-11)');
{
  for (const person of Object.keys(EXPECTED_MATRIX)) {
    check(`MATRIX['${person}'] matches doc`, cjson(vct.MATRIX[person]) === cjson(EXPECTED_MATRIX[person]),
          `got ${JSON.stringify(vct.MATRIX[person])}`);
  }
  const extras = Object.keys(vct.MATRIX).filter(p => !EXPECTED_MATRIX[p]);
  check('no unexpected people in MATRIX', extras.length === 0, extras.join(', '));
  check('DEPARTED gates Ian at 2026-06-11', vct.DEPARTED.Ian === '2026-06-11',
        `got ${JSON.stringify(vct.DEPARTED)}`);
}

console.log('\nTest 3: MATRIX hygiene');
{
  const badStations = [];
  const badLevels = [];
  for (const [person, m] of Object.entries(vct.MATRIX)) {
    for (const [st, level] of Object.entries(m)) {
      if (!STATIONS.includes(st)) badStations.push(`${person}/${st}`);
      if (level !== 'Primary' && level !== 'Secondary') badLevels.push(`${person}/${st}=${level}`);
    }
  }
  check('all MATRIX stations valid', badStations.length === 0, badStations.join(', '));
  check('all MATRIX levels Primary|Secondary', badLevels.length === 0, badLevels.join(', '));
  const unmapped = Object.values(vct.PERSON_TO_NAME).filter(n => !vct.MATRIX[n]);
  check('every PERSON_TO_NAME crew has a MATRIX entry', unmapped.length === 0, unmapped.join(', '));
  check('Ken (text-column crew) has a MATRIX entry', !!vct.MATRIX.Ken, 'missing');
}

console.log('\nTest 4: Jonathan Benchwork flags Secondary (was "Not Trained")');
{
  check('Jonathan/Benchwork @ 2026-06-15 -> Secondary',
        vct.getExpectedFlag('Jonathan', 'Benchwork', '2026-06-15') === 'Secondary',
        `got ${vct.getExpectedFlag('Jonathan', 'Benchwork', '2026-06-15')}`);
  check('Jonathan/Pre Fin @ 2026-06-15 -> Not Trained (dropped in 6/11 chains)',
        vct.getExpectedFlag('Jonathan', 'Pre Fin Cab Assembly', '2026-06-15') === 'Not Trained',
        `got ${vct.getExpectedFlag('Jonathan', 'Pre Fin Cab Assembly', '2026-06-15')}`);
}

console.log('\nTest 5: week-gated Ian departure');
{
  check('Ian/Benchwork @ 2026-06-08 (departure week Monday, pre-gate) -> Primary',
        vct.getExpectedFlag('Ian', 'Benchwork', '2026-06-08') === 'Primary',
        `got ${vct.getExpectedFlag('Ian', 'Benchwork', '2026-06-08')}`);
  check('Ian/Benchwork @ 2026-06-11 (boundary) -> Not Trained',
        vct.getExpectedFlag('Ian', 'Benchwork', '2026-06-11') === 'Not Trained',
        `got ${vct.getExpectedFlag('Ian', 'Benchwork', '2026-06-11')}`);
  check('Ian/Post Fin @ 2026-06-15 -> Not Trained',
        vct.getExpectedFlag('Ian', 'Post Fin Cab Assembly', '2026-06-15') === 'Not Trained',
        `got ${vct.getExpectedFlag('Ian', 'Post Fin Cab Assembly', '2026-06-15')}`);
  check('Ian/Pack & Ship @ 2026-05-18 (history) -> Secondary',
        vct.getExpectedFlag('Ian', 'Pack & Ship', '2026-05-18') === 'Secondary',
        `got ${vct.getExpectedFlag('Ian', 'Pack & Ship', '2026-05-18')}`);
  check('Ian/Engineering @ 2026-05-18 (never trained) -> Not Trained',
        vct.getExpectedFlag('Ian', 'Engineering', '2026-05-18') === 'Not Trained',
        `got ${vct.getExpectedFlag('Ian', 'Engineering', '2026-05-18')}`);
  // main() warns+skips departed-crew rows with no parent week; the pure
  // function treats a missing week as historical (no false red flags).
  check('Ian/Benchwork with missing week -> historical Primary',
        vct.getExpectedFlag('Ian', 'Benchwork', undefined) === 'Primary',
        `got ${vct.getExpectedFlag('Ian', 'Benchwork', undefined)}`);
}

console.log('\nTest 6: Ian gating parity with rebalance-schedule.js hardRuleViolation');
{
  const weeks = ['2026-05-11', '2026-05-18', '2026-06-08', '2026-06-11', '2026-06-15', '2026-09-07'];
  const mismatches = [];
  for (const st of Object.keys(vct.MATRIX.Ian)) {
    for (const wk of weeks) {
      const blocked = !!rebal.hardRuleViolation('Ian', st, 'Commercial', wk);
      const flagged = vct.getExpectedFlag('Ian', st, wk) === 'Not Trained';
      if (blocked !== flagged) {
        mismatches.push(`Ian/${st}/${wk}: rebal blocked=${blocked} validator NotTrained=${flagged}`);
      }
    }
  }
  check(`parity across ${Object.keys(vct.MATRIX.Ian).length * weeks.length} (station × week) combos`,
        mismatches.length === 0, mismatches.slice(0, 5).join('; '));
}

console.log('\nTest 7: cross-consistency with rebalance ROUTING/SECONDARY (post-departure)');
{
  const wk = '2026-06-15';
  const notPrimary = [];
  for (const sub of Object.keys(rebal.ROUTING)) {
    for (const [st, crews] of Object.entries(rebal.ROUTING[sub])) {
      for (const crew of crews) {
        if (vct.getExpectedFlag(crew, st, wk) !== 'Primary') {
          notPrimary.push(`${sub}/${st}/${crew}=${vct.getExpectedFlag(crew, st, wk)}`);
        }
      }
    }
  }
  check('every ROUTING primary flags Primary in MATRIX', notPrimary.length === 0,
        notPrimary.slice(0, 5).join('; '));

  const untrained = [];
  for (const sub of Object.keys(rebal.SECONDARY)) {
    for (const [st, crews] of Object.entries(rebal.SECONDARY[sub])) {
      for (const crew of crews) {
        const flag = vct.getExpectedFlag(crew, st, wk);
        if (flag !== 'Primary' && flag !== 'Secondary') {
          untrained.push(`${sub}/${st}/${crew}=${flag}`);
        }
      }
    }
  }
  check('every SECONDARY crew is trained at that station', untrained.length === 0,
        untrained.slice(0, 5).join('; '));
}

console.log('\nTest 8: resolveCrewName unchanged (historical rows + Ken text column)');
{
  check('assigned-text wins: ("", "Ken") -> Ken',
        vct.resolveCrewName('', 'Ken') === 'Ken', `got ${vct.resolveCrewName('', 'Ken')}`);
  check('"ian ratcliffe" -> Ian (historical rows still resolvable)',
        vct.resolveCrewName('ian ratcliffe', '') === 'Ian', `got ${vct.resolveCrewName('ian ratcliffe', '')}`);
  check('multi-person takes first: "Chris Harris, Jonathan Korban" -> Chris',
        vct.resolveCrewName('Chris Harris, Jonathan Korban', '') === 'Chris',
        `got ${vct.resolveCrewName('Chris Harris, Jonathan Korban', '')}`);
  check('unknown display name passes through',
        vct.resolveCrewName('Somebody New', '') === 'Somebody New',
        `got ${vct.resolveCrewName('Somebody New', '')}`);
  check('unknown crew -> null from getExpectedFlag (caller warns)',
        vct.getExpectedFlag('Somebody New', 'Benchwork', '2026-06-15') === null,
        `got ${vct.getExpectedFlag('Somebody New', 'Benchwork', '2026-06-15')}`);
}

console.log();
if (failures.length > 0) {
  console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✅ All cross-training validator tests passed (${checks} checks).`);
