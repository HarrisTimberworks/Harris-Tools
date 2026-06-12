#!/usr/bin/env node
// test-quote-engine.js — hermetic; no API, no token needed.
const fs = require('fs');
const path = require('path');
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

// ---- shared fixture helpers (used by Tasks 5-7 tests) ----
const { toISO: _toISO, getMondayOfWeek: _gmw, addDays: _addDays, parseISO: _parseISO } =
  require('./rebalance-schedule.js');
function mondayWeeksFromNow(n) { return _toISO(_addDays(_gmw(new Date()), n * 7)); }
// Crew parents for every crew × week over the next `weeks` weeks, full base hours.
function makeCrewParents(weeks) {
  const { CREW_BASE_HOURS: CBH, BOB_START_DATE: BSD, CREW_END_DATES: CED } = require('./rebalance-schedule.js');
  const rows = [];
  let id = 1;
  for (let w = 0; w < weeks; w++) {
    const week = mondayWeeksFromNow(w);
    for (const crew of Object.keys(CBH)) {
      if (crew === 'Bob' && week < BSD) continue;
      if (CED[crew] && week >= _toISO(_gmw(_parseISO(CED[crew])))) continue;
      rows.push({ parentId: `fix-${id++}`, week, crew, base: CBH[crew], timeOff: 0, nonProd: 0 });
    }
  }
  return rows;
}
function emptyBoards(parentWeeks = 16) {
  return { jobs: [], crewParents: makeCrewParents(parentWeeks), timeOff: [], existingSubs: [], overrideRows: [] };
}

console.log('Test 4: buildSyntheticJob carries every load-bearing field (spec §4.1)');
const { buildSyntheticJob, quoteRunPlan, withSyntheticParents } = require('./quote-engine.js');
const sj = buildSyntheticJob(
  { rowId: '999', name: 'Test Quote', jobType: 'Res - Face Frame', boxes: 25, complexity: 2 },
  loadQuotePolicy(), mondayWeeksFromNow(10));
check('id sentinel', sj.id === 'QUOTE-999', sj.id);
check('status in planner allowlist', sj.status === 'Scheduled', sj.status);
check('subtype is ROUTING key', sj.subtype === 'Res - Face Frame', sj.subtype);
check('delivery set', sj.delivery === mondayWeeksFromNow(10), sj.delivery);
check('hours from model', sj.hours.eng === 15 && sj.hours.prefin === 27.5, JSON.stringify(sj.hours));
check('finishingDays from policy', sj.finishingDays === 5, String(sj.finishingDays));
check('pLam false, masterPmId null, customWindow null',
  sj.pLam === false && sj.masterPmId === null && sj.customWindow === null);

console.log('Test 5: withSyntheticParents fills beyond-coverage weeks, never mutates input');
const shortBoards = emptyBoards(4); // parents only 4 weeks out
const before = shortBoards.crewParents.length;
const synth = withSyntheticParents(shortBoards, sj, { now: () => new Date() });
check('input untouched', shortBoards.crewParents.length === before);
check('synthetic rows added', synth.length > before, `${synth.length} <= ${before}`);
check('synthetic rows shaped like real ones',
  synth.filter(p => String(p.parentId).startsWith('synthetic-'))
       .every(p => p.week && p.crew && typeof p.base === 'number' && p.timeOff === 0 && p.nonProd === 0));
check('no synthetic Bob before start date',
  !synth.some(p => String(p.parentId).startsWith('synthetic-') && p.crew === 'Bob' && p.week < '2026-05-18'));

