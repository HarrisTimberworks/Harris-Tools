#!/usr/bin/env node
/**
 * B5 — Manual Overrides validation pipeline (pure functions).
 *
 * Tests three per-row check functions + the validateAll orchestrator:
 *   - checkDeliveryDateConstraint(row, plJobs) → { valid, reason }
 *       Strict. Spec literal says "Master PM customWindow check" but per the
 *       Phase 1 plan Section D.3, customWindow lives in JSON not on Master PM
 *       — Master PM carries the delivery date. So the check is delivery-date
 *       strict: pin week (toWeek, or fromWeek when toCrew is empty) must be
 *       ≤ the job's delivery week.
 *   - checkConsistency(row, baselinePlan) → { valid, reason }
 *       Strict. If row has a From side, baselinePlan.placements must contain
 *       ≥ row.hours allocated to (masterPmId × station × fromCrew × fromWeek).
 *       Pure assigns skip.
 *   - checkCapacity(row, baselinePlan, allowOverCap) → { valid, reason, softWarning? }
 *       Lenient with checkbox. If wouldBe > cap AND !allowOverCap → invalid.
 *       If wouldBe > cap AND allowOverCap → valid + softWarning. Pure clears skip.
 *   - validateAll(rawRows, baselinePlan, plJobs, crewParents) → { accepted, conflicts }
 *       Resolves each raw row's jobMpmId / fromCrewParentId / toCrewParentId
 *       once, runs the three checks, and partitions the rows.
 *
 * "Resolved row" shape consumed by the per-check functions:
 *   {
 *     rowId, jobMpmId, jobId, station, hours, status, allowOverCap,
 *     fromCrew, fromWeek,    // null when pure assign
 *     toCrew,   toWeek,      // null when pure clear
 *   }
 *
 * All tests run synchronously with synthetic baselinePlans + plJobs — no
 * monday I/O and no MONDAY_API_TOKEN.
 */

const {
  checkDeliveryDateConstraint,
  checkConsistency,
  checkCapacity,
  validateAll,
} = require('./validate-overrides.js');

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

const PL_JOBS = [
  { id: 'PL-A', masterPmId: 'MPM-A', name: 'Job A', delivery: '2026-06-12' },
  { id: 'PL-B', masterPmId: 'MPM-B', name: 'Job B', delivery: '2026-05-29' },
  { id: 'PL-C', masterPmId: 'MPM-C', name: 'Job C', delivery: null }, // missing delivery
];

const CREW_PARENTS = [
  { parentId: 'CP-IAN-0518',     crew: 'Ian',     week: '2026-05-18' },
  { parentId: 'CP-IAN-0525',     crew: 'Ian',     week: '2026-05-25' },
  { parentId: 'CP-SPN-0518',     crew: 'Spencer', week: '2026-05-18' },
  { parentId: 'CP-SPN-0525',     crew: 'Spencer', week: '2026-05-25' },
  { parentId: 'CP-JON-0608',     crew: 'Jonathan', week: '2026-06-08' },
];

function resolvedRow(overrides = {}) {
  return {
    rowId: 'R1',
    jobMpmId: 'MPM-A',
    jobId: 'PL-A',
    station: 'Benchwork',
    hours: 8,
    status: 'Pending',
    allowOverCap: false,
    fromCrew: null, fromWeek: null,
    toCrew: 'Ian',  toWeek: '2026-05-25',
    ...overrides,
  };
}

function rawRow(overrides = {}) {
  return {
    rowId: 'R1',
    jobMpmId: 'MPM-A',
    station: 'Benchwork',
    fromCrewParentId: null, fromWeek: null,
    toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25',
    hours: 8,
    status: 'Pending',
    allowOverCap: false,
    ...overrides,
  };
}

