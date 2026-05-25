#!/usr/bin/env node
/**
 * C2 — buildWeekSection pure function.
 *
 * Tests for the per-week markdown section generator. Locked shape per
 * chat-approved C2 markdown proposal:
 *   - Heading: ## Week of M/D — XX.XX crew hrs (2 decimals always)
 *   - Key-dates: 📌 finish drop / 🎯 finish return / 🚚 delivery, bold lines
 *     (🚧 holiday deferred to Phase 5)
 *   - Crew table (5 cols Crew/Load/Job/Station/Hrs): alphabetical crews,
 *     multi-station continuation rows have blank Crew + blank Load,
 *     sub rows show N / — in Load and *(sub)* italic suffix on Hrs,
 *     pinned cells append *(pinned)* italic suffix, PTO rows use
 *     em-dash (—) for empty cells (not truly blank)
 *   - Capacity thresholds (sourced from SOFT_CAP_MULTIPLIER = 1.05 at
 *     rebalance-schedule.js:169):
 *       🔴: committed > available * 1.05
 *       🟡: committed / available ≥ 0.95 AND NOT over
 *       blank: under 0.95
 *   - 🔧 indicator (C5 hook): options.acceptedOverrides matches
 *     (jobId, station, crew, week) → Hrs cell gets "🔧 " prefix
 *   - Priority order: bold "Priority order…" label, tier headers with
 *     auto-scaffolded "<JobName> delivery <DayAbbr M/D>" context for
 *     🔴/🟡 (🟢 NORMAL has no context line), continuous numbering
 *     across tiers, item format
 *       **<Crew> — <Job> <stations summary>** — delivery <DayAbbr M/D>
 *     Stations summary: abbreviated names joined with " + ", pinned
 *     marker per station: Bench (8h, pinned)
 *   - Job names: full Master PM names as-is
 *   - Station abbreviations: Eng/Panel/Bench/PreFin/PostFin/P&S/Deliver/Field
 *   - Trailing divider: ---
 */

const { buildWeekSection } = require('./capacity-view-generator.js');

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

function makePlan(overrides = {}) {
  return {
    placements: [],
    capacityGrid: {},
    finishingCycleReport: { rows: [] },
    ...overrides,
  };
}

function jobsByIdFixture() {
  return {
    'PL-A': { name: 'MAG - Roster 5 — Frameless (P1)', delivery: '2026-06-12', status: 'Scheduled' },
    'PL-B': { name: 'F&B - Quince Ave',                 delivery: '2026-06-19', status: 'Scheduled' },
    'PL-C': { name: 'SH - McMorris',                    delivery: '2026-07-03', status: 'Scheduled' },
  };
}

// ---------------------------------------------------------------------------

