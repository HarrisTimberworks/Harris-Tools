#!/usr/bin/env node
/**
 * C1 — buildPriorityOrder pure function.
 *
 * Tests the priority-order auto-scaffold builder from Phase 2 C1
 * (docs/phase-2-manual-overrides-plan.md §C). Single pure function;
 * synthetic fixtures only, no monday I/O.
 *
 * Contract recap:
 *   buildPriorityOrder(weekISO, plan, jobsById) → { highest, high, normal }
 *   - Each tier is an array of items, one per (crew × jobId) for this week.
 *   - Item shape: { crew, jobName, jobId, stations, deliveryDate,
 *                   deliveryRelative, pinned }
 *   - stations: [{ station, hours, pinned? }]; multiple placements for the
 *     same (crew, jobId, station) sum into one stations[] entry.
 *   - Sort within tier: ascending by deliveryDate, then alphabetical crew.
 *
 * Tiering (per D4):
 *   highest = weeksUntilDelivery in [0, 1]
 *   high    = weeksUntilDelivery == 2
 *   normal  = weeksUntilDelivery > 2 OR < 0 (past-delivery edge defensively
 *             routes here)
 */

const { buildPriorityOrder } = require('./capacity-view-generator.js');

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
    station: 'Benchwork',
    hours: 8,
    ...overrides,
  };
}

