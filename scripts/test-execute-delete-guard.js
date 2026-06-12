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

const { computeSubitemDeletes } = require('./rebalance-schedule.js');

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
