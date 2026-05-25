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
  checkFieldUnsupported,
  checkWindowMembership,
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

  console.log('\nTest 20: validateAll — Conflict and Cleared rows skipped; Pending + Applied processed (Phase 1.1 lifecycle)');
  {
    // Phase 1.1: Applied joins Pending as a validated status. Conflict +
    // Cleared still skip — Conflict requires an operator's manual flip back
    // to Pending; Cleared is terminal.
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
    const acceptedIds = out.accepted.map(a => a.rowId).sort();
    check('accepted has [Applied 2001, Pending 2004] — Conflict + Cleared filtered out',
      JSON.stringify(acceptedIds) === JSON.stringify(['2001', '2004']),
      JSON.stringify(acceptedIds));
    check('no conflicts (Conflict + Cleared skip silently, not re-flag)',
      out.conflicts.length === 0,
      JSON.stringify(out.conflicts.map(c => c.rowId)));
  }

  // ==========================================================================
  // checkFieldUnsupported (B7-followup)
  // ==========================================================================
  //
  // B7 smoke matrix surfaced that Field-stationed overrides are silently
  // dropped by the planner — "Field" is not in scripts/rebalance-schedule.js's
  // STATION_ORDER (lines 132–138), so scheduleStation never iterates Field
  // for any job. applyForceAssignments is never called for the (job × Field
  // × week) tuple. The board's dropdown exposes Field; the planner has no
  // execution path.
  //
  // Validator behavior: reject station='Field' explicitly at validation time
  // so the operator gets a Conflict with a clear reason instead of an
  // Applied row with no plan effect.

  console.log('\nTest 22: checkFieldUnsupported — Field station rejected with explanatory reason');
  {
    const r = resolvedRow({ station: 'Field', toCrew: 'Jonathan', toWeek: '2026-06-08' });
    const out = checkFieldUnsupported(r);
    check('invalid', out.valid === false, JSON.stringify(out));
    check('reason mentions Field', /field/i.test(out.reason || ''), out.reason || '(no reason)');
    check('reason mentions no execution path / unsupported / Phase 1',
      /unsupported|execution path|phase 1|no.*path|not.*implement/i.test(out.reason || ''),
      out.reason || '(no reason)');
  }

  console.log('\nTest 23: checkFieldUnsupported — non-Field stations pass');
  {
    for (const station of ['Engineering', 'Panel Processing', 'Benchwork', 'Pre Fin Cab Assembly',
                           'Post Fin Cab Assembly', 'Pack & Ship', 'Delivery']) {
      const r = resolvedRow({ station });
      const out = checkFieldUnsupported(r);
      check(`valid for ${station}`, out.valid === true, JSON.stringify(out));
      check(`reason null for ${station}`, out.reason === null, JSON.stringify(out));
    }
  }

  console.log('\nTest 24: checkFieldUnsupported — Field rejected even on pure clear (no execution path either direction)');
  {
    const r = resolvedRow({
      station: 'Field',
      fromCrew: 'Jonathan', fromWeek: '2026-06-08',
      toCrew: null, toWeek: null,
    });
    const out = checkFieldUnsupported(r);
    check('invalid', out.valid === false, JSON.stringify(out));
  }

  // ==========================================================================
  // checkWindowMembership (B7-followup)
  // ==========================================================================
  //
  // B7 smoke matrix surfaced that forceAssignments whose (job × station × week)
  // tuple falls outside the job's computeWindows() result are silently dropped.
  // applyForceAssignments only fires inside scheduleStation's window iteration
  // (rebalance-schedule.js:1459) and the Pack & Ship + Delivery loop (line
  // 1749). For an out-of-window pin, scheduleStation never visits the tuple
  // and the matched force just sits in activeForceAssignments unused.
  //
  // Validator behavior: reject any row whose pinned (toWeek) falls outside
  // the job's computed station window for that station, with a clear reason
  // citing the window bounds.

  // Station name → window-key mapping mirrors computeWindows()'s output keys
  // (Engineering→eng, Panel Processing→panel, Benchwork→bench,
  // Pre Fin Cab Assembly→prefin, Post Fin Cab Assembly→postfin,
  // Pack & Ship→packShip, Delivery→packShip).
  function makeWindows() {
    return {
      'PL-A': {
        bench:    { start: '2026-05-18', end: '2026-05-29' },  // 5-18 Mon through 5-29 Fri (2 weeks)
        prefin:   { start: '2026-05-25', end: '2026-05-29' },
        postfin:  { start: '2026-06-08', end: '2026-06-12' },
        packShip: { start: '2026-06-08', end: '2026-06-12' },
      },
      'PL-B': {
        // PL-B has no bench (zero hours station)
        prefin:   { start: '2026-05-18', end: '2026-05-22' },
        packShip: { start: '2026-05-25', end: '2026-05-29' },
      },
      // PL-C deliberately missing — silent-pass case
    };
  }

  console.log('\nTest 25: checkWindowMembership — toWeek inside window → valid');
  {
    const r = resolvedRow({
      jobId: 'PL-A', station: 'Benchwork',
      toCrew: 'Ian', toWeek: '2026-05-25',  // inside bench 5-18 → 5-29
    });
    const out = checkWindowMembership(r, makeWindows());
    check('valid', out.valid === true, JSON.stringify(out));
    check('reason null', out.reason === null, JSON.stringify(out));
  }

  console.log('\nTest 26: checkWindowMembership — toWeek before window.start → invalid');
  {
    const r = resolvedRow({
      jobId: 'PL-A', station: 'Pre Fin Cab Assembly',
      toCrew: 'Spencer', toWeek: '2026-05-11',  // before prefin 5-25
    });
    const out = checkWindowMembership(r, makeWindows());
    check('invalid', out.valid === false, JSON.stringify(out));
    check('reason mentions window / outside / station',
      /window|outside|station|pre.?fin/i.test(out.reason || ''),
      out.reason || '(no reason)');
    check('reason cites window dates', /2026-05-25|2026-05-29/.test(out.reason || ''),
      out.reason || '(no reason)');
  }

  console.log('\nTest 27: checkWindowMembership — toWeek after Monday-of(window.end) → invalid');
  {
    const r = resolvedRow({
      jobId: 'PL-A', station: 'Pre Fin Cab Assembly',
      toCrew: 'Spencer', toWeek: '2026-06-01',  // after prefin (end 5-29 Friday, last Monday 5-25)
    });
    const out = checkWindowMembership(r, makeWindows());
    check('invalid', out.valid === false, JSON.stringify(out));
  }

  console.log('\nTest 28: checkWindowMembership — toWeek === window.start (boundary) → valid');
  {
    const r = resolvedRow({
      jobId: 'PL-A', station: 'Benchwork',
      toCrew: 'Ian', toWeek: '2026-05-18',  // === bench.start
    });
    const out = checkWindowMembership(r, makeWindows());
    check('valid', out.valid === true, JSON.stringify(out));
  }

  console.log('\nTest 29: checkWindowMembership — toWeek === Monday-of(window.end) (last week) → valid');
  {
    const r = resolvedRow({
      jobId: 'PL-A', station: 'Benchwork',
      toCrew: 'Ian', toWeek: '2026-05-25',  // bench.end 5-29 → Monday-of-end 5-25
    });
    const out = checkWindowMembership(r, makeWindows());
    check('valid (last-week-of-window boundary)', out.valid === true, JSON.stringify(out));
  }

  console.log('\nTest 30: checkWindowMembership — Pack & Ship maps to packShip key');
  {
    const r = resolvedRow({
      jobId: 'PL-A', station: 'Pack & Ship',
      toCrew: 'Paisios', toWeek: '2026-06-08',  // packShip 6-08 → 6-12, monday-of-end is 6-08
    });
    const out = checkWindowMembership(r, makeWindows());
    check('valid', out.valid === true, JSON.stringify(out));
  }

  console.log('\nTest 31: checkWindowMembership — Delivery maps to packShip key (same window as Pack & Ship)');
  {
    const r = resolvedRow({
      jobId: 'PL-A', station: 'Delivery',
      toCrew: 'Paisios', toWeek: '2026-06-08',
    });
    const out = checkWindowMembership(r, makeWindows());
    check('valid', out.valid === true, JSON.stringify(out));
  }

  console.log('\nTest 32: checkWindowMembership — pure clear (no toCrew) skips');
  {
    const r = resolvedRow({
      jobId: 'PL-A', station: 'Benchwork',
      fromCrew: 'Ian', fromWeek: '2026-05-18',
      toCrew: null, toWeek: null,
    });
    const out = checkWindowMembership(r, makeWindows());
    check('valid (skip — pure clear has no pin destination)', out.valid === true, JSON.stringify(out));
    check('reason null', out.reason === null, JSON.stringify(out));
  }

  console.log('\nTest 33: checkWindowMembership — jobWindows missing entry for this jobId → silent pass');
  {
    // PL-C is not in the window map — the planner couldn't compute (no delivery,
    // not active, etc.). We can't reject what we can't compare against, mirroring
    // the delivery-date check's behavior on missing-delivery jobs.
    const r = resolvedRow({
      jobId: 'PL-C', station: 'Benchwork',
      toCrew: 'Ian', toWeek: '2026-05-25',
    });
    const out = checkWindowMembership(r, makeWindows());
    check('valid (silent pass on missing jobWindows entry)', out.valid === true, JSON.stringify(out));
  }

  console.log('\nTest 34: checkWindowMembership — job exists in windows but station has no window (zero hours) → invalid');
  {
    // PL-B has no bench window (the job has zero bench hours, so computeWindows
    // didn't emit one). An override trying to force bench work on this job
    // would be silently dropped by the planner because scheduleStation never
    // iterates bench for it.
    const r = resolvedRow({
      jobId: 'PL-B', station: 'Benchwork',
      toCrew: 'Ian', toWeek: '2026-05-25',
    });
    const out = checkWindowMembership(r, makeWindows());
    check('invalid', out.valid === false, JSON.stringify(out));
    check('reason mentions no window / zero hours / station has no work',
      /no.*window|zero|no.*hours|no.*work|not scheduled/i.test(out.reason || ''),
      out.reason || '(no reason)');
  }

  console.log('\nTest 35: checkWindowMembership — jobWindows undefined entirely → silent pass (backwards-compat)');
  {
    // Pre-B7-followup callers don't pass jobWindows. The check should silently
    // pass in that case so the old behavior is preserved.
    const r = resolvedRow({
      jobId: 'PL-A', station: 'Pre Fin Cab Assembly',
      toCrew: 'Spencer', toWeek: '2026-12-31',  // way outside any sane window
    });
    const out = checkWindowMembership(r, undefined);
    check('valid (silent pass when jobWindows is undefined)', out.valid === true, JSON.stringify(out));
  }

  // ==========================================================================
  // validateAll integration with the two new checks (B7-followup)
  // ==========================================================================

  console.log('\nTest 36: validateAll — Field row routed to conflicts via checkFieldUnsupported');
  {
    const rows = [
      rawRow({ rowId: '3601', jobMpmId: 'MPM-A', station: 'Field',
               toCrewParentId: 'CP-JON-0608', toWeek: '2026-06-08', hours: 4 }),
    ];
    const jobWindowsByJobId = { 'PL-A': makeWindows()['PL-A'] };
    const out = validateAll(rows, syntheticBaselinePlan(), PL_JOBS, CREW_PARENTS, jobWindowsByJobId);
    check('Field row in conflicts', out.conflicts.length === 1 && out.conflicts[0].rowId === '3601',
      JSON.stringify(out.conflicts.map(c => c.rowId)));
    check('reason mentions Field', /field/i.test(out.conflicts[0]?.reason || ''),
      out.conflicts[0]?.reason || '(no reason)');
  }

  console.log('\nTest 37: validateAll — out-of-window force-row routed to conflicts via checkWindowMembership');
  {
    const rows = [
      rawRow({ rowId: '3701', jobMpmId: 'MPM-A', station: 'Pre Fin Cab Assembly',
               toCrewParentId: 'CP-SPN-0518', toWeek: '2026-05-18',  // before prefin 5-25
               hours: 4 }),
    ];
    const jobWindowsByJobId = { 'PL-A': makeWindows()['PL-A'] };
    const out = validateAll(rows, syntheticBaselinePlan(), PL_JOBS, CREW_PARENTS, jobWindowsByJobId);
    check('out-of-window row in conflicts', out.conflicts.length === 1 && out.conflicts[0].rowId === '3701',
      JSON.stringify(out.conflicts.map(c => c.rowId)));
    check('reason cites window', /window|outside/i.test(out.conflicts[0]?.reason || ''),
      out.conflicts[0]?.reason || '(no reason)');
  }

  console.log('\nTest 38: validateAll — backwards-compat: omitted jobWindows arg does NOT cause new rejections');
  {
    // Pre-B7-followup signature: validateAll(rows, plan, jobs, parents) — no 5th arg.
    // A row that would be rejected by checkWindowMembership if windows were present
    // should still pass when windows are omitted. Use Jonathan/6-08 (capacity
    // 0/40, room for plenty) and Job A (delivery 6-12 → delivery-week 6-08
    // matches toWeek 6-08 exactly, passes delivery-date check).
    const rows = [
      rawRow({ rowId: '3801', jobMpmId: 'MPM-A', station: 'Pre Fin Cab Assembly',
               toCrewParentId: 'CP-JON-0608', toWeek: '2026-06-08', hours: 4 }),
    ];
    const out = validateAll(rows, syntheticBaselinePlan(), PL_JOBS, CREW_PARENTS);
    // Should still be accepted (other checks pass; window check silent-passes when undefined).
    check('row still accepted (no jobWindows = no window check)',
      out.accepted.length === 1 && out.accepted[0].rowId === '3801',
      JSON.stringify({ accepted: out.accepted.map(a => a.rowId), conflicts: out.conflicts.map(c => c.rowId) }));
  }

  // ==========================================================================
  // Phase 1.1 — Applied-row persistence (validateAll input filter)
  // ==========================================================================
  //
  // Spec Section B Step 3: "Translate each Applied row into an internal
  // forceAssignment". Pre-1.1, validateAll dropped non-Pending rows silently,
  // so an Applied row from Day 1 lost its effect on Day 2's --plan run. The
  // 1.1 fix accepts Pending AND Applied rows into the validation pass. Applied
  // rows re-validate against the current baseline / delivery dates / capacity
  // — if conditions changed since the prior run (delivery push, capacity
  // shrink), an Applied row may now fail and flip to Conflict. Conflict +
  // Cleared rows still don't re-validate (operator must manually flip
  // Conflict → Pending to retry).

  console.log('\nTest 39: validateAll — Applied row re-validates as still valid → accepted');
  {
    // Same shape as a successful Pending row, but status='Applied'. Pre-1.1
    // this row would have been silently dropped (not in accepted, not in
    // conflicts). Post-1.1 it's re-processed and returns in accepted.
    const rows = [
      rawRow({ rowId: '3901', status: 'Applied', jobMpmId: 'MPM-A',
               toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25', hours: 8 }),
    ];
    const out = validateAll(rows, syntheticBaselinePlan(), PL_JOBS, CREW_PARENTS);
    check('Applied row reaches validation and gets accepted',
      out.accepted.length === 1 && out.accepted[0].rowId === '3901',
      JSON.stringify({ accepted: out.accepted.map(a => a.rowId), conflicts: out.conflicts.map(c => c.rowId) }));
    check('conflicts empty', out.conflicts.length === 0, JSON.stringify(out.conflicts));
  }

  console.log('\nTest 40: validateAll — Applied row re-validates as Conflict when baseline changed (delivery moved past pin)');
  {
    // Day 1: row pinned Spencer/5-25, delivery 5-29 (Friday, deliveryWeek 5-25).
    // Status flipped to Applied on Day 1.
    // Day 2: someone pushed Job B's delivery date — now 5-22 (a week earlier).
    //         deliveryWeek is now 5-18; the existing pin at 5-25 is past it.
    // Expected: re-validates as Conflict.
    const rows = [
      rawRow({ rowId: '4001', status: 'Applied', jobMpmId: 'MPM-B',
               toCrewParentId: 'CP-SPN-0525', toWeek: '2026-05-25', hours: 5 }),
    ];
    const movedJobs = PL_JOBS.map(j => j.masterPmId === 'MPM-B'
      ? { ...j, delivery: '2026-05-22' }
      : j);
    const out = validateAll(rows, syntheticBaselinePlan(), movedJobs, CREW_PARENTS);
    check('Applied row flips to conflicts when baseline moved',
      out.conflicts.length === 1 && out.conflicts[0].rowId === '4001',
      JSON.stringify({ accepted: out.accepted.map(a => a.rowId), conflicts: out.conflicts.map(c => c.rowId) }));
    check('reason cites delivery date',
      /deliver/i.test(out.conflicts[0]?.reason || ''),
      out.conflicts[0]?.reason || '(no reason)');
  }

  console.log('\nTest 41: validateAll — Applied row preserves softWarning (e.g. capacity over-cap with Allow Over-Cap checked)');
  {
    // Day 1 row was Applied with the Allow Over-Cap checkbox; Day 2 same
    // shape re-validates as accepted with the same softWarning.
    const rows = [
      rawRow({ rowId: '4101', status: 'Applied', jobMpmId: 'MPM-A',
               toCrewParentId: 'CP-SPN-0525', toWeek: '2026-05-25',
               hours: 10, allowOverCap: true }),
    ];
    const out = validateAll(rows, syntheticBaselinePlan(), PL_JOBS, CREW_PARENTS);
    check('still accepted on re-validation',
      out.accepted.length === 1 && out.accepted[0].rowId === '4101',
      JSON.stringify(out));
    check('softWarning preserved',
      typeof out.accepted[0]?.softWarning === 'string' && /over|cap/i.test(out.accepted[0].softWarning),
      out.accepted[0]?.softWarning || '(no softWarning)');
  }

  console.log('\nTest 42: validateAll — Conflict and Cleared rows still skipped (no re-validation)');
  {
    // Conflict rows: operator must manually flip back to Pending to retry.
    // Cleared rows: terminal state for the row. Neither reaches validation.
    const rows = [
      rawRow({ rowId: '4201', status: 'Conflict', jobMpmId: 'MPM-A',
               toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25', hours: 8 }),
      rawRow({ rowId: '4202', status: 'Cleared', jobMpmId: 'MPM-A',
               toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25', hours: 8 }),
      // Sanity-check Pending in the same batch still works.
      rawRow({ rowId: '4203', status: 'Pending', jobMpmId: 'MPM-A',
               toCrewParentId: 'CP-IAN-0525', toWeek: '2026-05-25', hours: 8 }),
    ];
    const out = validateAll(rows, syntheticBaselinePlan(), PL_JOBS, CREW_PARENTS);
    check('only Pending in accepted (Conflict + Cleared dropped before validation)',
      out.accepted.length === 1 && out.accepted[0].rowId === '4203',
      JSON.stringify({ accepted: out.accepted.map(a => a.rowId), conflicts: out.conflicts.map(c => c.rowId) }));
    check('conflicts empty (skipped, not flagged)',
      out.conflicts.length === 0,
      JSON.stringify(out.conflicts.map(c => c.rowId)));
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