function jobsByIdFixture(overrides = {}) {
  return {
    'PL-A': { name: 'Job A', delivery: '2026-06-12', status: 'Scheduled' },
    'PL-B': { name: 'Job B', delivery: '2026-06-19', status: 'Scheduled' },
    'PL-C': { name: 'Job C', delivery: '2026-07-03', status: 'Scheduled' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

(async () => {

  console.log('Test 1: empty plan → all three tiers empty');
  {
    const plan = { placements: [] };
    const out = buildPriorityOrder('2026-06-01', plan, jobsByIdFixture());
    check('highest is []', Array.isArray(out.highest) && out.highest.length === 0, JSON.stringify(out));
    check('high is []',    Array.isArray(out.high)    && out.high.length    === 0, JSON.stringify(out));
    check('normal is []',  Array.isArray(out.normal)  && out.normal.length  === 0, JSON.stringify(out));
  }

  console.log('\nTest 2: single placement, delivery within ≤1 week → 🔴 highest');
  {
    // weekISO 2026-06-01; PL-A delivery 2026-06-12 (Friday) → Monday-of 6-08
    // → weeksUntil = 1 → highest.
    const plan = { placements: [ placement({ crew: 'Ian', jobId: 'PL-A', station: 'Benchwork', hours: 8 }) ] };
    const out = buildPriorityOrder('2026-06-01', plan, jobsByIdFixture());
    check('highest has 1 item', out.highest.length === 1, JSON.stringify(out));
    check('high empty',         out.high.length === 0,    JSON.stringify(out));
    check('normal empty',       out.normal.length === 0,  JSON.stringify(out));
    const it = out.highest[0];
    check('item crew',     it.crew === 'Ian',          JSON.stringify(it));
    check('item jobName',  it.jobName === 'Job A',     JSON.stringify(it));
    check('item jobId',    it.jobId === 'PL-A',        JSON.stringify(it));
    check('item deliveryDate', it.deliveryDate === '2026-06-12', JSON.stringify(it));
    check('item stations[0] station', it.stations[0]?.station === 'Benchwork', JSON.stringify(it));
    check('item stations[0] hours',   it.stations[0]?.hours === 8,             JSON.stringify(it));
  }

  console.log('\nTest 3: single placement, delivery 2 weeks out → 🟡 high');
  {
    // weekISO 2026-06-01; PL-B delivery 2026-06-19 (Friday) → Monday-of 6-15
    // → weeksUntil = 2 → high.
    const plan = { placements: [ placement({ jobId: 'PL-B' }) ] };
    const out = buildPriorityOrder('2026-06-01', plan, jobsByIdFixture());
    check('high has 1 item', out.high.length === 1, JSON.stringify(out));
    check('highest empty',   out.highest.length === 0, JSON.stringify(out));
    check('normal empty',    out.normal.length === 0,  JSON.stringify(out));
    check('item is Job B',   out.high[0]?.jobName === 'Job B', JSON.stringify(out.high[0]));
  }

  console.log('\nTest 4: single placement, delivery >2 weeks out → 🟢 normal');
  {
    // weekISO 2026-06-01; PL-C delivery 2026-07-03 → Monday-of 6-29
    // → weeksUntil = 4 → normal.
    const plan = { placements: [ placement({ jobId: 'PL-C' }) ] };
    const out = buildPriorityOrder('2026-06-01', plan, jobsByIdFixture());
    check('normal has 1 item', out.normal.length === 1, JSON.stringify(out));
    check('highest empty',     out.highest.length === 0, JSON.stringify(out));
    check('high empty',        out.high.length === 0,    JSON.stringify(out));
    check('item is Job C',     out.normal[0]?.jobName === 'Job C', JSON.stringify(out.normal[0]));
  }

  console.log('\nTest 5: multi-station rollup — one crew on one job, multiple stations → one item with stations[] length > 1');
  {
    const plan = { placements: [
      placement({ crew: 'Ian', jobId: 'PL-A', station: 'Benchwork',            hours: 8 }),
      placement({ crew: 'Ian', jobId: 'PL-A', station: 'Pre Fin Cab Assembly', hours: 4 }),
      placement({ crew: 'Ian', jobId: 'PL-A', station: 'Post Fin Cab Assembly', hours: 6 }),
    ]};
    const out = buildPriorityOrder('2026-06-01', plan, jobsByIdFixture());
    check('one item total across all tiers',
      (out.highest.length + out.high.length + out.normal.length) === 1,
      JSON.stringify({ h: out.highest.length, m: out.high.length, n: out.normal.length }));
    const it = out.highest[0];
    check('stations[] length 3', it?.stations?.length === 3, JSON.stringify(it?.stations));
    const stationNames = (it?.stations || []).map(s => s.station).sort();
    check('stations include all three',
      JSON.stringify(stationNames) === JSON.stringify(['Benchwork', 'Post Fin Cab Assembly', 'Pre Fin Cab Assembly']),
      JSON.stringify(stationNames));
  }

  console.log('\nTest 6: multiple placements for same (crew, jobId, station) sum hours');
  {
    // Two placements rolling up into one stations[] entry totaling 12h.
    const plan = { placements: [
      placement({ crew: 'Ian', jobId: 'PL-A', station: 'Benchwork', hours: 8 }),
      placement({ crew: 'Ian', jobId: 'PL-A', station: 'Benchwork', hours: 4 }),
    ]};
    const out = buildPriorityOrder('2026-06-01', plan, jobsByIdFixture());
    const it = out.highest[0];
    check('one stations[] entry', it?.stations?.length === 1, JSON.stringify(it?.stations));
    check('hours summed to 12',   it?.stations?.[0]?.hours === 12, JSON.stringify(it?.stations));
  }

  console.log('\nTest 7: multi-crew on same job → multiple items in same tier, alphabetical by crew');
  {
    const plan = { placements: [
      placement({ crew: 'Spencer', jobId: 'PL-A', station: 'Benchwork', hours: 8 }),
      placement({ crew: 'Ian',     jobId: 'PL-A', station: 'Benchwork', hours: 8 }),
      placement({ crew: 'Bob',     jobId: 'PL-A', station: 'Benchwork', hours: 8 }),
    ]};
    const out = buildPriorityOrder('2026-06-01', plan, jobsByIdFixture());
    check('3 items in highest tier', out.highest.length === 3, JSON.stringify(out.highest.map(i => i.crew)));
    check('sorted alphabetical by crew',
      JSON.stringify(out.highest.map(i => i.crew)) === JSON.stringify(['Bob', 'Ian', 'Spencer']),
      JSON.stringify(out.highest.map(i => i.crew)));
  }

  console.log('\nTest 8: mixed tiers in one week — each tier sorted by deliveryDate ascending');
  {
    const plan = { placements: [
      placement({ crew: 'Ian',     jobId: 'PL-A', station: 'Benchwork', hours: 8 }),  // delivery 6-12 → highest
      placement({ crew: 'Spencer', jobId: 'PL-B', station: 'Benchwork', hours: 8 }),  // delivery 6-19 → high
      placement({ crew: 'Bob',     jobId: 'PL-C', station: 'Benchwork', hours: 8 }),  // delivery 7-03 → normal
    ]};
    const out = buildPriorityOrder('2026-06-01', plan, jobsByIdFixture());
    check('highest has 1', out.highest.length === 1, JSON.stringify(out.highest));
    check('high has 1',    out.high.length === 1,    JSON.stringify(out.high));
    check('normal has 1',  out.normal.length === 1,  JSON.stringify(out.normal));
    check('highest is Job A', out.highest[0]?.jobName === 'Job A', JSON.stringify(out.highest));
    check('high is Job B',    out.high[0]?.jobName    === 'Job B', JSON.stringify(out.high));
    check('normal is Job C',  out.normal[0]?.jobName  === 'Job C', JSON.stringify(out.normal));
  }

  console.log('\nTest 9: within-tier sort — deliveryDate ascending, then crew alphabetical as tiebreaker');
  {
    // Two jobs with different deliveries → sort by delivery first.
    // Add two crews on the SECOND job to test the crew-name tiebreaker.
    const plan = { placements: [
      placement({ crew: 'Ian',     jobId: 'PL-A', station: 'Benchwork', hours: 8 }),  // delivery 6-12 (earlier)
      placement({ crew: 'Spencer', jobId: 'PL-X', station: 'Benchwork', hours: 8 }),  // delivery 6-15 → Mon 6-15, weeks=2... no wait, need same tier
      placement({ crew: 'Bob',     jobId: 'PL-X', station: 'Benchwork', hours: 8 }),
    ]};
    const jobs = {
      'PL-A': { name: 'Job A', delivery: '2026-06-12', status: 'Scheduled' },
      // PL-X delivery 2026-06-08 → Monday-of 6-08 → weeksUntil = 1 → also highest. PL-A delivery 6-12 → 6-08 also.
      // We want both in same tier so the tiebreaker fires within tier.
      'PL-X': { name: 'Job X', delivery: '2026-06-08', status: 'Scheduled' },
    };
    const out = buildPriorityOrder('2026-06-01', { placements: plan.placements }, jobs);
    check('3 highest entries', out.highest.length === 3, JSON.stringify(out.highest.map(i => `${i.deliveryDate}/${i.crew}/${i.jobName}`)));
    // Sort: by deliveryDate ascending first → PL-X (6-08) entries before PL-A (6-12).
    // Within PL-X, crew tiebreaker alphabetical: Bob then Spencer.
    const order = out.highest.map(i => `${i.deliveryDate}|${i.crew}`);
    check('sort: PL-X/Bob then PL-X/Spencer then PL-A/Ian',
      JSON.stringify(order) === JSON.stringify([
        '2026-06-08|Bob',
        '2026-06-08|Spencer',
        '2026-06-12|Ian',
      ]),
      JSON.stringify(order));
  }

  console.log('\nTest 10: subcontractor crews are included like regular crews');
  {
    const plan = { placements: [
      placement({ crew: 'BCH-Bench-sub', jobId: 'PL-A', station: 'Benchwork', hours: 19.95 }),
    ]};
    const out = buildPriorityOrder('2026-06-01', plan, jobsByIdFixture());
    check('sub-crew appears in priority list', out.highest.length === 1, JSON.stringify(out.highest));
    check('sub-crew name preserved', out.highest[0]?.crew === 'BCH-Bench-sub', JSON.stringify(out.highest[0]));
  }

  console.log('\nTest 11: past-delivery job defensively → 🟢 normal tier');
  {
    // weekISO 2026-06-01; delivery 2026-05-22 (Friday) → Monday-of 5-18
    // → weeksUntil = -2 → normal (defensive routing per D4 + prompt).
    const plan = { placements: [
      placement({ crew: 'Ian', jobId: 'PL-OLD', station: 'Benchwork', hours: 4 }),
    ]};
    const jobs = { 'PL-OLD': { name: 'Old Job', delivery: '2026-05-22', status: 'Finishing' } };
    const out = buildPriorityOrder('2026-06-01', plan, jobs);
    check('past-delivery in normal tier',  out.normal.length === 1, JSON.stringify(out));
    check('highest empty',                 out.highest.length === 0, JSON.stringify(out));
    check('high empty',                    out.high.length === 0,    JSON.stringify(out));
  }

  console.log('\nTest 12: job in jobsById with no delivery date → defensively omitted');
  {
    const plan = { placements: [
      placement({ crew: 'Ian', jobId: 'PL-NULL', station: 'Benchwork', hours: 4 }),
    ]};
    const jobs = { 'PL-NULL': { name: 'Null Delivery Job', delivery: null, status: 'Scheduled' } };
    const out = buildPriorityOrder('2026-06-01', plan, jobs);
    check('no-delivery job omitted from all tiers',
      out.highest.length === 0 && out.high.length === 0 && out.normal.length === 0,
      JSON.stringify(out));
  }

  console.log('\nTest 13: pinned/force flag propagates from placement to stations[] and item');
  {
    // Two placements: one pinned, one not. Item.pinned should be true.
    const plan = { placements: [
      placement({ crew: 'Ian', jobId: 'PL-A', station: 'Benchwork',            hours: 8, pinned: true }),
      placement({ crew: 'Ian', jobId: 'PL-A', station: 'Pre Fin Cab Assembly', hours: 4 }),  // no pin
    ]};
    const out = buildPriorityOrder('2026-06-01', plan, jobsByIdFixture());
    const it = out.highest[0];
    check('item.pinned === true (any station pinned)', it?.pinned === true, JSON.stringify(it));
    const bench = it?.stations?.find(s => s.station === 'Benchwork');
    const prefin = it?.stations?.find(s => s.station === 'Pre Fin Cab Assembly');
    check('bench station carries pinned: true',   bench?.pinned === true,  JSON.stringify(bench));
    check('prefin station has no pinned flag (or false)',
      prefin?.pinned === undefined || prefin?.pinned === false,
      JSON.stringify(prefin));
  }

  console.log('\nTest 14: pinned/force via `force` field also propagates (planner uses both)');
  {
    const plan = { placements: [
      placement({ crew: 'Ian', jobId: 'PL-A', station: 'Benchwork', hours: 8, force: true }),
    ]};
    const out = buildPriorityOrder('2026-06-01', plan, jobsByIdFixture());
    check('item.pinned === true via force flag', out.highest[0]?.pinned === true, JSON.stringify(out.highest[0]));
  }

  console.log('\nTest 15: placements outside weekISO are filtered out');
  {
    const plan = { placements: [
      placement({ crew: 'Ian', jobId: 'PL-A', week: '2026-06-01', hours: 8 }),  // in
      placement({ crew: 'Ian', jobId: 'PL-A', week: '2026-06-08', hours: 4 }),  // out
    ]};
    const out = buildPriorityOrder('2026-06-01', plan, jobsByIdFixture());
    check('only 1 placement counted',
      out.highest[0]?.stations?.[0]?.hours === 8,
      JSON.stringify(out.highest[0]?.stations));
  }

  console.log('\nTest 16: placement with no jobId is skipped (orphan)');
  {
    const plan = { placements: [
      placement({ crew: 'Ian', jobId: null, station: 'Benchwork', hours: 8 }),
      placement({ crew: 'Ian', jobId: undefined, station: 'Benchwork', hours: 4 }),
      placement({ crew: 'Ian', jobId: 'PL-A',  station: 'Benchwork', hours: 2 }),
    ]};
    const out = buildPriorityOrder('2026-06-01', plan, jobsByIdFixture());
    check('only the valid placement counted',
      out.highest.length === 1 && out.highest[0]?.stations?.[0]?.hours === 2,
      JSON.stringify(out));
  }

  console.log('\nTest 17: placement referencing a jobId NOT in jobsById is skipped (inactive job)');
  {
    const plan = { placements: [
      placement({ crew: 'Ian', jobId: 'PL-INACTIVE', station: 'Benchwork', hours: 8 }),
    ]};
    const out = buildPriorityOrder('2026-06-01', plan, jobsByIdFixture());
    check('inactive job omitted',
      out.highest.length === 0 && out.high.length === 0 && out.normal.length === 0,
      JSON.stringify(out));
  }

  console.log('\nTest 18: deliveryRelative is a human-readable "DayAbbr M/D" string');
  {
    // PL-A delivery 2026-06-12 — that's a Friday.
    const plan = { placements: [ placement({ jobId: 'PL-A' }) ] };
    const out = buildPriorityOrder('2026-06-01', plan, jobsByIdFixture());
    const rel = out.highest[0]?.deliveryRelative;
    check('deliveryRelative starts with weekday abbr',
      /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}\/\d{1,2}$/.test(rel || ''),
      `deliveryRelative=${rel}`);
    check('deliveryRelative is "Fri 6/12"', rel === 'Fri 6/12', `got ${rel}`);
  }

  console.log('\nTest 19: weeksUntil boundary at 0 (same-week delivery) → 🔴 highest');
  {
    // weekISO 2026-06-08; delivery 2026-06-12 Friday → Monday-of 6-08
    // → weeksUntil = 0 → highest.
    const plan = { placements: [ placement({ week: '2026-06-08', jobId: 'PL-A' }) ] };
    const out = buildPriorityOrder('2026-06-08', plan, jobsByIdFixture());
    check('same-week delivery → highest', out.highest.length === 1, JSON.stringify(out));
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All C1 capacity-view-generator tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
