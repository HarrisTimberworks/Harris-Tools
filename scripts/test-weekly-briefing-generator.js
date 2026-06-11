#!/usr/bin/env node
/**
 * C6 — Weekly Briefing generator (pure functions, no monday I/O).
 *
 * buildWeeklyBriefingDoc(plan, jobsById, timeOff, options)
 *   → { title, weekISO, markdown }
 *
 * Single-week printable for the Monday meeting (design spec "Weekly Briefing
 * doc"; plan doc §C C6 + D2). Reuses C2's buildWeekSection for the week body;
 * briefing-specific framing is the H1 title + Generated header line.
 *
 * Week selection — briefingWeekFor(date):
 *   - Sat/Sun (UTC day) → NEXT Monday (the Saturday 6pm scheduled run briefs
 *     the upcoming week; note Friday-evening Mountain runs land on Saturday
 *     UTC, which matches the Friday-shutdown plan-next-week use case).
 *   - Mon–Fri → Monday of the CURRENT week (a mid-week on-demand run briefs
 *     the week in progress).
 *   - options.weekISO overrides for tests / operator control.
 *
 * Title (D2): "📋 HTW Weekly Briefing — Week of YYYY-MM-DD" (ISO date,
 * matching the D2 example "Week of 2026-06-01").
 *
 * No legend section — spec's briefing shape is top notes + crew table +
 * priority order only.
 */

const {
  briefingWeekFor,
  buildWeeklyBriefingTitle,
  buildWeeklyBriefingDoc,
} = require('./weekly-briefing-generator.js');

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
// Fixtures
// ---------------------------------------------------------------------------

function placement(overrides = {}) {
  return {
    crew: 'Ian',
    week: '2026-06-15',
    jobId: 'PL-A',
    jobName: 'Job A',
    masterPmId: 'MPM-A',
    station: 'Benchwork',
    hours: 8,
    parentId: 'p-ian',
    ...overrides,
  };
}

function planFixture() {
  return {
    placements: [
      placement(),
      placement({ crew: 'Ken', station: 'Panel Processing', hours: 12 }),
      // A different week — must NOT leak into the single-week briefing.
      placement({ crew: 'Bob', week: '2026-06-22', hours: 6 }),
    ],
    capacityGrid: {
      Ian: { '2026-06-15': { committed: 8,  avail: 40 } },
      Ken: { '2026-06-15': { committed: 12, avail: 40 } },
      Bob: { '2026-06-22': { committed: 6,  avail: 40 } },
    },
    finishingCycleReport: { rows: [
      { jobName: 'Job A', finishDrop: '2026-06-16', finishReturn: '2026-06-26' },
    ] },
  };
}

function jobsByIdFixture() {
  return {
    'PL-A': { name: 'Job A', delivery: '2026-06-19' },
  };
}