(async () => {

  console.log('Test 1: heading format — `## Week of M/D — XX.XX crew hrs` (2 decimals always)');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Ian', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 8 },
      ],
      capacityGrid: { Ian: { '2026-06-01': { committed: 8, available: 40 } } },
    });
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), []);
    check('starts with heading',          out.startsWith('## Week of 6/1 — '), `prefix: ${out.slice(0, 40)}`);
    check('crew hrs uses 2 decimals',     /## Week of 6\/1 — 8\.00 crew hrs/.test(out), out.slice(0, 60));
  }

  console.log('\nTest 2: heading — sum of placement hours across all crews');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Ian',     week: '2026-06-08', jobId: 'PL-A', station: 'Benchwork', hours: 8 },
        { crew: 'Spencer', week: '2026-06-08', jobId: 'PL-A', station: 'Pre Fin Cab Assembly', hours: 4 },
        { crew: 'Bob',     week: '2026-06-08', jobId: 'PL-B', station: 'Benchwork', hours: 19.95 },
      ],
      capacityGrid: {
        Ian:     { '2026-06-08': { committed: 8,     available: 40 } },
        Spencer: { '2026-06-08': { committed: 4,     available: 40 } },
        Bob:     { '2026-06-08': { committed: 19.95, available: 40 } },
      },
    });
    const out = buildWeekSection('2026-06-08', plan, jobsByIdFixture(), []);
    check('heading sums hours to 31.95', /## Week of 6\/8 — 31\.95 crew hrs/.test(out), out.slice(0, 60));
  }

  console.log('\nTest 3: empty week → heading + empty table + no priority items + divider');
  {
    const out = buildWeekSection('2026-06-01', makePlan(), jobsByIdFixture(), []);
    check('heading present',        /## Week of 6\/1 — 0\.00 crew hrs/.test(out), out.slice(0, 60));
    check('crew table header row',  /\| Crew \| Load \| Job \| Station \| Hrs \|/.test(out), 'expected header row');
    check('priority order label',   /\*\*Priority order \(earliest downstream date first\):\*\*/.test(out), 'expected priority label');
    check('no tier blocks',         !/🔴|🟡|🟢/.test(out), 'no tier markers expected');
    check('trailing divider',       /---\s*$/.test(out.trim() + '\n'), 'expected trailing ---');
  }

  console.log('\nTest 4: single crew + single station — minimal table + 1 priority item');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Ian', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 8 },
      ],
      capacityGrid: { Ian: { '2026-06-01': { committed: 8, available: 40 } } },
    });
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), []);
    check('table contains Ian row', /\| Ian \| 8 \/ 40 \| MAG - Roster 5 — Frameless \(P1\) \| Bench \| 8 \|/.test(out), out);
    check('priority item present',  /\*\*Ian — MAG - Roster 5 — Frameless \(P1\) Bench \(8h\)\*\* — delivery Fri 6\/12/.test(out), out);
  }

  console.log('\nTest 5: single crew + multi-station — continuation rows have blank Crew + blank Load');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Ian', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork',            hours: 8 },
        { crew: 'Ian', week: '2026-06-01', jobId: 'PL-A', station: 'Pre Fin Cab Assembly', hours: 4 },
        { crew: 'Ian', week: '2026-06-01', jobId: 'PL-A', station: 'Post Fin Cab Assembly', hours: 2 },
      ],
      capacityGrid: { Ian: { '2026-06-01': { committed: 14, available: 40 } } },
    });
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), []);
    check('first row has Crew + Load',
      /\| Ian \| 14 \/ 40 \| MAG - Roster 5 — Frameless \(P1\) \| Bench \| 8 \|/.test(out),
      'expected first Ian row with Load filled');
    check('continuation row 2 has blank Crew + blank Load (PreFin)',
      /\|\s*\|\s*\| MAG - Roster 5 — Frameless \(P1\) \| PreFin \| 4 \|/.test(out),
      'expected blank Crew/Load on continuation');
    check('continuation row 3 has blank Crew + blank Load (PostFin)',
      /\|\s*\|\s*\| MAG - Roster 5 — Frameless \(P1\) \| PostFin \| 2 \|/.test(out),
      'expected blank Crew/Load on continuation');
  }

  console.log('\nTest 6: multiple crews — sorted alphabetical');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Spencer', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 4 },
        { crew: 'Bob',     week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 4 },
        { crew: 'Ian',     week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 4 },
      ],
      capacityGrid: {
        Spencer: { '2026-06-01': { committed: 4, available: 40 } },
        Bob:     { '2026-06-01': { committed: 4, available: 40 } },
        Ian:     { '2026-06-01': { committed: 4, available: 40 } },
      },
    });
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), []);
    const bobIdx = out.indexOf('| Bob |');
    const ianIdx = out.indexOf('| Ian |');
    const spencerIdx = out.indexOf('| Spencer |');
    check('Bob before Ian',     bobIdx < ianIdx && bobIdx >= 0, `Bob=${bobIdx}, Ian=${ianIdx}`);
    check('Ian before Spencer', ianIdx < spencerIdx && ianIdx >= 0, `Ian=${ianIdx}, Spencer=${spencerIdx}`);
  }

  console.log('\nTest 7: subcontractor row — Load shows N / —, Hrs has *(sub)* italic suffix');
  {
    const plan = makePlan({
      placements: [
        { crew: 'BCH-Bench-sub', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 19.95 },
      ],
      capacityGrid: {
        'BCH-Bench-sub': { '2026-06-01': { committed: 19.95, available: 0, subcontractor: true } },
      },
    });
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), []);
    check('Load cell shows "19.95 / —"',
      /\| BCH-Bench-sub \| 19\.95 \/ — \|/.test(out),
      out.match(/\| BCH-Bench-sub[^\n]+/)?.[0] || 'no sub row');
    check('Hrs cell has italic *(sub)* suffix',
      /\| 19\.95 \*\(sub\)\* \|/.test(out),
      out.match(/\| BCH-Bench-sub[^\n]+/)?.[0] || 'no sub row');
  }

  console.log('\nTest 8: pinned placement — Hrs has *(pinned)* italic suffix');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Ian', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 8, pinned: true },
      ],
      capacityGrid: { Ian: { '2026-06-01': { committed: 8, available: 40 } } },
    });
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), []);
    check('Hrs cell has italic *(pinned)*',
      /\| 8 \*\(pinned\)\* \|/.test(out),
      out.match(/\| Ian[^\n]+/)?.[0] || 'no Ian row');
  }

  console.log('\nTest 9: PTO crew (no placements) — Load shows "PTO (40h)", other cells use em-dash');
  {
    const plan = makePlan({
      capacityGrid: { Rob: { '2026-06-01': { committed: 0, available: 0, base: 40, timeOff: 40 } } },
    });
    const timeOff = [{ crew: 'Rob', week: '2026-06-01', hours: 40 }];
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), timeOff);
    check('PTO row present with em-dashes',
      /\| Rob \| PTO \(40h\) \| — \| — \| — \|/.test(out),
      out.match(/\| Rob[^\n]+/)?.[0] || 'no Rob row');
  }

  console.log('\nTest 10: capacity threshold — over-cap (committed > 1.05 * available) → 🔴');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Bob', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 45 },
      ],
      // 45 / 32 = 1.406, > 1.05 → 🔴
      capacityGrid: { Bob: { '2026-06-01': { committed: 45, available: 32 } } },
    });
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), []);
    check('Load shows 🔴', /\| Bob \| 45 \/ 32 🔴 \|/.test(out), out.match(/\| Bob[^\n]+/)?.[0]);
  }

  console.log('\nTest 11: capacity threshold — at boundary 1.05× (NOT over) → 🟡');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Bob', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 42 },
      ],
      // 42 / 40 = 1.05 exactly, NOT strictly > 1.05 → 🟡
      capacityGrid: { Bob: { '2026-06-01': { committed: 42, available: 40 } } },
    });
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), []);
    check('Load shows 🟡 at 1.05x', /\| Bob \| 42 \/ 40 🟡 \|/.test(out), out.match(/\| Bob[^\n]+/)?.[0]);
  }

  console.log('\nTest 12: capacity threshold — at-cap (≥95% and not over) → 🟡');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Spencer', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 38 },
      ],
      // 38 / 40 = 0.95 → 🟡
      capacityGrid: { Spencer: { '2026-06-01': { committed: 38, available: 40 } } },
    });
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), []);
    check('Load shows 🟡 at 0.95', /\| Spencer \| 38 \/ 40 🟡 \|/.test(out), out.match(/\| Spencer[^\n]+/)?.[0]);
  }

  console.log('\nTest 13: capacity threshold — under-cap (<95%) → no marker');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Ian', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 20 },
      ],
      capacityGrid: { Ian: { '2026-06-01': { committed: 20, available: 40 } } },
    });
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), []);
    check('Load has no marker (20 / 40)', /\| Ian \| 20 \/ 40 \|/.test(out), out.match(/\| Ian[^\n]+/)?.[0]);
    check('no 🔴 or 🟡 on Ian row',
      !/\| Ian \|[^\n]*🔴|\| Ian \|[^\n]*🟡/.test(out),
      out.match(/\| Ian[^\n]+/)?.[0]);
  }

  console.log('\nTest 14: key-dates block — all 3 supported emoji types (📌 finish drop, 🎯 finish return, 🚚 delivery)');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Ian', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 8 },
      ],
      capacityGrid: { Ian: { '2026-06-01': { committed: 8, available: 40 } } },
      finishingCycleReport: {
        rows: [
          { jobId: 'PL-A', jobName: 'MAG - Roster 5 — Frameless (P1)',
            finishDrop: '2026-06-05', finishReturn: '2026-06-19', valid: true },
        ],
      },
    });
    // PL-A delivery is 2026-06-12 (jobsByIdFixture). With weekISO 2026-06-01:
    //   - finishDrop 2026-06-05 IS in the 6-01 week → 📌 should appear
    //   - delivery 2026-06-12 is NOT in the 6-01 week → 🚚 should NOT appear here
    // To test all 3 emoji, use 2026-06-08 week where delivery + finishReturn land.
    // We'll do a multi-day spread below.
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), []);
    check('📌 finish drop line for PL-A in week 6-01',
      /📌 Fri 6\/5 — MAG - Roster 5 — Frameless \(P1\) finish drop/.test(out),
      out.split('\n').find(l => l.includes('📌')) || 'no 📌 line');
  }

  console.log('\nTest 15: key-dates block — 🚚 client delivery surfaces when delivery date lands in the week');
  {
    const jobs = {
      'PL-A': { name: 'MAG - Roster 5 — Frameless (P1)', delivery: '2026-06-10', status: 'Scheduled' },
    };
    const plan = makePlan({
      placements: [
        { crew: 'Ian', week: '2026-06-08', jobId: 'PL-A', station: 'Benchwork', hours: 8 },
      ],
      capacityGrid: { Ian: { '2026-06-08': { committed: 8, available: 40 } } },
    });
    const out = buildWeekSection('2026-06-08', plan, jobs, []);
    check('🚚 client delivery line',
      /🚚 Wed 6\/10 — MAG - Roster 5 — Frameless \(P1\) delivery/.test(out),
      out.split('\n').find(l => l.includes('🚚')) || 'no 🚚 line');
  }

  console.log('\nTest 16: key-dates block — 🎯 finish return surfaces when finishReturn lands in the week');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Ian', week: '2026-06-15', jobId: 'PL-A', station: 'Benchwork', hours: 8 },
      ],
      capacityGrid: { Ian: { '2026-06-15': { committed: 8, available: 40 } } },
      finishingCycleReport: {
        rows: [
          { jobId: 'PL-A', jobName: 'MAG - Roster 5 — Frameless (P1)',
            finishDrop: '2026-06-05', finishReturn: '2026-06-19', valid: true },
        ],
      },
    });
    const out = buildWeekSection('2026-06-15', plan, jobsByIdFixture(), []);
    check('🎯 finish return line', /🎯 Fri 6\/19 — MAG - Roster 5 — Frameless \(P1\) finish return/.test(out),
      out.split('\n').find(l => l.includes('🎯')) || 'no 🎯 line');
  }

  console.log('\nTest 17: priority list — 3 tiers with continuous numbering, 🟢 has no context');
  {
    const jobs = {
      'PL-H1': { name: 'Job H1', delivery: '2026-06-08', status: 'Scheduled' }, // weeksUntil=1 → highest
      'PL-H2': { name: 'Job H2', delivery: '2026-06-12', status: 'Scheduled' }, // weeksUntil=1 → highest
      'PL-M':  { name: 'Job M',  delivery: '2026-06-19', status: 'Scheduled' }, // weeksUntil=2 → high
      'PL-N':  { name: 'Job N',  delivery: '2026-07-03', status: 'Scheduled' }, // weeksUntil=4 → normal
    };
    const plan = makePlan({
      placements: [
        { crew: 'Ian',     week: '2026-06-01', jobId: 'PL-H1', station: 'Benchwork', hours: 8 },
        { crew: 'Spencer', week: '2026-06-01', jobId: 'PL-H2', station: 'Benchwork', hours: 8 },
        { crew: 'Bob',     week: '2026-06-01', jobId: 'PL-M',  station: 'Benchwork', hours: 8 },
        { crew: 'Ken',     week: '2026-06-01', jobId: 'PL-N',  station: 'Panel Processing', hours: 8 },
      ],
      capacityGrid: {
        Ian:     { '2026-06-01': { committed: 8, available: 40 } },
        Spencer: { '2026-06-01': { committed: 8, available: 40 } },
        Bob:     { '2026-06-01': { committed: 8, available: 40 } },
        Ken:     { '2026-06-01': { committed: 8, available: 40 } },
      },
    });
    const out = buildWeekSection('2026-06-01', plan, jobs, []);
    check('🔴 HIGHEST line with auto-context (Job H1 delivery, earliest in tier)',
      /\*\*🔴 HIGHEST — Job H1 delivery Mon 6\/8\*\*/.test(out),
      out.split('\n').find(l => l.includes('🔴')) || 'no 🔴 line');
    check('🟡 HIGH line with auto-context (Job M)',
      /\*\*🟡 HIGH — Job M delivery Fri 6\/19\*\*/.test(out),
      out.split('\n').find(l => l.includes('🟡')) || 'no 🟡 line');
    check('🟢 NORMAL line with NO context',
      /\*\*🟢 NORMAL\*\*/.test(out) && !/\*\*🟢 NORMAL — /.test(out),
      out.split('\n').find(l => l.includes('🟢')) || 'no 🟢 line');
    // Continuous numbering: 1, 2 in highest; 3 in high; 4 in normal.
    // Highest tier sorted by deliveryDate ascending: H1 (6-08) then H2 (6-12).
    // Within tier with same delivery, sort by crew alphabetical.
    const lines = out.split('\n');
    const item1 = lines.find(l => /^1\./.test(l));
    const item2 = lines.find(l => /^2\./.test(l));
    const item3 = lines.find(l => /^3\./.test(l));
    const item4 = lines.find(l => /^4\./.test(l));
    check('item 1 is Ian/H1 (earliest delivery in highest)',
      item1 && /\*\*Ian — Job H1/.test(item1),
      item1 || 'no item 1');
    check('item 2 is Spencer/H2',
      item2 && /\*\*Spencer — Job H2/.test(item2),
      item2 || 'no item 2');
    check('item 3 is Bob/M (high tier, numbering continues)',
      item3 && /\*\*Bob — Job M/.test(item3),
      item3 || 'no item 3');
    check('item 4 is Ken/N (normal tier, numbering continues)',
      item4 && /\*\*Ken — Job N/.test(item4),
      item4 || 'no item 4');
  }

  console.log('\nTest 18: priority item — auto-filled reason "— delivery <DayAbbr M/D>"');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Ian', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 8 },
      ],
      capacityGrid: { Ian: { '2026-06-01': { committed: 8, available: 40 } } },
    });
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), []);
    check('priority item ends with "— delivery Fri 6/12"',
      /\*\*Ian — MAG - Roster 5 — Frameless \(P1\) Bench \(8h\)\*\* — delivery Fri 6\/12/.test(out),
      out.split('\n').find(l => l.startsWith('1.')) || 'no item 1');
  }

  console.log('\nTest 19: priority item — stations summary joined with " + ", pinned marker per station');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Ian', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork',            hours: 8, pinned: true },
        { crew: 'Ian', week: '2026-06-01', jobId: 'PL-A', station: 'Pre Fin Cab Assembly', hours: 4 },
      ],
      capacityGrid: { Ian: { '2026-06-01': { committed: 12, available: 40 } } },
    });
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), []);
    check('stations summary "Bench (8h, pinned) + PreFin (4h)"',
      /Bench \(8h, pinned\) \+ PreFin \(4h\)/.test(out),
      out.split('\n').find(l => l.startsWith('1.')) || 'no item 1');
  }

  console.log('\nTest 20: station abbreviation table — all 7 stations map correctly');
  {
    const stationsMap = [
      ['Engineering',           'Eng'],
      ['Panel Processing',      'Panel'],
      ['Benchwork',             'Bench'],
      ['Pre Fin Cab Assembly',  'PreFin'],
      ['Post Fin Cab Assembly', 'PostFin'],
      ['Pack & Ship',           'P&S'],
      ['Delivery',              'Deliver'],
    ];
    for (const [full, abbr] of stationsMap) {
      const plan = makePlan({
        placements: [
          { crew: 'Ian', week: '2026-06-01', jobId: 'PL-A', station: full, hours: 2 },
        ],
        capacityGrid: { Ian: { '2026-06-01': { committed: 2, available: 40 } } },
      });
      const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), []);
      // Match the station column literally in the table.
      const tableRow = out.match(/\| Ian \|[^\n]+/)?.[0] || '';
      check(`${full} → ${abbr} in Station cell`,
        new RegExp(`\\| ${abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\|`).test(tableRow),
        tableRow);
    }
  }

  console.log('\nTest 21: 🔧 indicator — when (jobId, station, crew, week) matches options.acceptedOverrides, Hrs cell gets "🔧 " prefix');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Ian', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 8 },
      ],
      capacityGrid: { Ian: { '2026-06-01': { committed: 8, available: 40 } } },
    });
    const opts = {
      acceptedOverrides: [
        { jobId: 'PL-A', station: 'Benchwork', crew: 'Ian', week: '2026-06-01' },
      ],
    };
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), [], opts);
    check('Hrs cell has 🔧 prefix', /\| 🔧 8 \|/.test(out), out.match(/\| Ian[^\n]+/)?.[0]);
  }

  console.log('\nTest 22: 🔧 indicator — no match → no 🔧 anywhere');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Ian', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 8 },
      ],
      capacityGrid: { Ian: { '2026-06-01': { committed: 8, available: 40 } } },
    });
    const opts = {
      acceptedOverrides: [
        { jobId: 'PL-OTHER', station: 'Benchwork', crew: 'Ian', week: '2026-06-01' },
      ],
    };
    const out = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), [], opts);
    check('no 🔧 in output (jobId mismatch)', !/🔧/.test(out), 'unexpected 🔧 in output');
  }

  console.log('\nTest 23: 🔧 indicator — empty/missing options → no 🔧 anywhere (backwards-compat)');
  {
    const plan = makePlan({
      placements: [
        { crew: 'Ian', week: '2026-06-01', jobId: 'PL-A', station: 'Benchwork', hours: 8 },
      ],
      capacityGrid: { Ian: { '2026-06-01': { committed: 8, available: 40 } } },
    });
    const outNoOpts  = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), []);
    const outEmptyOpts = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), [], {});
    const outEmptyArr  = buildWeekSection('2026-06-01', plan, jobsByIdFixture(), [], { acceptedOverrides: [] });
    check('no 🔧 with no options',          !/🔧/.test(outNoOpts),    'unexpected 🔧');
    check('no 🔧 with empty options object', !/🔧/.test(outEmptyOpts), 'unexpected 🔧');
    check('no 🔧 with empty acceptedOverrides array', !/🔧/.test(outEmptyArr), 'unexpected 🔧');
  }

  console.log('\nTest 24: trailing divider — section ends with --- on its own line');
  {
    const out = buildWeekSection('2026-06-01', makePlan(), jobsByIdFixture(), []);
    check('ends with "---\\n"', out.trimEnd().endsWith('---'), out.slice(-20));
  }

  console.log('\nTest 25: same-day double-event in key-dates — two jobs sharing a finish drop date list both jobs');
  {
    const jobs = {
      'PL-A': { name: 'Liz Stapp', delivery: '2026-06-12', status: 'Scheduled' },
      'PL-B': { name: 'SH McMorris', delivery: '2026-06-19', status: 'Scheduled' },
    };
    const plan = makePlan({
      placements: [
        { crew: 'Ian', week: '2026-05-25', jobId: 'PL-A', station: 'Benchwork', hours: 4 },
      ],
      capacityGrid: { Ian: { '2026-05-25': { committed: 4, available: 40 } } },
      finishingCycleReport: {
        rows: [
          { jobId: 'PL-A', jobName: 'Liz Stapp',   finishDrop: '2026-05-29', finishReturn: '2026-06-12', valid: true },
          { jobId: 'PL-B', jobName: 'SH McMorris', finishDrop: '2026-05-29', finishReturn: '2026-06-19', valid: true },
        ],
      },
    });
    const out = buildWeekSection('2026-05-25', plan, jobs, []);
    check('shared 📌 line lists both jobs',
      /📌 Fri 5\/29 — Liz Stapp \+ SH McMorris finish drops/.test(out),
      out.split('\n').find(l => l.includes('📌')) || 'no shared 📌 line');
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All C2 capacity-view-section tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
