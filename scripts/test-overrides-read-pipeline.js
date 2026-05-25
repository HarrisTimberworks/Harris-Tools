#!/usr/bin/env node
/**
 * B4 — Manual Overrides board read pipeline.
 *
 * Tests pure functions:
 *   - loadOverridesBoard({ gqlFn }) — reads Manual Overrides board, filters to
 *     Active group, normalizes each row.
 *   - translateOverrideRows(rows, plJobs, crewParents) — pure: maps normalized
 *     rows to internal forceAssignment / crewExclusion shapes. Skips non-Pending,
 *     defers unresolved Job / Crew refs to an `untranslatable` bucket.
 *   - mergeForceAssignments(jsonForces, boardForces) — pure. Board wins on
 *     (jobId × station × week × crew) tuple match.
 *   - mergeCrewExclusions(jsonExclusions, boardExclusions) — pure. Board
 *     entries that re-target a (crew, jobId) already in JSON.excludeJobs are
 *     logged as conflicts (redundant); merged retains both.
 *
 * Runs without MONDAY_API_TOKEN — all gqlFn injections are synthetic.
 */

const {
  loadOverridesBoard,
  translateOverrideRows,
  mergeForceAssignments,
  mergeCrewExclusions,
  runPlan,
  getMondayOfWeek,
  addDays,
  toISO,
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

// ---------------------------------------------------------------------------
// Synthetic raw-monday items used by loadOverridesBoard tests
// ---------------------------------------------------------------------------

function makeRawItem({
  id, groupId = 'topics',
  jobMpmId = null,
  station = 'Benchwork',
  fromCrewParentId = null, fromWeek = null,
  toCrewParentId = null, toWeek = null,
  hours = 8,
  status = 'Pending',
  allowOverCap = false,
}) {
  // Mimics the shape monday returns from items_page → items[].column_values.
  // BoardRelationValue inlines linked_item_ids; the rest carry text/value.
  return {
    id: String(id),
    group: { id: groupId },
    column_values: [
      { id: 'board_relation_mm3a4yk3', text: null, linked_item_ids: jobMpmId ? [String(jobMpmId)] : [] },
      { id: 'dropdown_mm3avza0', text: station },
      { id: 'board_relation_mm3agpw8', text: null, linked_item_ids: fromCrewParentId ? [String(fromCrewParentId)] : [] },
      { id: 'date_mm3adwrw', text: fromWeek },
      { id: 'board_relation_mm3aqb40', text: null, linked_item_ids: toCrewParentId ? [String(toCrewParentId)] : [] },
      { id: 'date_mm3ack0z', text: toWeek },
      { id: 'numeric_mm3ad4na', text: String(hours) },
      { id: 'color_mm3aqx5g', text: status },
      { id: 'boolean_mm3ahx01', value: JSON.stringify({ checked: allowOverCap ? 'true' : 'false' }) },
    ],
  };
}

function gqlStubReturning(items) {
  // loadOverridesBoard's query expects { boards: [{ items_page: { items, cursor } }] }.
  return async () => ({
    boards: [{ items_page: { items, cursor: null } }],
  });
}

// ---------------------------------------------------------------------------
// Fixtures for translateOverrideRows tests
// ---------------------------------------------------------------------------

const PL_JOBS = [
  { id: 'PL-AAA', masterPmId: 'MPM-1', name: 'Job One' },
  { id: 'PL-BBB', masterPmId: 'MPM-2', name: 'Job Two' },
];

const CREW_PARENTS = [
  { parentId: 'CP-IAN-0518', crew: 'Ian',     week: '2026-05-18' },
  { parentId: 'CP-IAN-0525', crew: 'Ian',     week: '2026-05-25' },
  { parentId: 'CP-SPN-0518', crew: 'Spencer', week: '2026-05-18' },
  { parentId: 'CP-SPN-0525', crew: 'Spencer', week: '2026-05-25' },
];

function normRow(overrides = {}) {
  return {
    rowId: '1',
    jobMpmId: 'MPM-1',
    station: 'Benchwork',
    fromCrewParentId: null, fromWeek: null,
    toCrewParentId: null, toWeek: null,
    hours: 8,
    status: 'Pending',
    allowOverCap: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

(async () => {

  console.log('Test 1: loadOverridesBoard — exported and callable');
  {
    check('loadOverridesBoard exported', typeof loadOverridesBoard === 'function', `typeof=${typeof loadOverridesBoard}`);
    if (typeof loadOverridesBoard !== 'function') {
      console.log('  (skipping remaining loadOverridesBoard checks — not exported)');
    } else {
      const items = [
        makeRawItem({ id: 101, jobMpmId: 'MPM-1', toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25', hours: 8 }),
        makeRawItem({ id: 102, groupId: 'group_mm3aqn5a', jobMpmId: 'MPM-2', toCrewParentId: 'CP-SPN-0525', toWeek: '2026-05-25', hours: 4 }),
      ];
      const rows = await loadOverridesBoard({ gqlFn: gqlStubReturning(items) });
      check('returns an array', Array.isArray(rows), `typeof=${typeof rows}`);
      check('filters Stale group out', rows.length === 1, `got ${rows.length}: ${JSON.stringify(rows.map(r => r.rowId))}`);
      const r = rows[0] || {};
      check('row.rowId is set from monday item id', r.rowId === '101', `got ${r.rowId}`);
      check('row.jobMpmId resolved from BoardRelationValue', r.jobMpmId === 'MPM-1', `got ${r.jobMpmId}`);
      check('row.station carries dropdown text', r.station === 'Benchwork', `got ${r.station}`);
      check('row.toCrewParentId resolved', r.toCrewParentId === 'CP-IAN-0525', `got ${r.toCrewParentId}`);
      check('row.toWeek resolved', r.toWeek === '2026-05-25', `got ${r.toWeek}`);
      check('row.fromCrewParentId null when unset', r.fromCrewParentId === null, `got ${r.fromCrewParentId}`);
      check('row.hours parsed as number', r.hours === 8, `got ${r.hours} (typeof=${typeof r.hours})`);
      check('row.status carries label', r.status === 'Pending', `got ${r.status}`);
      check('row.allowOverCap is boolean', typeof r.allowOverCap === 'boolean', `got ${typeof r.allowOverCap}`);
    }
  }

  console.log('\nTest 2: translateOverrideRows — pure assign emits forceAssignment for to-side');
  {
    check('translateOverrideRows exported', typeof translateOverrideRows === 'function', `typeof=${typeof translateOverrideRows}`);
    if (typeof translateOverrideRows !== 'function') {
      console.log('  (skipping remaining translateOverrideRows checks — not exported)');
    } else {
      const row = normRow({
        rowId: '201',
        jobMpmId: 'MPM-1', station: 'Benchwork',
        toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25',
        hours: 8,
      });
      const out = translateOverrideRows([row], PL_JOBS, CREW_PARENTS);
      check('forceAssignments has 1 entry', out.forceAssignments.length === 1, `got ${out.forceAssignments.length}`);
      check('crewExclusions empty', out.crewExclusions.length === 0, `got ${out.crewExclusions.length}`);
      check('untranslatable empty', out.untranslatable.length === 0, `got ${out.untranslatable.length}`);
      const f = out.forceAssignments[0] || {};
      check('force.crew = Ian',           f.crew === 'Ian',                JSON.stringify(f));
      check('force.jobId = PL-AAA',       f.jobId === 'PL-AAA',            JSON.stringify(f));
      check('force.stations = [Benchwork]', Array.isArray(f.stations) && f.stations.length === 1 && f.stations[0] === 'Benchwork', JSON.stringify(f.stations));
      check('force.week = 2026-05-25',    f.week === '2026-05-25',         JSON.stringify(f));
      check('force.hours = 8',            f.hours === 8,                   JSON.stringify(f));
      check('force._sourceRowId stamped', f._sourceRowId === '201',        JSON.stringify(f));
    }
  }

  console.log('\nTest 3: translateOverrideRows — pure clear emits crewExclusion for from-side');
  if (typeof translateOverrideRows !== 'function') {
    console.log('  (skipping — translateOverrideRows not exported)');
  } else {
    const row = normRow({
      rowId: '301',
      jobMpmId: 'MPM-2', station: 'Engineering',
      fromCrewParentId: 'CP-SPN-0518', fromWeek: '2026-05-18',
      hours: 4,
    });
    const out = translateOverrideRows([row], PL_JOBS, CREW_PARENTS);
    check('forceAssignments empty', out.forceAssignments.length === 0, `got ${out.forceAssignments.length}`);
    check('crewExclusions has 1 entry', out.crewExclusions.length === 1, `got ${out.crewExclusions.length}`);
    const x = out.crewExclusions[0] || {};
    check('exclusion.crew = Spencer', x.crew === 'Spencer', JSON.stringify(x));
    check('exclusion.jobId = PL-BBB', x.jobId === 'PL-BBB', JSON.stringify(x));
    check('exclusion.station = Engineering', x.station === 'Engineering', JSON.stringify(x));
    check('exclusion.week = 2026-05-18', x.week === '2026-05-18', JSON.stringify(x));
    check('exclusion._sourceRowId stamped', x._sourceRowId === '301', JSON.stringify(x));
  }

  console.log('\nTest 4: translateOverrideRows — move emits forceAssignment for to-side, no exclusion');
  if (typeof translateOverrideRows !== 'function') {
    console.log('  (skipping — translateOverrideRows not exported)');
  } else {
    const row = normRow({
      rowId: '401',
      jobMpmId: 'MPM-1', station: 'Post Fin Cab Assembly',
      fromCrewParentId: 'CP-IAN-0518', fromWeek: '2026-05-18',
      toCrewParentId: 'CP-SPN-0525', toWeek: '2026-05-25',
      hours: 12,
    });
    const out = translateOverrideRows([row], PL_JOBS, CREW_PARENTS);
    check('forceAssignments has 1 entry', out.forceAssignments.length === 1, `got ${out.forceAssignments.length}`);
    check('crewExclusions empty (move is to-side commit only)', out.crewExclusions.length === 0, `got ${out.crewExclusions.length}`);
    const f = out.forceAssignments[0] || {};
    check('force.crew = Spencer (to-side)', f.crew === 'Spencer', JSON.stringify(f));
    check('force.week = 2026-05-25 (to-side)', f.week === '2026-05-25', JSON.stringify(f));
    check('force.hours = 12', f.hours === 12, JSON.stringify(f));
  }

  console.log('\nTest 5: translateOverrideRows — unresolved Job → untranslatable, no emission');
  if (typeof translateOverrideRows !== 'function') {
    console.log('  (skipping — translateOverrideRows not exported)');
  } else {
    const row = normRow({
      rowId: '501',
      jobMpmId: 'MPM-NONEXISTENT', station: 'Benchwork',
      toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25',
      hours: 8,
    });
    const out = translateOverrideRows([row], PL_JOBS, CREW_PARENTS);
    check('forceAssignments empty', out.forceAssignments.length === 0, `got ${out.forceAssignments.length}`);
    check('crewExclusions empty', out.crewExclusions.length === 0, `got ${out.crewExclusions.length}`);
    check('untranslatable has 1 entry', out.untranslatable.length === 1, `got ${out.untranslatable.length}`);
    check('untranslatable references the row', out.untranslatable[0]?.rowId === '501', JSON.stringify(out.untranslatable[0]));
    check('untranslatable reason mentions job', /job/i.test(out.untranslatable[0]?.reason || ''), out.untranslatable[0]?.reason);
  }

  console.log('\nTest 6: translateOverrideRows — unresolved Crew parent → untranslatable, no emission');
  if (typeof translateOverrideRows !== 'function') {
    console.log('  (skipping — translateOverrideRows not exported)');
  } else {
    const row = normRow({
      rowId: '601',
      jobMpmId: 'MPM-1', station: 'Benchwork',
      toCrewParentId: 'CP-GHOST', toWeek: '2026-05-25',
      hours: 8,
    });
    const out = translateOverrideRows([row], PL_JOBS, CREW_PARENTS);
    check('forceAssignments empty', out.forceAssignments.length === 0, `got ${out.forceAssignments.length}`);
    check('untranslatable has 1 entry', out.untranslatable.length === 1, `got ${out.untranslatable.length}`);
    check('untranslatable reason mentions crew/parent', /crew|parent/i.test(out.untranslatable[0]?.reason || ''), out.untranslatable[0]?.reason);
  }

  console.log('\nTest 7: translateOverrideRows — Conflict and Cleared status skipped silently (post Phase 1.1)');
  // Phase 1.1: Applied no longer skipped; only Conflict + Cleared skip. This
  // closes the Day-2 persistence gap (spec Section B Step 3: "Translate each
  // Applied row into an internal forceAssignment"). See Test 7b below for
  // Applied translation coverage.
  if (typeof translateOverrideRows !== 'function') {
    console.log('  (skipping — translateOverrideRows not exported)');
  } else {
    const rows = [
      normRow({ rowId: '702', status: 'Conflict', jobMpmId: 'MPM-1', toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25', hours: 8 }),
      normRow({ rowId: '703', status: 'Cleared',  jobMpmId: 'MPM-1', toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25', hours: 8 }),
    ];
    const out = translateOverrideRows(rows, PL_JOBS, CREW_PARENTS);
    check('forceAssignments empty (Conflict + Cleared skipped)', out.forceAssignments.length === 0, `got ${out.forceAssignments.length}`);
    check('crewExclusions empty', out.crewExclusions.length === 0, `got ${out.crewExclusions.length}`);
    check('untranslatable empty (silent skip, not a failure)', out.untranslatable.length === 0, `got ${out.untranslatable.length}`);
  }

  console.log('\nTest 7b: translateOverrideRows — Applied row translates same as Pending (Phase 1.1 persistence fix)');
  // Spec Section B Step 3 calls for translating Applied rows. Pre-1.1 this
  // dropped silently — Day 2's --plan run lost the deployed override's
  // effect, so the next --execute would un-apply work that was on the board.
  // 1.1 fix: Applied rows translate exactly like Pending. Both shape variants
  // (pure assign + move) covered to confirm the filter change doesn't perturb
  // the branch logic.
  if (typeof translateOverrideRows !== 'function') {
    console.log('  (skipping — translateOverrideRows not exported)');
  } else {
    const rows = [
      // Pure assign, status=Applied
      normRow({ rowId: '7b1', status: 'Applied', jobMpmId: 'MPM-1', station: 'Benchwork',
               toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25', hours: 8 }),
      // Move, status=Applied
      normRow({ rowId: '7b2', status: 'Applied', jobMpmId: 'MPM-1', station: 'Benchwork',
               fromCrewParentId: 'CP-IAN-0518', fromWeek: '2026-05-18',
               toCrewParentId:   'CP-SPN-0525', toWeek:   '2026-05-25', hours: 4 }),
      // Pure clear, status=Applied
      normRow({ rowId: '7b3', status: 'Applied', jobMpmId: 'MPM-1', station: 'Benchwork',
               fromCrewParentId: 'CP-IAN-0518', fromWeek: '2026-05-18',
               hours: 4 }),
    ];
    const out = translateOverrideRows(rows, PL_JOBS, CREW_PARENTS);
    check('two forceAssignments emitted (pure assign + move)',
      out.forceAssignments.length === 2,
      JSON.stringify(out.forceAssignments.map(f => f._sourceRowId)));
    check('one crewExclusion emitted (pure clear)',
      out.crewExclusions.length === 1,
      JSON.stringify(out.crewExclusions.map(e => e._sourceRowId)));
    check('untranslatable empty', out.untranslatable.length === 0, `got ${out.untranslatable.length}`);
    check('source row ids surface in emitted entries',
      out.forceAssignments.some(f => f._sourceRowId === '7b1')
      && out.forceAssignments.some(f => f._sourceRowId === '7b2')
      && out.crewExclusions[0]?._sourceRowId === '7b3',
      JSON.stringify({
        forces:     out.forceAssignments.map(f => f._sourceRowId),
        exclusions: out.crewExclusions.map(e => e._sourceRowId),
      }));
  }

  console.log('\nTest 8: mergeForceAssignments — disjoint sets concatenate, no conflicts');
  {
    check('mergeForceAssignments exported', typeof mergeForceAssignments === 'function', `typeof=${typeof mergeForceAssignments}`);
    if (typeof mergeForceAssignments !== 'function') {
      console.log('  (skipping remaining mergeForceAssignments checks — not exported)');
    } else {
      const json = [{ crew: 'Ian', jobId: 'X1', stations: ['Benchwork'], week: '2026-05-04', hours: 8 }];
      const board = [{ crew: 'Spencer', jobId: 'X2', stations: ['Engineering'], week: '2026-05-11', hours: 4, _sourceRowId: 'A' }];
      const { merged, conflicts } = mergeForceAssignments(json, board);
      check('merged has 2 entries', merged.length === 2, JSON.stringify(merged));
      check('conflicts empty', conflicts.length === 0, JSON.stringify(conflicts));
    }
  }

  console.log('\nTest 9: mergeForceAssignments — same (jobId,station,week,crew) tuple → board wins, conflict logged');
  if (typeof mergeForceAssignments !== 'function') {
    console.log('  (skipping — mergeForceAssignments not exported)');
  } else {
    const json  = [{ crew: 'Ian', jobId: 'X1', stations: ['Benchwork'], week: '2026-05-04', hours: 8, reason: 'JSON wants 8h' }];
    const board = [{ crew: 'Ian', jobId: 'X1', stations: ['Benchwork'], week: '2026-05-04', hours: 12, reason: 'Board wants 12h', _sourceRowId: 'A' }];
    const { merged, conflicts } = mergeForceAssignments(json, board);
    check('merged has exactly 1 entry (JSON dropped)', merged.length === 1, JSON.stringify(merged));
    check('the survivor is the board entry (12h)', merged[0]?.hours === 12, JSON.stringify(merged[0]));
    check('the survivor has _sourceRowId from board', merged[0]?._sourceRowId === 'A', JSON.stringify(merged[0]));
    check('conflicts has 1 entry', conflicts.length === 1, JSON.stringify(conflicts));
    check('conflict surfaces JSON + board hours', conflicts[0]?.jsonSource?.hours === 8 && conflicts[0]?.boardSource?.hours === 12, JSON.stringify(conflicts[0]));
  }

  console.log('\nTest 10: mergeForceAssignments — JSON entry with multi-station array flattens for tuple match');
  if (typeof mergeForceAssignments !== 'function') {
    console.log('  (skipping — mergeForceAssignments not exported)');
  } else {
    // JSON entry covers (Chris, JobX, [Pack & Ship, Delivery], 2026-04-27). Board entry
    // overrides only the Delivery tuple. Expected: merged retains Pack & Ship from JSON,
    // Delivery flips to board. Two surviving entries; one conflict for Delivery.
    const json  = [{ crew: 'Chris', jobId: 'X1', stations: ['Pack & Ship', 'Delivery'], week: '2026-04-27', reason: 'JSON multi' }];
    const board = [{ crew: 'Chris', jobId: 'X1', stations: ['Delivery'],                week: '2026-04-27', hours: 2, _sourceRowId: 'A' }];
    const { merged, conflicts } = mergeForceAssignments(json, board);
    check('merged has 2 entries (P&S survives, Delivery from board)', merged.length === 2, JSON.stringify(merged));
    const stations = merged.map(m => m.stations[0]).sort();
    check('merged stations are [Delivery, Pack & Ship]', stations[0] === 'Delivery' && stations[1] === 'Pack & Ship', JSON.stringify(stations));
    check('conflicts has 1 entry (only Delivery)', conflicts.length === 1, JSON.stringify(conflicts));
  }

  console.log('\nTest 11: mergeCrewExclusions — JSON coarse + board fine carries through; redundant overlap flagged');
  {
    check('mergeCrewExclusions exported', typeof mergeCrewExclusions === 'function', `typeof=${typeof mergeCrewExclusions}`);
    if (typeof mergeCrewExclusions !== 'function') {
      console.log('  (skipping remaining mergeCrewExclusions checks — not exported)');
    } else {
      // Case A: no overlap
      const a = mergeCrewExclusions(
        { Paisios: { excludeJobs: ['Y1'], reason: 'JSON coarse' } },
        [{ crew: 'Ian', jobId: 'Y2', station: 'Engineering', week: '2026-05-04', reason: 'Board fine', _sourceRowId: 'B' }]
      );
      check('A: merged.json keys unchanged', Object.keys(a.merged?.json || {}).includes('Paisios'), JSON.stringify(a.merged?.json));
      check('A: merged.board has 1 entry', a.merged?.board?.length === 1, JSON.stringify(a.merged?.board));
      check('A: no conflicts', a.conflicts.length === 0, JSON.stringify(a.conflicts));

      // Case B: board exclusion redundantly targets (crew, jobId) already in JSON.excludeJobs
      const b = mergeCrewExclusions(
        { Paisios: { excludeJobs: ['Y1'], reason: 'JSON coarse' } },
        [{ crew: 'Paisios', jobId: 'Y1', station: 'Benchwork', week: '2026-05-11', reason: 'Board fine', _sourceRowId: 'C' }]
      );
      check('B: merged retains board entry', b.merged?.board?.length === 1, JSON.stringify(b.merged?.board));
      check('B: conflict flagged', b.conflicts.length === 1, JSON.stringify(b.conflicts));
      check('B: conflict identifies (crew, jobId)', b.conflicts[0]?.crew === 'Paisios' && b.conflicts[0]?.jobId === 'Y1', JSON.stringify(b.conflicts[0]));
    }
  }

  // -------------------------------------------------------------------------
  // Test 12 — B5c gap closure: a pure-clear board row's fine-grained exclusion
  // must actually prevent the planner from routing (job × station × week) to
  // the excluded crew. Pre-B5c, mergeCrewExclusions computed a board[]
  // exclusion list but jobExclusionViolation didn't consult it, so the
  // exclusion was effectively a no-op for auto-routing. Post-B5c, the
  // module-scope `activeCrewExclusions` set is consulted on every routing
  // decision (matching the activeForceAssignments pattern from B4).
  //
  // Approach: run runPlan TWICE on near-identical synthetic boards — first
  // with no override rows (baseline), then with a pure-clear row targeting
  // the baseline's eng-week placement. Assert the excluded crew loses the
  // placement on the second run.
  //
  // Uses real runPlan (no I/O — every loader is bypassed by passing pre-built
  // boards directly). MONDAY_API_TOKEN not required.
  // -------------------------------------------------------------------------
  console.log('\nTest 12: pure-clear board row affects placement (B5c gap closure)');
  {
    const CREWS = ['Chris', 'Jonathan', 'Paisios', 'Rob', 'Ian', 'Spencer', 'Ken', 'Bob'];
    const BOB_START = '2026-05-18';
    function buildParents() {
      const today = new Date();
      const firstMonday = toISO(getMondayOfWeek(today));
      const parents = [];
      let id = 9000;
      for (let i = 0; i < 24; i++) {
        const wk = toISO(getMondayOfWeek(addDays(new Date(firstMonday + 'T00:00:00Z'), i * 7)));
        for (const crew of CREWS) {
          if (crew === 'Bob' && wk < BOB_START) continue;
          parents.push({ parentId: String(id++), week: wk, crew, base: 40, timeOff: 0, nonProd: 0 });
        }
      }
      return parents;
    }
    // Engineering-only Frameless job, 8 weeks out. Frameless Engineering primary
    // = ['Chris']; secondary = ['Paisios', 'Jonathan', 'Rob']. With Chris excluded
    // for (this job × Engineering × eng-week), Paisios picks up.
    const today = new Date();
    const deliveryWeek = toISO(getMondayOfWeek(addDays(today, 8 * 7)));
    const SYNTHETIC_JOB = {
      id: 'TEST-PL-1',
      name: 'B5c synthetic eng-only job',
      status: 'Not Started',
      subtype: 'Res - Frameless',
      delivery: deliveryWeek,
      masterPmId: 'TEST-MPM-1',
      hours: { eng: 8, panel: 0, bench: 0, prefin: 0, postfin: 0 },
      formulaHours: { eng: 8, panel: 0, bench: 0, prefin: 0, postfin: 0 },
      finishingDays: 0,
      pLam: true, // skip finish-cycle gate
      notes: '',
      customWindow: null,
      parallelPostFin: false,
      overrideNote: null,
    };

    // Silence runPlan's console.log noise during the two passes.
    const realLog = console.log;
    const realErr = console.error;
    const baselineBoards = {
      jobs: [SYNTHETIC_JOB],
      crewParents: buildParents(),
      timeOff: [],
      existingSubs: [],
      overrideRows: [],
    };
    console.log = () => {}; console.error = () => {};
    let baselineReport;
    try { baselineReport = await runPlan(baselineBoards, { savePath: null }); }
    finally { console.log = realLog; console.error = realErr; }

    const engPlacementsBaseline = (baselineReport.placements || []).filter(
      p => p.jobId === 'TEST-PL-1' && p.station === 'Engineering'
    );
    check('baseline produced exactly 1 engineering placement', engPlacementsBaseline.length === 1, JSON.stringify(engPlacementsBaseline));
    check('baseline engineering placement is on Chris (primary)', engPlacementsBaseline[0]?.crew === 'Chris', JSON.stringify(engPlacementsBaseline[0]));

    const engWeek = engPlacementsBaseline[0]?.week;
    const chrisParentForEngWeek = baselineBoards.crewParents.find(p => p.crew === 'Chris' && p.week === engWeek);
    check('found Chris parent row for the eng-week', !!chrisParentForEngWeek, `engWeek=${engWeek}`);

    // Now: same boards + ONE pure-clear override row excluding Chris from
    // (this job × Engineering × eng-week). Post-B5c, Chris is filtered out
    // of the candidate list; Paisios (next secondary) takes the placement.
    const excludedBoards = {
      ...baselineBoards,
      overrideRows: [{
        rowId: 'PC-1',
        jobMpmId: 'TEST-MPM-1',
        station: 'Engineering',
        fromCrewParentId: chrisParentForEngWeek?.parentId,
        fromWeek: engWeek,
        toCrewParentId: null,
        toWeek: null,
        hours: 8,
        status: 'Pending',
        allowOverCap: false,
      }],
    };
    console.log = () => {}; console.error = () => {};
    let excludedReport;
    try { excludedReport = await runPlan(excludedBoards, { savePath: null }); }
    finally { console.log = realLog; console.error = realErr; }

    const engPlacementsExcluded = (excludedReport.placements || []).filter(
      p => p.jobId === 'TEST-PL-1' && p.station === 'Engineering'
    );
    check('exclusion run produced exactly 1 engineering placement', engPlacementsExcluded.length === 1, JSON.stringify(engPlacementsExcluded));
    check('exclusion run: NO engineering placement on Chris for the eng-week',
      !engPlacementsExcluded.some(p => p.crew === 'Chris' && p.week === engWeek),
      JSON.stringify(engPlacementsExcluded));
    check('exclusion run: a non-Chris secondary picked up the placement',
      ['Paisios', 'Jonathan', 'Rob'].includes(engPlacementsExcluded[0]?.crew),
      `got ${engPlacementsExcluded[0]?.crew || '(none)'} from ${JSON.stringify(engPlacementsExcluded[0])}`);
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All B4 read-pipeline tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
