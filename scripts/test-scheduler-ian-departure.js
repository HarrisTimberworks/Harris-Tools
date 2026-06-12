#!/usr/bin/env node
/**
 * Ian departure (2026-06-11) — schedule-production-jobs.js regression test.
 *
 * Commit 816c8ce rewrote ROUTING/SECONDARY and added the week-gated Ian hard
 * rule in rebalance-schedule.js, but schedule-production-jobs.js (the 15-min
 * Task Scheduler entry via run-scheduler.bat) was missed: its ROUTING still
 * listed Ian as Primary for Bench/PreFin (Res-FL, Commercial, C/S) and
 * ['Ian','Bob'] PostFin on all subtypes, and its hardRuleViolation had no
 * departure rule — so any job flipping to "Ready to Schedule" would create
 * Crew Allocation subitems assigned to departed Ian.
 *
 * Asserts (matrix doc §3/§5; rebalance-schedule.js is the authoritative
 * post-departure shape, read-only):
 *   1. schedule-production-jobs.js loads as a module (no token check / main()
 *      at require time — same require.main guard pattern as rebalance)
 *   2. ROUTING matches the doc §3 post-departure matrix exactly
 *   3. ROUTING deep-equals rebalance-schedule.js ROUTING (parity)
 *   4. Ian appears nowhere in ROUTING
 *   5. hardRuleViolation blocks Ian for week >= 2026-06-11; pre-departure
 *      weeks stay valid (null)
 *   6. hardRuleViolation null/violation parity with rebalance-schedule.js
 *      across a full (crew × station × subtype × week) sweep
 *   7. pre-existing hard rules still fire (Ken bench, Spencer eng, Bob start)
 *   8. every routed crew is Ken or has a CREW_USER_ID entry
 *   9. post-departure weeks have at least one unblocked Primary for every
 *      subtype × station (no "no primaries available" gaps)
 *
 * Runs without MONDAY_API_TOKEN.
 */

const sched = require('./schedule-production-jobs.js');
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

const SUBTYPES = ['Res - Face Frame', 'Res - Frameless', 'Commercial', 'Countertop/Surface', 'Mixed'];
const STATIONS = ['Engineering', 'Panel Processing', 'Benchwork', 'Pre Fin Cab Assembly',
                  'Post Fin Cab Assembly', 'Pack & Ship', 'Delivery'];
const CREWS = ['Chris', 'Jonathan', 'Paisios', 'Rob', 'Ian', 'Spencer', 'Ken', 'Bob'];

console.log('Test 1: module exports present');
{
  check('ROUTING exported', !!sched.ROUTING, 'module.exports.ROUTING missing');
  check('hardRuleViolation exported', typeof sched.hardRuleViolation === 'function',
        `got ${typeof sched.hardRuleViolation}`);
  check('CREW_USER_ID exported', !!sched.CREW_USER_ID, 'module.exports.CREW_USER_ID missing');
}

if (failures.length > 0) {
  console.log(`\n❌ aborting — module not loadable/exported correctly`);
  process.exit(1);
}

console.log('\nTest 2: ROUTING matches matrix doc §3 (post-departure, revised 2026-06-11)');
{
  // Doc §3: Bench=Bob, PreFin=Spencer, PostFin=Bob uniform across subtypes;
  // Eng Chris (FF/FL/Mixed) / Jonathan (Comm/CS); Panel Ken; P&S+Delivery Paisios.
  const ENG = { 'Res - Face Frame': 'Chris', 'Res - Frameless': 'Chris', 'Commercial': 'Jonathan',
                'Countertop/Surface': 'Jonathan', 'Mixed': 'Chris' };
  for (const sub of SUBTYPES) {
    const expected = {
      'Engineering':            [ENG[sub]],
      'Panel Processing':       ['Ken'],
      'Benchwork':              ['Bob'],
      'Pre Fin Cab Assembly':   ['Spencer'],
      'Post Fin Cab Assembly':  ['Bob'],
      'Pack & Ship':            ['Paisios'],
      'Delivery':               ['Paisios'],
    };
    check(`ROUTING['${sub}'] matches doc §3`, cjson(sched.ROUTING[sub]) === cjson(expected),
          `got ${JSON.stringify(sched.ROUTING[sub])}`);
  }
}

console.log('\nTest 3: ROUTING parity with rebalance-schedule.js (authoritative)');
{
  check('ROUTING deep-equals rebalance ROUTING', cjson(sched.ROUTING) === cjson(rebal.ROUTING),
        'shapes diverge — diff the two ROUTING objects');
}

console.log('\nTest 4: Ian appears nowhere in ROUTING');
{
  const ianSlots = [];
  for (const sub of Object.keys(sched.ROUTING)) {
    for (const st of Object.keys(sched.ROUTING[sub])) {
      if (sched.ROUTING[sub][st].includes('Ian')) ianSlots.push(`${sub}/${st}`);
    }
  }
  check('no Ian in any ROUTING slot', ianSlots.length === 0, ianSlots.join(', '));
}