// Synthetic baselinePlan with one allocated bucket for consistency tests and
// committed/avail values shaped for the capacity tests.
function syntheticBaselinePlan() {
  return {
    mode: 'plan',
    placements: [
      // 12h Ian Benchwork on Job A in 5/18 — what a consistency move would key off.
      { crew: 'Ian',     week: '2026-05-18', hours: 12, station: 'Benchwork',
        jobId: 'PL-A',  jobName: 'Job A', masterPmId: 'MPM-A', parentId: 'P-A1' },
      // 6h Spencer Engineering on Job B in 5/18.
      { crew: 'Spencer', week: '2026-05-18', hours: 6,  station: 'Engineering',
        jobId: 'PL-B',  jobName: 'Job B', masterPmId: 'MPM-B', parentId: 'P-B1' },
      // 3h Ian Benchwork on Job A in 5/18 split — sums to 15h with the first row.
      { crew: 'Ian',     week: '2026-05-18', hours: 3,  station: 'Benchwork',
        jobId: 'PL-A',  jobName: 'Job A', masterPmId: 'MPM-A', parentId: 'P-A2' },
    ],
    capacityGrid: {
      Ian: {
        '2026-05-18': { avail: 40, committed: 15, timeOff: 0, over: 0, assignments: [] },
        '2026-05-25': { avail: 40, committed: 30, timeOff: 0, over: 0, assignments: [] },
      },
      Spencer: {
        '2026-05-18': { avail: 40, committed: 6,  timeOff: 0, over: 0, assignments: [] },
        '2026-05-25': { avail: 40, committed: 38, timeOff: 0, over: 0, assignments: [] },
      },
      Jonathan: {
        '2026-06-08': { avail: 40, committed: 0,  timeOff: 0, over: 0, assignments: [] },
      },
    },
    warnings: [],
  };
}

// ---------------------------------------------------------------------------

