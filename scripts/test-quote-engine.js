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
  // Record the mtime of every existing rebalance-plan-*.json BEFORE the call.
  const existingPlanFiles = (fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [])
    .filter(f => f.startsWith('rebalance-plan-') && f.endsWith('.json'));
  const beforeMtimes = new Map(existingPlanFiles.map(f => {
    try { return [f, fs.statSync(path.join(logsDir, f)).mtimeMs]; } catch (e) { return [f, null]; }
  }));
  const beforeSet = new Set(existingPlanFiles);
  await quoteRunPlan(emptyBoards(16), sj);
  const afterFiles = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
  check('no new rebalance-plan-*.json in logs/',
    !afterFiles.some(f => f.startsWith('rebalance-plan-') && !beforeSet.has(f)),
    'quoteRunPlan wrote a plan file — savePath guard broken');
  // Every pre-existing file must have the same mtime (not overwritten).
  const allMtimesUnchanged = existingPlanFiles.every(f => {
    try {
      return fs.statSync(path.join(logsDir, f)).mtimeMs === beforeMtimes.get(f);
    } catch (e) { return true; /* file gone is also fine */ }
  });
  check('existing rebalance-plan-*.json mtimes unchanged',
    allMtimesUnchanged, 'at least one existing plan file was overwritten');

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
  // Unrelated warnings: the same warning must appear in BOTH baseline and
  // candidate to be treated as background noise (multiset diff).
  const bgWarn = 'Job SciTech has no delivery date — skipping';
  check('unrelated warnings ignored when present in both baseline and candidate',
    assessCandidate(
      { ...baseRep, warnings: [bgWarn] },
      { ...goodRep, warnings: [bgWarn] },
      fakeJob).feasible === true);
  // Displacement regression: baseline has no warnings; candidate has an
  // unplaced-hours warning for a DIFFERENT (committed) job → infeasible,
  // reason prefixed with "new warning vs baseline".
  const displacedWarn = 'Job SH-McMorris / Post Fin Cab Assembly: 6 hrs could not be placed within window';
  const displaceRes = assessCandidate(
    { ...baseRep, warnings: [] },
    { ...goodRep, warnings: [displacedWarn] },
    fakeJob);
  check('displacement (new warning for committed job) is infeasible', displaceRes.feasible === false,
    JSON.stringify(displaceRes.reasons));
  check('displacement reason prefixed with "new warning vs baseline"',
    displaceRes.reasons.some(r => r.startsWith('new warning vs baseline')),
    displaceRes.reasons.join(' | '));

  console.log('Test 14: date helpers — Monday snapping (spec §3/§4.1)');
  const { mondayOnOrAfter, runQuote, validateQuoteInput, buildQuoteUpdate } = require('./quote-engine.js');
  check('Monday maps to itself', mondayOnOrAfter('2026-06-15') === '2026-06-15');     // a Monday
  check('Tuesday maps to next Monday', mondayOnOrAfter('2026-06-16') === '2026-06-22');
  check('Sunday maps to next Monday', mondayOnOrAfter('2026-06-21') === '2026-06-22');

  console.log('Test 15: validateQuoteInput — named reasons (spec §4.4)');
  const pol = loadQuotePolicy();
  check('missing boxes named', validateQuoteInput({ jobType: 'Commercial', boxes: 0, complexity: 2 }, pol).reason.includes('Boxes'));
  check('bad type named + lists valid', validateQuoteInput({ jobType: 'Res FF', boxes: 5, complexity: 2 }, pol).reason.includes('Res - Face Frame'));
  check('complexity 7 named', validateQuoteInput({ jobType: 'Commercial', boxes: 5, complexity: 7 }, pol).reason.includes('omplexity'));
  check('target inside pre-production named',
    validateQuoteInput({ jobType: 'Commercial', boxes: 5, complexity: 2, targetDate: mondayWeeksFromNow(1) }, pol).reason.includes('pre-production'));
  check('empty complexity defaults to 2', validateQuoteInput({ jobType: 'Commercial', boxes: 5, complexity: '' }, pol).ok === true);

  console.log('Test 16: earliest mode on an empty shop — capacity = structural chain, floor wins');
  (async () => {
    const boards16 = emptyBoards(20);
    const res = await runQuote(
      { rowId: '1', name: 'Empty shop', jobType: 'Res - Face Frame', boxes: 25, complexity: 2 },
      { boards: boards16, policy: pol });
    check('mode earliest', res.mode === 'earliest');
    check('capacityWeek is a Monday ISO', /^\d{4}-\d{2}-\d{2}$/.test(res.capacityWeek), String(res.capacityWeek));
    check('capacityWeek ≥ walk start (pre-production)', res.capacityWeek >= mondayWeeksFromNow(2), res.capacityWeek);
    check('floorWeek ≈ 12 weeks out', res.floorWeek >= mondayWeeksFromNow(12) && res.floorWeek <= mondayWeeksFromNow(13), res.floorWeek);
    check('quotedWeek = max(capacity, floor) = floor on empty shop', res.quotedWeek === res.floorWeek,
      `quoted ${res.quotedWeek} capacity ${res.capacityWeek} floor ${res.floorWeek}`);
    check('verdict EARLIEST', res.verdict === 'EARLIEST', res.verdict);

    console.log('Test 17: capacity crunch pushes capacityWeek past the crunch');
    // Crunch ALL crews for the first 8 weeks (not just the Engineering primary —
    // SECONDARY routing could spill a single-crew crunch to a fallback crew and
    // silently keep early weeks feasible). 1h base < every station's hours.
    const crunch = emptyBoards(20);
    for (const p of crunch.crewParents) {
      if (p.week < mondayWeeksFromNow(8)) p.base = 1;
    }
    const res2 = await runQuote(
      { rowId: '2', name: 'Crunched', jobType: 'Res - Face Frame', boxes: 25, complexity: 2 },
      { boards: crunch, policy: pol });
    check('capacityWeek pushed past the crunch', res2.capacityWeek > res.capacityWeek,
      `crunched ${res2.capacityWeek} vs empty ${res.capacityWeek}`);

    console.log('Test 18: target mode — all three outcomes (spec §4.4 table)');
    const fits = await runQuote(
      { rowId: '3', name: 'T1', jobType: 'Res - Face Frame', boxes: 25, complexity: 2, targetDate: mondayWeeksFromNow(14) },
      { boards: emptyBoards(20), policy: pol });
    check('fits ≥ floor → FITS, quoted = target week', fits.verdict === 'FITS' && fits.quotedWeek === mondayWeeksFromNow(14),
      `${fits.verdict} ${fits.quotedWeek}`);
    const below = await runQuote(
      { rowId: '4', name: 'T2', jobType: 'Res - Face Frame', boxes: 25, complexity: 2, targetDate: mondayWeeksFromNow(8) },
      { boards: emptyBoards(20), policy: pol });
    check('fits below floor → FITS_BELOW_FLOOR, quoted = max(target, floor)',
      below.verdict === 'FITS_BELOW_FLOOR' && below.quotedWeek === below.floorWeek, `${below.verdict} ${below.quotedWeek}`);
    const noFit = await runQuote(
      { rowId: '5', name: 'T3', jobType: 'Res - Face Frame', boxes: 25, complexity: 2, targetDate: mondayWeeksFromNow(3) },
      { boards: (() => { const b = emptyBoards(20); for (const p of b.crewParents) { if (p.week < mondayWeeksFromNow(8)) p.base = 1; } return b; })(), policy: pol });
    check('does not fit → DOES_NOT_FIT with bottleneck', noFit.verdict === 'DOES_NOT_FIT' && !!noFit.bottleneck,
      `${noFit.verdict} ${noFit.bottleneck}`);
    check('doesn\'t-fit still reports earliest-that-fits in capacityWeek', !!noFit.capacityWeek);

    console.log('Test 18b: Fix 4 — target beyond walk cap still resolves FITS if target week is feasible');
    {
      const { WALK_CAP_WEEKS, buildSyntheticJob: bsj, quoteRunPlan: qrp, assessCandidate: ac } = require('./quote-engine.js');
      // Stub runPlanFn: every walk candidate (first WALK_CAP_WEEKS calls) is
      // infeasible (returns empty placements), but the target-week call (at
      // index WALK_CAP_WEEKS) is fully placed.
      const farBoards = emptyBoards(40);
      let planCalls = 0;
      const stubRunPlan = async (b) => {
        const calls = planCalls++;
        // Walk calls: 1 baseline + WALK_CAP_WEEKS walk candidates = indices 0..WALK_CAP_WEEKS.
        // Target check: next call after walk exhausts = index WALK_CAP_WEEKS+1.
        if (calls === 0) return { placements: [], warnings: [], capacityGrid: {} }; // baseline
        if (calls <= WALK_CAP_WEEKS) {
          // Walk candidates: return 0 placements so none are feasible.
          return { placements: [], warnings: [], capacityGrid: {} };
        }
        // Target week call: return fully-placed result for the synthetic job.
        const synthJob = (b.jobs || []).find(j => String(j.id).startsWith('QUOTE-'));
        if (synthJob) {
          const stationHours = Object.values(synthJob.hours).reduce((s, h) => s + h, 0);
          return {
            placements: [
              { jobId: synthJob.id, hours: stationHours },
              { jobId: synthJob.id, hours: 2 }, // P&S
              { jobId: synthJob.id, hours: 2 }, // Delivery
            ],
            warnings: [],
            capacityGrid: {},
          };
        }
        return { placements: [], warnings: [], capacityGrid: {} };
      };

      const farTarget = mondayWeeksFromNow(WALK_CAP_WEEKS + 2);
      const farRes = await runQuote(
        { rowId: '99', name: 'FarTarget', jobType: 'Res - Face Frame', boxes: 25, complexity: 2, targetDate: farTarget },
        { boards: farBoards, policy: pol, runPlanFn: stubRunPlan });
      check('target beyond cap with feasible target → ok:true', farRes.ok === true,
        JSON.stringify({ ok: farRes.ok, reason: farRes.reason, verdict: farRes.verdict }));
      check('verdict is FITS', farRes.verdict === 'FITS' || farRes.verdict === 'FITS_BELOW_FLOOR',
        String(farRes.verdict));
      check('capacityWeek is null (walk exhausted)', farRes.capacityWeek === null,
        String(farRes.capacityWeek));

      // No-target exhaustion still returns ok:false mentioning WALK_CAP_WEEKS.
      planCalls = 0;
      const exhaustedRes = await runQuote(
        { rowId: '100', name: 'Exhausted', jobType: 'Res - Face Frame', boxes: 25, complexity: 2 },
        { boards: farBoards, policy: pol, runPlanFn: stubRunPlan });
      check('no-target exhaustion → ok:false', exhaustedRes.ok === false, JSON.stringify(exhaustedRes));
      check('no-target exhaustion reason mentions walk cap weeks',
        String(exhaustedRes.reason).includes(String(WALK_CAP_WEEKS)),
        String(exhaustedRes.reason));
    }

    console.log('Test 19: update body carries both numbers + disclaimer + freshness');
    const body = buildQuoteUpdate(res);
    check('headline quoted week', body.includes(res.quotedWeek));
    check('capacity week shown', body.includes(res.capacityWeek));
    check('floor explanation', body.includes('floor'));
    check('PM disclaimer', body.includes('Confirm with PM'));
    check('freshness timestamp', body.includes(res.dataFreshness.slice(0, 10)));
    check('inputs echoed', body.includes('25') && body.includes('Res - Face Frame'));
    // Fix 6: string complexity matching numeric complexityUsed must NOT show "(rounded from N)"
    {
      const fakeRes = { ...res, inputs: { ...res.inputs, complexity: '2', complexityUsed: 2 } };
      const fakeBody = buildQuoteUpdate(fakeRes);
      check('complexity string "2" matching complexityUsed 2 → no "(rounded from)"',
        !fakeBody.includes('rounded from'), fakeBody.split('\n').find(l => l.includes('Input')));
    }

    console.log(failures.length ? `\n❌ ${failures.length}/${checks} FAILED` : `\n✅ all ${checks} checks passed`);
    process.exit(failures.length ? 1 : 0);
  })();
})();