console.log('Test 6: quoteRunPlan — synthetic job actually PLACES (the silent-drop guard)');
(async () => {
  const boards = emptyBoards(16);
  const report = await quoteRunPlan(boards, sj);
  const quotePlacements = (report.placements || []).filter(p => p.jobId === 'QUOTE-999');
  const placedHours = quotePlacements.reduce((s, p) => s + (p.hours || 0), 0);
  const stationSum = Object.values(sj.hours).reduce((s, h) => s + h, 0);
  check('placements exist for the synthetic job', quotePlacements.length > 0,
    `0 placements — synthetic job silently dropped (status filter?)`);
  check('full station hours + 4h P&S/Delivery placed', placedHours >= stationSum + 4 - 0.01,
    `placed ${placedHours} of ${stationSum + 4}`);

  console.log('Test 7: quoteRunPlan structurally cannot write a plan file');
  const logsDir = path.join(__dirname, '..', 'logs');
  const beforeFiles = new Set(fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : []);
  await quoteRunPlan(emptyBoards(16), sj);
  const afterFiles = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
  check('no new rebalance-plan-*.json in logs/',
    !afterFiles.some(f => f.startsWith('rebalance-plan-') && !beforeFiles.has(f)),
    'quoteRunPlan wrote a plan file — savePath guard broken');

  console.log('Test 8: quoteRunPlan(boards, null) = baseline, no synthetic job');
  const base = await quoteRunPlan(emptyBoards(16), null);
  check('baseline has no QUOTE placements', !(base.placements || []).some(p => String(p.jobId).startsWith('QUOTE-')));

  console.log('Test 9: assessCandidate — feasible when fully placed and no new over-cap');
  const { assessCandidate } = require('./quote-engine.js');
  const fakeJob = { id: 'QUOTE-1', name: 'QUOTE - x', hours: { eng: 10, panel: 0, bench: 0, prefin: 0, postfin: 0 } };
  const baseRep = { placements: [], warnings: [], capacityGrid: { Chris: { '2026-07-06': { avail: 15, committed: 12, over: 0 } } } };
  const goodRep = { placements: [{ jobId: 'QUOTE-1', hours: 10 }, { jobId: 'QUOTE-1', hours: 2 }, { jobId: 'QUOTE-1', hours: 2 }],
    warnings: [], capacityGrid: { Chris: { '2026-07-06': { avail: 15, committed: 15, over: 0 } } } };
  check('clean fit is feasible', assessCandidate(baseRep, goodRep, fakeJob).feasible === true,
    JSON.stringify(assessCandidate(baseRep, goodRep, fakeJob).reasons));

  console.log('Test 10: under-placement is infeasible with a named reason');
  const shortRep = { ...goodRep, placements: [{ jobId: 'QUOTE-1', hours: 6 }] };
  const shortRes = assessCandidate(baseRep, shortRep, fakeJob);
  check('infeasible', shortRes.feasible === false);
  check('reason names the shortfall', shortRes.reasons[0].includes('6'), shortRes.reasons[0]);

  console.log('Test 11: STRICT over-cap diff — growing an existing overload is infeasible (spec §4.1)');
  const baseOver = { placements: [], warnings: [], capacityGrid: { Bob: { '2026-07-06': { avail: 30, committed: 33, over: 3 } } } };
  const worseOver = { placements: [{ jobId: 'QUOTE-1', hours: 14 }], warnings: [],
    capacityGrid: { Bob: { '2026-07-06': { avail: 30, committed: 55, over: 25 } } } };
  const overRes = assessCandidate(baseOver, worseOver, fakeJob);
  check('grown over-cap infeasible', overRes.feasible === false);
  check('reason names crew+week+magnitude', /Bob.*2026-07-06/.test(overRes.reasons.join(' ')), overRes.reasons.join(' | '));

  console.log('Test 12: pre-existing over-cap that does NOT grow is tolerated');
  const sameOver = { placements: [{ jobId: 'QUOTE-1', hours: 14 }], warnings: [],
    capacityGrid: { Bob: { '2026-07-06': { avail: 30, committed: 33, over: 3 } } } };
  check('unchanged baseline overload tolerated', assessCandidate(baseOver, sameOver, fakeJob).feasible === true);

  console.log('Test 13: a warning naming the quote job is infeasible');
  const warnRep = { ...goodRep, warnings: ['Job QUOTE - x: 4h unplaced at Post Fin Cab Assembly'] };
  check('quote-named warning rejects', assessCandidate(baseRep, warnRep, fakeJob).feasible === false);
  check('unrelated warnings ignored',
    assessCandidate(baseRep, { ...goodRep, warnings: ['Job SciTech has no delivery date — skipping'] }, fakeJob).feasible === true);

  console.log(failures.length ? `\n❌ ${failures.length}/${checks} FAILED` : `\n✅ all ${checks} checks passed`);
  process.exit(failures.length ? 1 : 0);
})();
