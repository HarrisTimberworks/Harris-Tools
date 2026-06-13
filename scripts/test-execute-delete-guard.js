#!/usr/bin/env node
/**
 * AUDIT FIX (2026-06-11) — execute delete-guard.
 *
 * The old delete list was `existingSubs where some activeJob.masterPmId ===
 * sub.masterPmId` — two data-loss vectors confirmed by audit:
 *   1. An active job with a null Master-PM link matches every UNLINKED
 *      subitem on the board (null === null) → board-wide deletion queue.
 *   2. An active job that produced ZERO placements this plan (missing
 *      delivery, all windows past) gets its existing subitems deleted with
 *      nothing re-created — the work vanishes from the board.
 *
 * New rule (computeSubitemDeletes): delete a subitem ONLY when its job
 * actually received placements in THIS plan — full-overwrite only where we
 * hold a replacement. Null/missing links never match anything.
 */

const { computeSubitemDeletes, computeCurrentWeekRewriteIds } = require('./rebalance-schedule.js');

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

const SUBS = [
  { id: 's1', masterPmId: 'MPM-A', name: 'Job A — Benchwork' },
  { id: 's2', masterPmId: 'MPM-A', name: 'Job A — PostFin' },
  { id: 's3', masterPmId: 'MPM-B', name: 'Job B — Panel' },        // active, but NOT re-planned
  { id: 's4', masterPmId: null,    name: 'Manual note row' },       // unlinked
  { id: 's5', masterPmId: 'MPM-DONE', name: 'Complete job record' },// inactive job
];

