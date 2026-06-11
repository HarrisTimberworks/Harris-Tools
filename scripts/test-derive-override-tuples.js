#!/usr/bin/env node
/**
 * C5 — accepted-overrides → 🔧 tuple derivation.
 *
 * deriveAcceptedOverrideTuples(accepted, baselinePlan, finalPlan)
 *   → [{ jobId, station, crew, week }]
 *
 * Bridges validate-overrides.js's accepted rows (resolved-row shape:
 * { rowId, jobId, station, hours, fromCrew, fromWeek, toCrew, toWeek, ... })
 * to capacity-view-generator.js's options.acceptedOverrides matcher
 * (formatHrsCell compares jobId/station/crew/week against each placement).
 *
 * Semantics (settled this session — see docs/phase-2-manual-overrides-plan.md
 * §F.4 + §F.5 + §D smoke-matrix note):
 *   - Move / pure-assign rows (To side present): the override drives exactly
 *     the destination cell → one tuple { jobId, station, crew: toCrew,
 *     week: toWeek }.
 *   - Pure-clear rows (To side empty): the override drives placement via
 *     crewExclusion — the cleared hours re-land wherever the planner re-routes
 *     them. Wrench every final-plan cell of (jobId × station) whose
 *     crew×week hours-sum DIFFERS from the baseline plan (new cell, or same
 *     cell with changed hours). Unchanged cells are not override-driven.
 *   - Stale-🔧 (F.5b): tuples derive ONLY from the current run's accepted
 *     rows. A row that re-validates to Conflict is absent from accepted and
 *     contributes nothing — its old cells lose the wrench automatically.
 *   - F.4: rebalance-overrides.json forceAssignments are structural config,
 *     not manual overrides. They surface as *(pinned)*, never as 🔧.
 *
 * Also under C5 (same rendering surface):
 *   - tuplesFromPersistedValidation(validation): the standalone
 *     write-capacity-view.js CLI reads a persisted override-validation JSON.
 *     Prefer validation.acceptedTuples (persisted by C8's run-planner wire-up,
 *     which had both plans in memory); fall back to a to-side-only mapping for
 *     older files (pure clears need the baseline diff, unavailable on disk).
 *   - REGRESSION (forced-field): the planner emits `forced: true` on pinned
 *     placements (scripts/rebalance-schedule.js:1091). The generator's pinned
 *     detection checked only `p.pinned || p.force` — neither is ever emitted
 *     by the planner, so *(pinned)* never rendered from a REAL plan JSON.
 *     Same incident family as the 2026-05-25 `avail` field-name bug. Tests
 *     here anchor to the planner's canonical field name.
 */

const {
  deriveAcceptedOverrideTuples,
  tuplesFromPersistedValidation,
  timeOffEntriesFromPlan,
  buildWeekSection,
  buildPriorityOrder,
} = require('./capacity-view-generator.js');

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

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function placement(overrides = {}) {
  return {
    crew: 'Ian',
    week: '2026-06-01',
    jobId: 'PL-A',
    jobName: 'Job A',
    masterPmId: 'MPM-A',
    station: 'Benchwork',
    hours: 8,
    parentId: 'p-ian',
    ...overrides,
  };
}

// Resolved accepted-row shape (validate-overrides.js resolveRow output +
// decision tag, as found in validation.accepted).
function acceptedRow(overrides = {}) {
  return {
    rowId: 'R1',
    jobMpmId: 'MPM-A',
    jobId: 'PL-A',
    station: 'Benchwork',
    hours: 8,
    status: 'Pending',
    allowOverCap: false,
    fromCrew: null, fromWeek: null,
    toCrew: 'Ian', toWeek: '2026-06-01',
    decision: 'accepted',
    ...overrides,
  };
}