console.log('\nTest 5: week-gated Ian hard rule');
{
  check('Ian blocked @ 2026-06-15 (post-departure Monday)',
        !!sched.hardRuleViolation('Ian', 'Benchwork', 'Commercial', '2026-06-15'), 'returned null');
  check('Ian blocked @ 2026-06-11 (boundary, departure date)',
        !!sched.hardRuleViolation('Ian', 'Post Fin Cab Assembly', 'Res - Face Frame', '2026-06-11'),
        'returned null');
  check('Ian blocked regardless of station/subtype',
        !!sched.hardRuleViolation('Ian', 'Pack & Ship', 'Mixed', '2026-09-07'), 'returned null');
  check('Ian OK @ 2026-06-08 (departure week Monday, pre-gate — matches rebalance)',
        sched.hardRuleViolation('Ian', 'Benchwork', 'Commercial', '2026-06-08') === null,
        `got ${sched.hardRuleViolation('Ian', 'Benchwork', 'Commercial', '2026-06-08')}`);
  check('Ian OK @ 2026-05-18 (pre-departure history stays valid)',
        sched.hardRuleViolation('Ian', 'Pre Fin Cab Assembly', 'Res - Frameless', '2026-05-18') === null,
        `got ${sched.hardRuleViolation('Ian', 'Pre Fin Cab Assembly', 'Res - Frameless', '2026-05-18')}`);
}

console.log('\nTest 6: hardRuleViolation null/violation parity with rebalance across full sweep');
{
  const weeks = ['2026-05-11', '2026-05-18', '2026-06-08', '2026-06-11', '2026-06-15', '2026-09-07'];
  const mismatches = [];
  for (const crew of CREWS) {
    for (const st of STATIONS) {
      for (const sub of SUBTYPES) {
        for (const wk of weeks) {
          const a = sched.hardRuleViolation(crew, st, sub, wk);
          const b = rebal.hardRuleViolation(crew, st, sub, wk);
          if (!!a !== !!b) mismatches.push(`${crew}/${st}/${sub}/${wk}: sched=${a} rebal=${b}`);
        }
      }
    }
  }
  check(`parity across ${CREWS.length * STATIONS.length * SUBTYPES.length * weeks.length} combos`,
        mismatches.length === 0, `${mismatches.length} mismatch(es): ${mismatches.slice(0, 5).join('; ')}`);
}

console.log('\nTest 7: pre-existing hard rules intact');
{
  check('Ken blocked from Benchwork',
        !!sched.hardRuleViolation('Ken', 'Benchwork', 'Commercial', '2026-06-15'), 'returned null');
  check('Ken PostFin blocked for non-Commercial',
        !!sched.hardRuleViolation('Ken', 'Post Fin Cab Assembly', 'Res - Face Frame', '2026-06-15'),
        'returned null');
  check('Spencer blocked from Engineering',
        !!sched.hardRuleViolation('Spencer', 'Engineering', 'Mixed', '2026-06-15'), 'returned null');
  check('Bob blocked before 2026-05-18',
        !!sched.hardRuleViolation('Bob', 'Benchwork', 'Commercial', '2026-05-11'), 'returned null');
  check('Bob OK from 2026-05-18',
        sched.hardRuleViolation('Bob', 'Benchwork', 'Commercial', '2026-05-18') === null,
        `got ${sched.hardRuleViolation('Bob', 'Benchwork', 'Commercial', '2026-05-18')}`);
}

console.log('\nTest 8: every routed crew is Ken or has a CREW_USER_ID entry');
{
  const unmapped = [];
  for (const sub of Object.keys(sched.ROUTING)) {
    for (const st of Object.keys(sched.ROUTING[sub])) {
      for (const crew of sched.ROUTING[sub][st]) {
        if (crew !== 'Ken' && !sched.CREW_USER_ID[crew]) unmapped.push(`${sub}/${st}/${crew}`);
      }
    }
  }
  check('all routed crew resolvable', unmapped.length === 0, unmapped.join(', '));
}

console.log('\nTest 9: no subtype × station left without an unblocked Primary post-departure');
{
  const gaps = [];
  for (const wk of ['2026-06-15', '2026-07-06']) {
    for (const sub of SUBTYPES) {
      for (const st of STATIONS) {
        const primaries = (sched.ROUTING[sub][st] || [])
          .filter(c => !sched.hardRuleViolation(c, st, sub, wk));
        if (primaries.length === 0) gaps.push(`${sub}/${st}@${wk}`);
      }
    }
  }
  check('every station has an available Primary', gaps.length === 0, gaps.join(', '));
}

console.log();
if (failures.length > 0) {
  console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✅ All scheduler Ian-departure tests passed (${checks} checks).`);