(async () => {

  console.log('Test 1: exports exist');
  {
    check('briefingWeekFor is a function', typeof briefingWeekFor === 'function', `typeof=${typeof briefingWeekFor}`);
    check('buildWeeklyBriefingTitle is a function', typeof buildWeeklyBriefingTitle === 'function', `typeof=${typeof buildWeeklyBriefingTitle}`);
    check('buildWeeklyBriefingDoc is a function', typeof buildWeeklyBriefingDoc === 'function', `typeof=${typeof buildWeeklyBriefingDoc}`);
  }

  console.log('\nTest 2: briefingWeekFor — weekday runs brief the CURRENT week');
  {
    check('Mon 2026-06-08 → 2026-06-08', briefingWeekFor(new Date('2026-06-08T15:00:00Z')) === '2026-06-08', briefingWeekFor(new Date('2026-06-08T15:00:00Z')));
    check('Wed 2026-06-10 → 2026-06-08', briefingWeekFor(new Date('2026-06-10T15:00:00Z')) === '2026-06-08', briefingWeekFor(new Date('2026-06-10T15:00:00Z')));
    check('Fri 2026-06-12 → 2026-06-08', briefingWeekFor(new Date('2026-06-12T15:00:00Z')) === '2026-06-08', briefingWeekFor(new Date('2026-06-12T15:00:00Z')));
  }

  console.log('\nTest 3: briefingWeekFor — weekend runs brief the UPCOMING week');
  {
    check('Sat 2026-06-13 → 2026-06-15', briefingWeekFor(new Date('2026-06-13T01:00:00Z')) === '2026-06-15', briefingWeekFor(new Date('2026-06-13T01:00:00Z')));
    check('Sun 2026-06-14 → 2026-06-15', briefingWeekFor(new Date('2026-06-14T23:00:00Z')) === '2026-06-15', briefingWeekFor(new Date('2026-06-14T23:00:00Z')));
  }

  console.log('\nTest 4: buildWeeklyBriefingTitle — D2 ISO-date format');
  {
    const t = buildWeeklyBriefingTitle('2026-06-15');
    check('title is "📋 HTW Weekly Briefing — Week of 2026-06-15"',
      t === '📋 HTW Weekly Briefing — Week of 2026-06-15', t);
  }

  console.log('\nTest 5: buildWeeklyBriefingDoc — return shape + explicit weekISO override');
  {
    const out = buildWeeklyBriefingDoc(planFixture(), jobsByIdFixture(), [], {
      weekISO: '2026-06-15',
      generatedAt: new Date('2026-06-13T01:00:00Z'),
    });
    check('returns { title, weekISO, markdown }',
      out && typeof out.title === 'string' && typeof out.markdown === 'string' && out.weekISO === '2026-06-15',
      JSON.stringify(Object.keys(out || {})));
    check('title matches the chosen week', out.title === '📋 HTW Weekly Briefing — Week of 2026-06-15', out.title);
  }

  console.log('\nTest 6: markdown framing — H1 title + Generated header line');
  {
    const out = buildWeeklyBriefingDoc(planFixture(), jobsByIdFixture(), [], {
      weekISO: '2026-06-15',
      generatedAt: new Date('2026-06-13T01:00:00Z'),
    });
    const lines = out.markdown.split('\n');
    check('first line is H1 title', lines[0] === '# 📋 HTW Weekly Briefing — Week of 2026-06-15', lines[0]);
    check('Generated header line present',
      /\*\*Generated:\*\* \d{4}-\d{2}-\d{2} \d{2}:\d{2} • \*\*Source:\*\* auto-generated by `scripts\/run-planner\.js --plan` • \*\*Edit:\*\* Manual Overrides board \(18413101550\)/.test(out.markdown),
      out.markdown.slice(0, 400));
  }

  console.log('\nTest 7: single-week body — chosen week only, other weeks excluded');
  {
    const out = buildWeeklyBriefingDoc(planFixture(), jobsByIdFixture(), [], {
      weekISO: '2026-06-15',
      generatedAt: new Date('2026-06-13T01:00:00Z'),
    });
    const weekHeadings = out.markdown.match(/^## Week of .*$/gm) || [];
    check('exactly one "## Week of" section', weekHeadings.length === 1, JSON.stringify(weekHeadings));
    check('section is week 6/15', /^## Week of 6\/15 — 20\.00 crew hrs$/m.test(out.markdown), JSON.stringify(weekHeadings));
    check('other-week placement (Bob 6/22) absent', !/Bob/.test(out.markdown), '');
  }

  console.log('\nTest 8: body carries key dates, crew table, priority order (C2 shape)');
  {
    const out = buildWeeklyBriefingDoc(planFixture(), jobsByIdFixture(), [], {
      weekISO: '2026-06-15',
      generatedAt: new Date('2026-06-13T01:00:00Z'),
    });
    check('key-dates block has finish drop', /📌 Tue 6\/16 — Job A finish drop/.test(out.markdown), out.markdown.slice(0, 800));
    check('key-dates block has delivery', /🚚 Fri 6\/19 — Job A delivery/.test(out.markdown), '');
    check('crew table header present', /\| Crew \| Load \| Job \| Station \| Hrs \|/.test(out.markdown), '');
    check('Ian row present', /\| Ian \| 8 \/ 40 \| Job A \| Bench \| 8 \|/.test(out.markdown), out.markdown);
    check('priority order label present', /\*\*Priority order \(earliest downstream date first\):\*\*/.test(out.markdown), '');
  }

  console.log('\nTest 9: no legend section in the briefing');
  {
    const out = buildWeeklyBriefingDoc(planFixture(), jobsByIdFixture(), [], {
      weekISO: '2026-06-15',
      generatedAt: new Date('2026-06-13T01:00:00Z'),
    });
    check('"## Legend" absent', !/## Legend/.test(out.markdown), '');
  }

  console.log('\nTest 10: default week = briefingWeekFor(generatedAt)');
  {
    // Saturday generatedAt → upcoming Monday 6/15.
    const out = buildWeeklyBriefingDoc(planFixture(), jobsByIdFixture(), [], {
      generatedAt: new Date('2026-06-13T01:00:00Z'),
    });
    check('weekISO defaulted to 2026-06-15', out.weekISO === '2026-06-15', out.weekISO);
  }

  console.log('\nTest 11: acceptedOverrides propagate → 🔧 on matching cell');
  {
    const out = buildWeeklyBriefingDoc(planFixture(), jobsByIdFixture(), [], {
      weekISO: '2026-06-15',
      generatedAt: new Date('2026-06-13T01:00:00Z'),
      acceptedOverrides: [{ jobId: 'PL-A', station: 'Benchwork', crew: 'Ian', week: '2026-06-15' }],
    });
    check('Ian Hrs cell wrenched', /\| Ian \| 8 \/ 40 \| Job A \| Bench \| 🔧 8 \|/.test(out.markdown), out.markdown);
    check('Ken Hrs cell NOT wrenched', /\| Ken \| 12 \/ 40 \| Job A \| Panel \| 12 \|/.test(out.markdown), out.markdown);
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All C6 weekly-briefing-generator tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