(async () => {

  console.log('Test 1: exports exist');
  {
    check('deriveAcceptedOverrideTuples is a function',
      typeof deriveAcceptedOverrideTuples === 'function',
      `typeof=${typeof deriveAcceptedOverrideTuples}`);
    check('tuplesFromPersistedValidation is a function',
      typeof tuplesFromPersistedValidation === 'function',
      `typeof=${typeof tuplesFromPersistedValidation}`);
  }

  console.log('\nTest 2: move row (From + To present) → exactly one destination tuple');
  {
    const accepted = [acceptedRow({
      fromCrew: 'Ken', fromWeek: '2026-05-25',
      toCrew: 'Ian', toWeek: '2026-06-01',
    })];
    const baseline = { placements: [placement({ crew: 'Ken', week: '2026-05-25' })] };
    const final    = { placements: [placement({ crew: 'Ian', week: '2026-06-01' })] };
    const tuples = deriveAcceptedOverrideTuples(accepted, baseline, final);
    check('one tuple', tuples.length === 1, JSON.stringify(tuples));
    check('tuple is the DESTINATION cell',
      tuples[0]?.jobId === 'PL-A' && tuples[0]?.station === 'Benchwork'
      && tuples[0]?.crew === 'Ian' && tuples[0]?.week === '2026-06-01',
      JSON.stringify(tuples));
  }

  console.log('\nTest 3: pure assign (no From side) → destination tuple');
  {
    const accepted = [acceptedRow({ fromCrew: null, fromWeek: null })];
    const tuples = deriveAcceptedOverrideTuples(accepted, { placements: [] }, { placements: [placement()] });
    check('one destination tuple', tuples.length === 1 && tuples[0].crew === 'Ian' && tuples[0].week === '2026-06-01',
      JSON.stringify(tuples));
  }

  console.log('\nTest 4: pure clear → wrench only final cells that differ from baseline');
  {
    // Ian cleared from (PL-A × Benchwork). Baseline: Ian 8h + Ken 4h on 6/01.
    // Final: Ken 4h unchanged on 6/01, Spencer picked up 8h on 6/08.
    const accepted = [acceptedRow({ toCrew: null, toWeek: null, fromCrew: 'Ian', fromWeek: '2026-06-01' })];
    const baseline = { placements: [
      placement({ crew: 'Ian', week: '2026-06-01', hours: 8 }),
      placement({ crew: 'Ken', week: '2026-06-01', hours: 4 }),
    ] };
    const final = { placements: [
      placement({ crew: 'Ken', week: '2026-06-01', hours: 4 }),
      placement({ crew: 'Spencer', week: '2026-06-08', hours: 8 }),
    ] };
    const tuples = deriveAcceptedOverrideTuples(accepted, baseline, final);
    check('exactly one tuple (the re-landed cell)', tuples.length === 1, JSON.stringify(tuples));
    check('tuple is Spencer 2026-06-08',
      tuples[0]?.crew === 'Spencer' && tuples[0]?.week === '2026-06-08',
      JSON.stringify(tuples));
    check('unchanged Ken cell NOT wrenched',
      !tuples.some(t => t.crew === 'Ken'),
      JSON.stringify(tuples));
  }

  console.log('\nTest 5: pure clear — same cell absorbing more hours IS wrenched');
  {
    // Baseline: Ian 8h + Ken 4h. Final: Ken absorbed Ian's hours → Ken 12h.
    const accepted = [acceptedRow({ toCrew: null, toWeek: null, fromCrew: 'Ian', fromWeek: '2026-06-01' })];
    const baseline = { placements: [
      placement({ crew: 'Ian', week: '2026-06-01', hours: 8 }),
      placement({ crew: 'Ken', week: '2026-06-01', hours: 4 }),
    ] };
    const final = { placements: [
      placement({ crew: 'Ken', week: '2026-06-01', hours: 12 }),
    ] };
    const tuples = deriveAcceptedOverrideTuples(accepted, baseline, final);
    check('Ken 6/01 wrenched (hours changed 4 → 12)',
      tuples.length === 1 && tuples[0].crew === 'Ken' && tuples[0].week === '2026-06-01',
      JSON.stringify(tuples));
  }

  console.log('\nTest 6: pure clear ignores OTHER jobs/stations in the diff');
  {
    const accepted = [acceptedRow({ toCrew: null, toWeek: null, fromCrew: 'Ian', fromWeek: '2026-06-01' })];
    const baseline = { placements: [
      placement({ crew: 'Ian', week: '2026-06-01', hours: 8 }),
      placement({ crew: 'Bob', week: '2026-06-01', jobId: 'PL-B', masterPmId: 'MPM-B', hours: 6 }),
      placement({ crew: 'Bob', week: '2026-06-01', station: 'Panel Processing', hours: 5 }),
    ] };
    const final = { placements: [
      placement({ crew: 'Spencer', week: '2026-06-01', hours: 8 }),
      // PL-B and the Panel station also shifted — but they're not this row's
      // (job × station), so no wrench from this override.
      placement({ crew: 'Bob', week: '2026-06-08', jobId: 'PL-B', masterPmId: 'MPM-B', hours: 6 }),
      placement({ crew: 'Ken', week: '2026-06-01', station: 'Panel Processing', hours: 5 }),
    ] };
    const tuples = deriveAcceptedOverrideTuples(accepted, baseline, final);
    check('only the (PL-A × Benchwork) re-landed cell wrenched',
      tuples.length === 1 && tuples[0].crew === 'Spencer' && tuples[0].station === 'Benchwork' && String(tuples[0].jobId) === 'PL-A',
      JSON.stringify(tuples));
  }

  console.log('\nTest 7: split-placement aggregation — two final rows in same cell sum before diffing');
  {
    // Final has TWO placements for the same (crew × week) cell summing to the
    // baseline's single 8h placement → no change → no wrench.
    const accepted = [acceptedRow({ toCrew: null, toWeek: null, fromCrew: 'Ken', fromWeek: '2026-06-08' })];
    const baseline = { placements: [
      placement({ crew: 'Ian', week: '2026-06-01', hours: 8 }),
      placement({ crew: 'Ken', week: '2026-06-08', hours: 3 }),
    ] };
    const final = { placements: [
      placement({ crew: 'Ian', week: '2026-06-01', hours: 5 }),
      placement({ crew: 'Ian', week: '2026-06-01', hours: 3 }),
    ] };
    const tuples = deriveAcceptedOverrideTuples(accepted, baseline, final);
    check('aggregated 5+3 equals baseline 8 → Ian 6/01 not wrenched',
      tuples.length === 0,
      JSON.stringify(tuples));
  }

  console.log('\nTest 8: dedupe — two accepted rows driving the same destination → one tuple');
  {
    const accepted = [
      acceptedRow({ rowId: 'R1', hours: 4 }),
      acceptedRow({ rowId: 'R2', hours: 6 }),
    ];
    const tuples = deriveAcceptedOverrideTuples(accepted, { placements: [] }, { placements: [placement({ hours: 10 })] });
    check('single deduped tuple', tuples.length === 1, JSON.stringify(tuples));
  }

  console.log('\nTest 9: empty / missing accepted → []');
  {
    check('empty array → []', deriveAcceptedOverrideTuples([], { placements: [] }, { placements: [] }).length === 0, '');
    check('undefined → []', deriveAcceptedOverrideTuples(undefined, { placements: [] }, { placements: [] }).length === 0, '');
  }

  console.log('\nTest 10: F.4 — JSON forceAssignment placements never produce tuples');
  {
    // A forced placement in the final plan with NO accepted board rows: the
    // *(pinned)* marker is its only annotation; 🔧 must not appear.
    const final = { placements: [placement({ forced: true })] };
    const tuples = deriveAcceptedOverrideTuples([], { placements: [] }, final);
    check('no tuples from forced placements', tuples.length === 0, JSON.stringify(tuples));
  }

  console.log('\nTest 11: numeric vs string jobId — String() comparison on both sides');
  {
    const accepted = [acceptedRow({ jobId: 12345, toCrew: null, toWeek: null, fromCrew: 'Ian', fromWeek: '2026-06-01' })];
    const baseline = { placements: [placement({ jobId: '12345', crew: 'Ian', week: '2026-06-01' })] };
    const final    = { placements: [placement({ jobId: '12345', crew: 'Ken', week: '2026-06-01' })] };
    const tuples = deriveAcceptedOverrideTuples(accepted, baseline, final);
    check('numeric row jobId matches string placement jobId',
      tuples.length === 1 && tuples[0].crew === 'Ken',
      JSON.stringify(tuples));
  }

  console.log('\nTest 12: tuplesFromPersistedValidation — prefers persisted acceptedTuples');
  {
    const validation = {
      accepted: [acceptedRow()],
      acceptedTuples: [{ jobId: 'PL-X', station: 'Panel Processing', crew: 'Ken', week: '2026-06-08' }],
    };
    const tuples = tuplesFromPersistedValidation(validation);
    check('returns the persisted tuples verbatim',
      tuples.length === 1 && tuples[0].jobId === 'PL-X',
      JSON.stringify(tuples));
  }

  console.log('\nTest 13: tuplesFromPersistedValidation — legacy fallback maps to-side rows, skips pure clears');
  {
    const validation = {
      accepted: [
        acceptedRow({ rowId: 'R1' }),                                         // to-side → tuple
        acceptedRow({ rowId: 'R2', toCrew: null, toWeek: null,
                      fromCrew: 'Ian', fromWeek: '2026-06-01' }),             // pure clear → skipped
      ],
    };
    const tuples = tuplesFromPersistedValidation(validation);
    check('one tuple from the to-side row only', tuples.length === 1, JSON.stringify(tuples));
    check('tuple shape matches generator matcher',
      tuples[0]?.jobId === 'PL-A' && tuples[0]?.station === 'Benchwork'
      && tuples[0]?.crew === 'Ian' && tuples[0]?.week === '2026-06-01',
      JSON.stringify(tuples));
    check('empty validation → []', tuplesFromPersistedValidation({}).length === 0, '');
  }

  console.log('\nTest 14: REGRESSION — planner field `forced: true` renders *(pinned)* in week section');
  {
    const plan = {
      placements: [placement({ forced: true })],
      capacityGrid: { Ian: { '2026-06-01': { committed: 8, avail: 40 } } },
    };
    const jobsById = { 'PL-A': { name: 'Job A', delivery: '2026-06-12' } };
    const out = buildWeekSection('2026-06-01', plan, jobsById, [], {});
    check('Hrs cell carries *(pinned)* for forced placement',
      /\| Job A \| Bench \| 8 \*\(pinned\)\* \|/.test(out),
      out.split('\n').filter(l => l.startsWith('|')).join(' // '));
  }

  console.log('\nTest 15: REGRESSION — `forced: true` marks priority-order station as pinned');
  {
    const plan = { placements: [placement({ forced: true })] };
    const jobsById = { 'PL-A': { name: 'Job A', delivery: '2026-06-12' } };
    const out = buildPriorityOrder('2026-06-01', plan, jobsById);
    check('item.pinned === true via forced flag',
      out.highest[0]?.pinned === true,
      JSON.stringify(out.highest[0]));
  }

  console.log('\nTest 16: 🔧 + *(pinned)* coexist — tuple-matched forced placement shows both');
  {
    // An accepted board row lands as a forceAssignment, so its placement is
    // BOTH forced (pinned marker) and override-driven (wrench).
    const plan = {
      placements: [placement({ forced: true })],
      capacityGrid: { Ian: { '2026-06-01': { committed: 8, avail: 40 } } },
    };
    const jobsById = { 'PL-A': { name: 'Job A', delivery: '2026-06-12' } };
    const tuples = deriveAcceptedOverrideTuples([acceptedRow()], { placements: [] }, plan);
    const out = buildWeekSection('2026-06-01', plan, jobsById, [], { acceptedOverrides: tuples });
    check('Hrs cell shows 🔧 prefix AND *(pinned)* suffix',
      /🔧 8 \*\(pinned\)\*/.test(out),
      out.split('\n').filter(l => l.includes('Job A')).join(' // '));
  }

  console.log('\nTest 17: REVIEW FIX — timeOffEntriesFromPlan derives {crew, week, hours} from capacityGrid');
  {
    // Adversarial-review finding (2026-06-10, MEDIUM): C8 + the writer CLIs
    // passed loadTimeOff()'s raw shape ({ personId, from, to, hours }) to the
    // generators, whose buildCrewTable expects { crew, week, hours } — so
    // PTO-only crews silently vanished from both generated docs. The plan
    // JSON's capacityGrid already serializes slot.timeOff per crew × week
    // (rebalance-schedule.js grid output: { avail, committed, timeOff, over,
    // assignments }); deriving from it needs no Time Off board knowledge.
    check('timeOffEntriesFromPlan is a function', typeof timeOffEntriesFromPlan === 'function', `typeof=${typeof timeOffEntriesFromPlan}`);
    const plan = {
      capacityGrid: {
        Ian: { '2026-06-15': { avail: 32, committed: 0, timeOff: 8 },
               '2026-06-22': { avail: 40, committed: 10, timeOff: 0 } },
        Ken: { '2026-06-15': { avail: 40, committed: 12, timeOff: 0 } },
        Bob: { '2026-06-15': { avail: 0, committed: 0, timeOff: 40 } },
      },
    };
    const entries = timeOffEntriesFromPlan(plan);
    check('two entries (timeOff > 0 only)', entries.length === 2, JSON.stringify(entries));
    const ian = entries.find(e => e.crew === 'Ian');
    const bob = entries.find(e => e.crew === 'Bob');
    check('Ian 2026-06-15 8h', ian?.week === '2026-06-15' && ian?.hours === 8, JSON.stringify(ian));
    check('Bob 2026-06-15 40h', bob?.week === '2026-06-15' && bob?.hours === 40, JSON.stringify(bob));
    check('missing grid → []', timeOffEntriesFromPlan({}).length === 0 && timeOffEntriesFromPlan(undefined).length === 0, '');
  }

  console.log('\nTest 18: REVIEW FIX — derived entries render the PTO row through buildWeekSection');
  {
    const plan = {
      placements: [placement({ crew: 'Ken', week: '2026-06-15', hours: 12 })],
      capacityGrid: {
        Ken: { '2026-06-15': { avail: 40, committed: 12, timeOff: 0 } },
        Ian: { '2026-06-15': { avail: 32, committed: 0, timeOff: 8 } },
      },
    };
    const jobsById = { 'PL-A': { name: 'Job A', delivery: '2026-06-19' } };
    const out = buildWeekSection('2026-06-15', plan, jobsById, timeOffEntriesFromPlan(plan), {});
    check('PTO-only Ian row renders', /\| Ian \| PTO \(8h\) \| — \| — \| — \|/.test(out),
      out.split('\n').filter(l => l.startsWith('|')).join(' // '));
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All C5 derive-override-tuples tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