(async () => {

  console.log('Test 1: export exists');
  check('computeSubitemDeletes is a function', typeof computeSubitemDeletes === 'function', typeof computeSubitemDeletes);

  console.log('\nTest 2: subitems of re-planned jobs are deleted (full overwrite where replaced)');
  {
    const placements = [{ masterPmId: 'MPM-A', crew: 'Bob', week: '2026-06-15', hours: 8 }];
    const ids = computeSubitemDeletes(SUBS, placements);
    check('both Job A subitems queued', ids.includes('s1') && ids.includes('s2'), JSON.stringify(ids));
  }

  console.log('\nTest 3: active-but-unplanned job keeps its subitems');
  {
    const placements = [{ masterPmId: 'MPM-A', crew: 'Bob', week: '2026-06-15', hours: 8 }];
    const ids = computeSubitemDeletes(SUBS, placements);
    check('Job B subitem preserved (no placements this plan)', !ids.includes('s3'), JSON.stringify(ids));
  }

  console.log('\nTest 4: null-link subitems are NEVER deleted — even against a null-link placement');
  {
    // Placement with a null masterPmId (broken link on an active job) must
    // not match the unlinked manual row.
    const placements = [
      { masterPmId: null, crew: 'Bob', week: '2026-06-15', hours: 8 },
      { masterPmId: 'MPM-A', crew: 'Bob', week: '2026-06-15', hours: 8 },
    ];
    const ids = computeSubitemDeletes(SUBS, placements);
    check('unlinked s4 preserved', !ids.includes('s4'), JSON.stringify(ids));
  }

  console.log('\nTest 5: inactive/Complete job records preserved (PATCH A semantics unchanged)');
  {
    const placements = [{ masterPmId: 'MPM-A', crew: 'Bob', week: '2026-06-15', hours: 8 }];
    const ids = computeSubitemDeletes(SUBS, placements);
    check('s5 preserved', !ids.includes('s5'), JSON.stringify(ids));
  }

  console.log('\nTest 6: numeric vs string masterPmId coercion');
  {
    const subs = [{ id: 'sx', masterPmId: 12345 }];
    const placements = [{ masterPmId: '12345', crew: 'Bob', week: '2026-06-15', hours: 8 }];
    const ids = computeSubitemDeletes(subs, placements);
    check('type-mismatched ids still match', ids.includes('sx'), JSON.stringify(ids));
  }

  // -------------------------------------------------------------------------
  // Task 7: week-aware computeSubitemDeletes + computeCurrentWeekRewriteIds
  // -------------------------------------------------------------------------

  console.log('\nTest 7: week-aware — past-week subitems never deleted, any job');
  {
    const subs = [
      { id: 'p1', masterPmId: 'MPM-A', parentWeek: '2026-06-01' },
      { id: 'c1', masterPmId: 'MPM-A', parentWeek: '2026-06-08' },
      { id: 'f1', masterPmId: 'MPM-A', parentWeek: '2026-06-15' },
    ];
    const placements = [{ masterPmId: 'MPM-A', week: '2026-06-15', hours: 8 }];
    const opts = {
      effectiveWeek: '2026-06-08',
      currentWeekMonday: '2026-06-08',
      isMidWeek: true,
      rewriteJobIds: new Set(),
    };
    const ids = computeSubitemDeletes(subs, placements, opts);
    check('past p1 protected', !ids.includes('p1'), JSON.stringify(ids));
    check('current c1 preserved (no rewrite row)', !ids.includes('c1'), JSON.stringify(ids));
    check('future f1 deleted', ids.includes('f1'), JSON.stringify(ids));
  }

  console.log('\nTest 8: rewriteJobIds opts current week back into rewrite');
  {
    const subs = [
      { id: 'p1', masterPmId: 'MPM-A', parentWeek: '2026-06-01' },
      { id: 'c1', masterPmId: 'MPM-A', parentWeek: '2026-06-08' },
      { id: 'f1', masterPmId: 'MPM-A', parentWeek: '2026-06-15' },
    ];
    const placements = [{ masterPmId: 'MPM-A', week: '2026-06-15', hours: 8 }];
    const opts = {
      effectiveWeek: '2026-06-08',
      currentWeekMonday: '2026-06-08',
      isMidWeek: true,
      rewriteJobIds: new Set(['MPM-A']),
    };
    const ids = computeSubitemDeletes(subs, placements, opts);
    check('rewrite: c1 deleted (override row opts it in)', ids.includes('c1'), JSON.stringify(ids));
    check('rewrite: p1 still protected (history guard)', !ids.includes('p1'), JSON.stringify(ids));
    check('rewrite: f1 deleted (future >= effectiveWeek)', ids.includes('f1'), JSON.stringify(ids));
  }

  console.log('\nTest 9: weekend context — ending week is history');
  {
    // opts.effectiveWeek '2026-06-15', isMidWeek false → c1 (6/08) protected as past
    const subs = [
      { id: 'c1', masterPmId: 'MPM-A', parentWeek: '2026-06-08' },
      { id: 'f1', masterPmId: 'MPM-A', parentWeek: '2026-06-15' },
    ];
    const placements = [{ masterPmId: 'MPM-A', week: '2026-06-15', hours: 8 }];
    const opts = {
      effectiveWeek: '2026-06-15',
      currentWeekMonday: '2026-06-08',
      isMidWeek: false,
      rewriteJobIds: new Set(),
    };
    const ids = computeSubitemDeletes(subs, placements, opts);
    check('weekend: c1 (6/08) protected as past history', !ids.includes('c1'), JSON.stringify(ids));
    check('weekend: f1 (6/15) deleted (>= effectiveWeek, job replanned)', ids.includes('f1'), JSON.stringify(ids));
  }

  console.log('\nTest 10: missing parentWeek → protected (safety default)');
  {
    const subs = [
      { id: 'nx', masterPmId: 'MPM-A' },           // no parentWeek at all
      { id: 'ny', masterPmId: 'MPM-A', parentWeek: null },  // null parentWeek
    ];
    const placements = [{ masterPmId: 'MPM-A', week: '2026-06-15', hours: 8 }];
    const opts = {
      effectiveWeek: '2026-06-08',
      currentWeekMonday: '2026-06-08',
      isMidWeek: true,
      rewriteJobIds: new Set(),
    };
    const ids = computeSubitemDeletes(subs, placements, opts);
    check('missing parentWeek nx protected', !ids.includes('nx'), JSON.stringify(ids));
    check('null parentWeek ny protected', !ids.includes('ny'), JSON.stringify(ids));
  }

  console.log('\nTest 11: no opts ⇒ legacy behavior (Tests 1–6 shapes unchanged)');
  {
    // Regression guard: two-arg call must behave exactly as before Task 7
    const placements = [{ masterPmId: 'MPM-A', crew: 'Bob', week: '2026-06-15', hours: 8 }];
    const ids = computeSubitemDeletes(SUBS, placements);
    check('legacy: s1 deleted (replanned)', ids.includes('s1'), JSON.stringify(ids));
    check('legacy: s3 preserved (unplanned)', !ids.includes('s3'), JSON.stringify(ids));
    check('legacy: s4 preserved (null link)', !ids.includes('s4'), JSON.stringify(ids));
  }

  console.log('\nTest 12: computeCurrentWeekRewriteIds — override row touching current week');
  {
    check('helper exported', typeof computeCurrentWeekRewriteIds === 'function',
      typeof computeCurrentWeekRewriteIds);
    // Parent rows: parentId '10' = week 6/08, parentId '20' = week 6/15
    const crewParents = [
      { parentId: '10', week: '2026-06-08', crew: 'Bob' },
      { parentId: '20', week: '2026-06-15', crew: 'Bob' },
    ];
    // Override row: Pending, moves job M1 FROM 6/15 TO 6/08 (touches current week)
    const overrideRows = [
      { status: 'Pending', jobMpmId: 'M1', fromCrewParentId: '20', toCrewParentId: '10' },
    ];
    const ids = computeCurrentWeekRewriteIds(overrideRows, crewParents, '2026-06-08');
    check('M1 in rewriteIds (override touches 6/08)', ids.has('M1'), JSON.stringify([...ids]));
  }

  console.log('\nTest 13: computeCurrentWeekRewriteIds — Applied status included');
  {
    const crewParents = [{ parentId: '10', week: '2026-06-08', crew: 'Bob' }];
    const overrideRows = [
      { status: 'Applied', jobMpmId: 'M2', fromCrewParentId: '10', toCrewParentId: null },
    ];
    const ids = computeCurrentWeekRewriteIds(overrideRows, crewParents, '2026-06-08');
    check('M2 included (Applied status)', ids.has('M2'), JSON.stringify([...ids]));
  }

  console.log('\nTest 14: computeCurrentWeekRewriteIds — other statuses excluded');
  {
    const crewParents = [{ parentId: '10', week: '2026-06-08', crew: 'Bob' }];
    const overrideRows = [
      { status: 'Rejected', jobMpmId: 'M3', fromCrewParentId: '10', toCrewParentId: null },
      { status: 'Draft', jobMpmId: 'M4', fromCrewParentId: '10', toCrewParentId: null },
    ];
    const ids = computeCurrentWeekRewriteIds(overrideRows, crewParents, '2026-06-08');
    check('M3 excluded (Rejected)', !ids.has('M3'), JSON.stringify([...ids]));
    check('M4 excluded (Draft)', !ids.has('M4'), JSON.stringify([...ids]));
  }

  console.log('\nTest 15: computeCurrentWeekRewriteIds — override NOT touching current week excluded');
  {
    const crewParents = [
      { parentId: '10', week: '2026-06-08', crew: 'Bob' },
      { parentId: '20', week: '2026-06-15', crew: 'Bob' },
    ];
    // Override only touches 6/15, not 6/08
    const overrideRows = [
      { status: 'Pending', jobMpmId: 'M5', fromCrewParentId: '20', toCrewParentId: null },
    ];
    const ids = computeCurrentWeekRewriteIds(overrideRows, crewParents, '2026-06-08');
    check('M5 excluded (override only on 6/15, not 6/08)', !ids.has('M5'), JSON.stringify([...ids]));
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All execute-delete-guard tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