(async () => {

  // ==========================================================================
  // checkDeliveryDateConstraint
  // ==========================================================================

  console.log('Test 1: checkDeliveryDateConstraint — valid (toWeek before delivery)');
  {
    // Job A delivers 2026-06-12. toWeek 2026-05-25 is well before → valid.
    const r = resolvedRow({ jobMpmId: 'MPM-A', toWeek: '2026-05-25' });
    const out = checkDeliveryDateConstraint(r, PL_JOBS);
    check('valid', out.valid === true, JSON.stringify(out));
    check('reason null', out.reason === null, JSON.stringify(out));
  }

  console.log('\nTest 2: checkDeliveryDateConstraint — invalid (toWeek past delivery)');
  {
    // Job B delivers 2026-05-29 (a Friday). toWeek 2026-06-08 is past → invalid.
    const r = resolvedRow({ jobMpmId: 'MPM-B', jobId: 'PL-B', toCrew: 'Jonathan', toWeek: '2026-06-08' });
    const out = checkDeliveryDateConstraint(r, PL_JOBS);
    check('invalid', out.valid === false, JSON.stringify(out));
    check('reason mentions delivery date', /deliver/i.test(out.reason || ''), out.reason || '(no reason)');
  }

  console.log('\nTest 3: checkDeliveryDateConstraint — edge (toWeek = delivery week)');
  {
    // Job B delivers 2026-05-29 (Friday). Week-of for that delivery is 2026-05-25
    // (Monday-of). A pin in that same week is valid (the delivery is at the END
    // of that week — work done earlier in the week is operationally fine).
    const r = resolvedRow({ jobMpmId: 'MPM-B', jobId: 'PL-B', toCrew: 'Spencer', toWeek: '2026-05-25' });
    const out = checkDeliveryDateConstraint(r, PL_JOBS);
    check('valid (same week as delivery)', out.valid === true, JSON.stringify(out));
  }

  console.log('\nTest 4: checkDeliveryDateConstraint — missing delivery date is non-blocking');
  {
    // Job C has delivery: null. With no delivery to compare against, the check
    // cannot reject — silently pass. (B7 smoke catches missing-delivery jobs by
    // other means; we don't want this lone validator to block on it.)
    const r = resolvedRow({ jobMpmId: 'MPM-C', jobId: 'PL-C', toWeek: '2026-05-25' });
    const out = checkDeliveryDateConstraint(r, PL_JOBS);
    check('valid', out.valid === true, JSON.stringify(out));
  }

  console.log('\nTest 5: checkDeliveryDateConstraint — pure clear (no toCrew) uses fromWeek');
  {
    // Pure clear has empty To. The pinning week the check examines is fromWeek.
    // Job B delivers 2026-05-29; fromWeek 2026-06-08 is past → invalid.
    const r = resolvedRow({
      jobMpmId: 'MPM-B', jobId: 'PL-B',
      fromCrew: 'Jonathan', fromWeek: '2026-06-08',
      toCrew: null, toWeek: null,
    });
    const out = checkDeliveryDateConstraint(r, PL_JOBS);
    check('invalid (fromWeek past delivery)', out.valid === false, JSON.stringify(out));
  }

  // ==========================================================================
  // checkConsistency
  // ==========================================================================

  console.log('\nTest 6: checkConsistency — valid (baseline has enough)');
  {
    // Baseline has 12+3=15h Ian/Benchwork/Job-A/5-18. Asking to move 10h from
    // that bucket is fine.
    const r = resolvedRow({
      jobMpmId: 'MPM-A', jobId: 'PL-A', station: 'Benchwork',
      fromCrew: 'Ian', fromWeek: '2026-05-18',
      toCrew: 'Spencer', toWeek: '2026-05-25',
      hours: 10,
    });
    const out = checkConsistency(r, syntheticBaselinePlan());
    check('valid', out.valid === true, JSON.stringify(out));
  }

  console.log('\nTest 7: checkConsistency — invalid (baseline has too few)');
  {
    // Baseline has only 15h Ian/Benchwork/Job-A/5-18. Asking to move 20h → invalid.
    const r = resolvedRow({
      jobMpmId: 'MPM-A', jobId: 'PL-A', station: 'Benchwork',
      fromCrew: 'Ian', fromWeek: '2026-05-18',
      toCrew: 'Spencer', toWeek: '2026-05-25',
      hours: 20,
    });
    const out = checkConsistency(r, syntheticBaselinePlan());
    check('invalid', out.valid === false, JSON.stringify(out));
    check('reason mentions hours / baseline', /hours|baseline|allocat/i.test(out.reason || ''), out.reason);
  }

  console.log('\nTest 8: checkConsistency — invalid (baseline has zero matching placements)');
  {
    // Asking to move 4h Ian/Engineering/Job-A — baseline has Ian/Benchwork only.
    const r = resolvedRow({
      jobMpmId: 'MPM-A', jobId: 'PL-A', station: 'Engineering',
      fromCrew: 'Ian', fromWeek: '2026-05-18',
      toCrew: 'Spencer', toWeek: '2026-05-25',
      hours: 4,
    });
    const out = checkConsistency(r, syntheticBaselinePlan());
    check('invalid', out.valid === false, JSON.stringify(out));
  }

  console.log('\nTest 9: checkConsistency — pure assign skips (no From side)');
  {
    // Empty From. Consistency check is N/A.
    const r = resolvedRow({
      jobMpmId: 'MPM-A', jobId: 'PL-A', station: 'Benchwork',
      fromCrew: null, fromWeek: null,
      toCrew: 'Spencer', toWeek: '2026-05-25',
      hours: 200, // absurd, doesn't matter
    });
    const out = checkConsistency(r, syntheticBaselinePlan());
    check('valid (skip)', out.valid === true, JSON.stringify(out));
    check('reason null', out.reason === null, JSON.stringify(out));
  }

  console.log('\nTest 10: checkConsistency — pure clear (no To side) still gets the From check');
  {
    // Empty To, but From side present — operator is saying "remove these hours
    // from the baseline." If the hours aren't there to remove, it's a conflict.
    const r = resolvedRow({
      jobMpmId: 'MPM-A', jobId: 'PL-A', station: 'Benchwork',
      fromCrew: 'Spencer', fromWeek: '2026-05-25', // baseline has 0 here for Job A
      toCrew: null, toWeek: null,
      hours: 4,
    });
    const out = checkConsistency(r, syntheticBaselinePlan());
    check('invalid (pure clear with no baseline hours)', out.valid === false, JSON.stringify(out));
  }

  // ==========================================================================
  // checkCapacity
  // ==========================================================================

  console.log('\nTest 11: checkCapacity — under cap');
  {
    // Ian/5-25 has committed=30, avail=40. Adding 8h → 38h. Under → valid.
    const r = resolvedRow({ toCrew: 'Ian', toWeek: '2026-05-25', hours: 8 });
    const out = checkCapacity(r, syntheticBaselinePlan(), false);
    check('valid', out.valid === true, JSON.stringify(out));
    check('no softWarning', !out.softWarning, JSON.stringify(out));
  }

  console.log('\nTest 12: checkCapacity — at cap (boundary: wouldBe === avail)');
  {
    // Ian/5-25 committed=30, avail=40. Adding 10h → 40h. wouldBe === cap → valid
    // (cap is not exceeded; only strict > triggers).
    const r = resolvedRow({ toCrew: 'Ian', toWeek: '2026-05-25', hours: 10 });
    const out = checkCapacity(r, syntheticBaselinePlan(), false);
    check('valid (at cap, not over)', out.valid === true, JSON.stringify(out));
  }

  console.log('\nTest 13: checkCapacity — over cap WITHOUT allowOverCap → invalid');
  {
    // Spencer/5-25 committed=38, avail=40. Adding 10h → 48h. wouldBe > cap →
    // invalid unless allowOverCap.
    const r = resolvedRow({ toCrew: 'Spencer', toWeek: '2026-05-25', hours: 10, allowOverCap: false });
    const out = checkCapacity(r, syntheticBaselinePlan(), false);
    check('invalid', out.valid === false, JSON.stringify(out));
    check('reason mentions cap / over', /cap|over/i.test(out.reason || ''), out.reason);
  }

  console.log('\nTest 14: checkCapacity — over cap WITH allowOverCap → valid + softWarning');
  {
    const r = resolvedRow({ toCrew: 'Spencer', toWeek: '2026-05-25', hours: 10, allowOverCap: true });
    const out = checkCapacity(r, syntheticBaselinePlan(), true);
    check('valid', out.valid === true, JSON.stringify(out));
    check('softWarning string present', typeof out.softWarning === 'string' && out.softWarning.length > 0, JSON.stringify(out));
    check('softWarning mentions over-cap', /over|cap/i.test(out.softWarning || ''), out.softWarning || '');
  }

  console.log('\nTest 15: checkCapacity — pure clear (no toCrew) skips');
  {
    const r = resolvedRow({
      fromCrew: 'Ian', fromWeek: '2026-05-18',
      toCrew: null, toWeek: null,
      hours: 4,
    });
    const out = checkCapacity(r, syntheticBaselinePlan(), false);
    check('valid (skip)', out.valid === true, JSON.stringify(out));
    check('reason null', out.reason === null, JSON.stringify(out));
  }

  // ==========================================================================
  // validateAll
  // ==========================================================================

  console.log('\nTest 16: validateAll — all-pass batch');
  {
    const rows = [
      rawRow({ rowId: '1601', jobMpmId: 'MPM-A',
               toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25', hours: 8 }),
      rawRow({ rowId: '1602', jobMpmId: 'MPM-A',
               fromCrewParentId: 'CP-IAN-0518', fromWeek: '2026-05-18',
               toCrewParentId: 'CP-SPN-0525', toWeek: '2026-05-25', hours: 1 }),
    ];
    const out = validateAll(rows, syntheticBaselinePlan(), PL_JOBS, CREW_PARENTS);
    check('accepted has 2 entries', out.accepted.length === 2, JSON.stringify(out.accepted.map(a => a.rowId)));
    check('conflicts empty', out.conflicts.length === 0, JSON.stringify(out.conflicts));
  }

  console.log('\nTest 17: validateAll — all-fail batch');
  {
    const rows = [
      // Delivery-date fail: Job B 5/29 with toWeek 6/8.
      rawRow({ rowId: '1701', jobMpmId: 'MPM-B',
               toCrewParentId: 'CP-JON-0608', toWeek: '2026-06-08', hours: 4 }),
      // Consistency fail: Job A, asking for 20h Ian/Benchwork/5-18 (baseline has 15h).
      rawRow({ rowId: '1702', jobMpmId: 'MPM-A', station: 'Benchwork',
               fromCrewParentId: 'CP-IAN-0518', fromWeek: '2026-05-18',
               toCrewParentId: 'CP-SPN-0525', toWeek: '2026-05-25', hours: 20 }),
      // Capacity fail: Spencer/5-25 at 38/40, +10h, no allowOverCap.
      rawRow({ rowId: '1703', jobMpmId: 'MPM-A',
               toCrewParentId: 'CP-SPN-0525', toWeek: '2026-05-25', hours: 10 }),
    ];
    const out = validateAll(rows, syntheticBaselinePlan(), PL_JOBS, CREW_PARENTS);
    check('accepted empty', out.accepted.length === 0, JSON.stringify(out.accepted.map(a => a.rowId)));
    check('conflicts has 3 entries', out.conflicts.length === 3, JSON.stringify(out.conflicts.map(c => c.rowId)));
    check('every conflict carries a reason string', out.conflicts.every(c => typeof c.reason === 'string' && c.reason.length > 0), JSON.stringify(out.conflicts));
  }

  console.log('\nTest 18: validateAll — mixed batch (1 pass + 1 fail)');
  {
    const rows = [
      rawRow({ rowId: '1801', jobMpmId: 'MPM-A',
               toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25', hours: 5 }),  // passes
      rawRow({ rowId: '1802', jobMpmId: 'MPM-B',
               toCrewParentId: 'CP-JON-0608', toWeek: '2026-06-08', hours: 5 }),  // delivery-past fail
    ];
    const out = validateAll(rows, syntheticBaselinePlan(), PL_JOBS, CREW_PARENTS);
    check('accepted has 1 (1801)', out.accepted.length === 1 && out.accepted[0].rowId === '1801', JSON.stringify(out.accepted.map(a => a.rowId)));
    check('conflicts has 1 (1802)', out.conflicts.length === 1 && out.conflicts[0].rowId === '1802', JSON.stringify(out.conflicts.map(c => c.rowId)));
  }

  console.log('\nTest 19: validateAll — empty input returns empty buckets');
  {
    const out = validateAll([], syntheticBaselinePlan(), PL_JOBS, CREW_PARENTS);
    check('accepted is []', Array.isArray(out.accepted) && out.accepted.length === 0, JSON.stringify(out));
    check('conflicts is []', Array.isArray(out.conflicts) && out.conflicts.length === 0, JSON.stringify(out));
  }

  console.log('\nTest 20: validateAll — non-Pending rows are ignored (not in accepted, not in conflicts)');
  {
    const rows = [
      rawRow({ rowId: '2001', status: 'Applied',  jobMpmId: 'MPM-A',
               toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25', hours: 8 }),
      rawRow({ rowId: '2002', status: 'Conflict', jobMpmId: 'MPM-A',
               toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25', hours: 8 }),
      rawRow({ rowId: '2003', status: 'Cleared',  jobMpmId: 'MPM-A',
               toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25', hours: 8 }),
      rawRow({ rowId: '2004', status: 'Pending',  jobMpmId: 'MPM-A',
               toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25', hours: 8 }),
    ];
    const out = validateAll(rows, syntheticBaselinePlan(), PL_JOBS, CREW_PARENTS);
    check('only 1 Pending → accepted has 1', out.accepted.length === 1 && out.accepted[0].rowId === '2004', JSON.stringify(out.accepted.map(a => a.rowId)));
    check('no conflicts for non-Pending rows', out.conflicts.length === 0, JSON.stringify(out.conflicts.map(c => c.rowId)));
  }

  console.log('\nTest 21: validateAll — unresolved jobMpmId or crewParentId surfaces as conflict (not crash)');
  {
    const rows = [
      // Unknown MPM → can't resolve job → conflict, not silent drop.
      rawRow({ rowId: '2101', jobMpmId: 'MPM-NONEXISTENT',
               toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25', hours: 8 }),
      // Unknown crew parent → conflict.
      rawRow({ rowId: '2102', jobMpmId: 'MPM-A',
               toCrewParentId: 'CP-GHOST', toWeek: '2026-05-25', hours: 8 }),
    ];
    const out = validateAll(rows, syntheticBaselinePlan(), PL_JOBS, CREW_PARENTS);
    check('accepted empty', out.accepted.length === 0, JSON.stringify(out.accepted));
    check('both unresolved rows in conflicts', out.conflicts.length === 2, JSON.stringify(out.conflicts.map(c => c.rowId)));
    check('reasons mention resolution failure', out.conflicts.every(c => /resolv|unknown|no match|unresolved/i.test(c.reason || '')), JSON.stringify(out.conflicts.map(c => c.reason)));
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All B5 validate-overrides tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
