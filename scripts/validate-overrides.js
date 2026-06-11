// B5 — Manual Overrides validation pipeline.
//
// Pure functions, no I/O. Sibling module to scripts/rebalance-schedule.js,
// matching the precedent of scripts/validate-cross-training.js.
//
// Three per-row checks decide whether a Pending Manual Overrides row gets
// applied to the planner's second pass:
//
//   - checkDeliveryDateConstraint(row, plJobs) — strict.
//   - checkConsistency(row, baselinePlan)      — strict.
//   - checkCapacity(row, baselinePlan, allow)  — lenient (with checkbox).
//
// `validateAll` resolves each raw board row's foreign-key fields once, runs
// the three checks, and returns { accepted, conflicts }. The accepted bucket
// feeds the planner's second pass (via translateOverrideRows + the merge
// helpers in rebalance-schedule.js). The conflicts bucket feeds B6's
// per-row writeback (Status / Conflict Reason).
//
// Note on the "Master PM customWindow" terminology in the design spec:
// per Phase 1 plan Section D.3, customWindow lives in JSON
// (rebalance-overrides.json) — Master PM carries the delivery date, not the
// customWindow. So the validator implements `checkDeliveryDateConstraint`
// as **delivery-date strict** (pin week ≤ delivery-week), not a literal
// customWindow lookup. The spec wording is treated as shorthand for "the
// job's planning constraint."
//
// Note on the validateAll signature: the design brief calls out
// validateAll(rows, baselinePlan, plJobs); we additionally require
// crewParents to resolve each row's From/To Crew Allocation parent-id
// references to (crew, week) tuples. The consistency check and the
// capacity check both depend on those resolutions, so threading them
// through validateAll is mandatory. Documented here so a future reader
// doesn't think it's drift.

const { getMondayOfWeek, parseISO, toISO, hardRuleViolation } = require('./rebalance-schedule.js');

// Returns { valid: bool, reason: string|null }.
// Strict: the row's pin week (toWeek if present, else fromWeek) must be ≤
// the job's delivery-week (Monday-of-delivery). If delivery is missing,
// silently pass — we can't reject what we can't compare against, and other
// validators (B7 smoke / E2 finishing-cycle gate) will catch missing-
// delivery jobs by other means.
function checkDeliveryDateConstraint(row, plJobs) {
  const job = (plJobs || []).find(j => String(j.masterPmId) === String(row.jobMpmId));
  if (!job || !job.delivery) return { valid: true, reason: null };

  const pinWeek = row.toWeek || row.fromWeek;
  if (!pinWeek) return { valid: true, reason: null };

  // Compare Mondays. Delivery date may fall any day of the week; the
  // operationally-correct test is "is the work week ≤ the delivery week?"
  const deliveryWeek = toISO(getMondayOfWeek(parseISO(job.delivery)));
  if (pinWeek > deliveryWeek) {
    return {
      valid: false,
      reason: `pin week ${pinWeek} is past job ${job.name || job.id} delivery date ${job.delivery} (delivery week ${deliveryWeek})`,
    };
  }
  return { valid: true, reason: null };
}

// Returns { valid: bool, reason: string|null }.
// Strict. Skips when the row has no From side (pure assign — nothing to
// reconcile against the baseline). Otherwise sums baselinePlan.placements
// where (masterPmId × station × crew × week) matches the row's From side
// and compares against row.hours. A small floating-point epsilon protects
// against the planner's toFixed(2) rounding leaving sums like 14.9999...
function checkConsistency(row, baselinePlan) {
  if (!row.fromCrew || !row.fromWeek) {
    return { valid: true, reason: null };
  }
  const placements = baselinePlan?.placements || [];
  let allocated = 0;
  for (const p of placements) {
    if (String(p.masterPmId) !== String(row.jobMpmId)) continue;
    if (p.station !== row.station) continue;
    if (p.crew !== row.fromCrew) continue;
    if (p.week !== row.fromWeek) continue;
    allocated += Number(p.hours || 0);
  }
  const EPS = 1e-6;
  if (allocated + EPS < row.hours) {
    return {
      valid: false,
      reason: `baseline allocates only ${allocated.toFixed(2)}h to ${row.fromCrew} × ${row.station} × ${row.fromWeek} for this job; row requests ${row.hours}h`,
    };
  }
  return { valid: true, reason: null };
}

// B7-followup. Returns { valid: bool, reason: string|null }.
// Reject station='Field' explicitly. B7 smoke matrix proved that Field
// overrides land Status=Applied on the board but have no plan effect, because
// "Field" is not in scripts/rebalance-schedule.js's STATION_ORDER and
// scheduleStation never iterates Field for any job. The board exposes the
// dropdown value; the planner has no execution path. Honest failure mode is
// to surface a Conflict at validation time rather than let the row look
// accepted while doing nothing.
//
// When (if ever) the planner gains a Field execution path (e.g. punchlist /
// install routing in Phase 2 or 3), delete this check.
function checkFieldUnsupported(row) {
  if (row && row.station === 'Field') {
    return {
      valid: false,
      reason: 'Field is unsupported in Phase 1 — no execution path for Field-stationed work in the planner (no entry in STATION_ORDER, scheduleStation never iterates it). Re-station the work or wait for Phase 2/3 to wire Field placement.',
    };
  }
  return { valid: true, reason: null };
}

// B7-followup. Returns { valid: bool, reason: string|null }.
// Reject a pinned (toWeek) that falls outside the job's computed station
// window. B7 smoke matrix proved that out-of-window forces are silently
// dropped — applyForceAssignments only fires inside scheduleStation's
// window iteration (rebalance-schedule.js:1459) and the Pack & Ship +
// Delivery loop (line 1749). For an outside-window pin, scheduleStation
// never visits the (job × station × week) tuple, so the matched force
// in activeForceAssignments is never consumed.
//
// Skip conditions:
//   - Pure clear (no toCrew/toWeek): crewExclusions apply globally and are
//     not gated by scheduleStation's iteration. No pin destination to check.
//   - jobWindows undefined: backwards-compat with pre-B7-followup callers
//     (validateAll's 5th arg is optional).
//   - jobWindows[jobId] missing: the planner couldn't compute windows for
//     this job (no delivery date, not active, etc.). Mirrors
//     checkDeliveryDateConstraint's silent-pass on missing delivery.
//
// Reject conditions:
//   - jobWindows[jobId] exists but station's window is missing (zero hours
//     for that station on that job — computeWindows skips zero-hours
//     stations). The planner will never iterate this station for this job,
//     so any force here is silently dropped.
//   - toWeek < window.start (pin before window opens).
//   - toWeek > Monday-of(window.end) (pin after window's last week).
//
// Station → window-key mapping mirrors computeWindows()'s output:
//   Engineering → eng
//   Panel Processing → panel
//   Benchwork → bench
//   Pre Fin Cab Assembly → prefin
//   Post Fin Cab Assembly → postfin
//   Pack & Ship → packShip
//   Delivery → packShip  (same single-week window as Pack & Ship)
//   Field → not in the mapping (handled by checkFieldUnsupported)
const STATION_TO_WINDOW_KEY = {
  'Engineering': 'eng',
  'Panel Processing': 'panel',
  'Benchwork': 'bench',
  'Pre Fin Cab Assembly': 'prefin',
  'Post Fin Cab Assembly': 'postfin',
  'Pack & Ship': 'packShip',
  'Delivery': 'packShip',
};

function checkWindowMembership(row, jobWindows) {
  if (jobWindows == null) return { valid: true, reason: null };
  if (!row.toCrew || !row.toWeek) return { valid: true, reason: null };

  const w = jobWindows[row.jobId];
  if (!w) return { valid: true, reason: null };

  const key = STATION_TO_WINDOW_KEY[row.station];
  if (!key) return { valid: true, reason: null };  // unknown station — leave to other checks

  const stationWindow = w[key];
  if (!stationWindow) {
    return {
      valid: false,
      reason: `job has no ${row.station} window (zero hours for this station) — planner won't iterate ${row.station} for this job, force would be silently dropped`,
    };
  }

  const start = stationWindow.start;
  // window.end is a Friday (Monday-of-last-week + 4 days). Snap to that
  // week's Monday for the Monday-of-week comparison the planner pins on.
  const lastMonday = toISO(getMondayOfWeek(parseISO(stationWindow.end)));

  if (row.toWeek < start || row.toWeek > lastMonday) {
    return {
      valid: false,
      reason: `pin week ${row.toWeek} is outside ${row.station} window ${start} → ${stationWindow.end} (last-week Monday ${lastMonday}); planner won't iterate this (job × station × week) tuple so force would be silently dropped`,
    };
  }
  return { valid: true, reason: null };
}

// SMOKE FIX (2026-06-10). Returns { valid: bool, reason: string|null }.
// The planner's PATCH-3 hard rules (rebalance-schedule.js hardRuleViolation)
// THROW inside applyForceAssignments — a board force that violates one
// crashes pass 2 after writeback already flipped the row to Applied. Hard
// rules are a distinct tier from the lenient cross-training matrix (the
// matrix is advisory; hard rules are planner-enforced exceptions), so the
// validator rejects them up front. Skips pure clears (no force destination).
// Missing subtype defaults to 'Commercial', mirroring the PL loader.
function checkHardRule(row, plJobs) {
  if (!row.toCrew || !row.toWeek) return { valid: true, reason: null };
  const job = (plJobs || []).find(j => String(j.masterPmId) === String(row.jobMpmId));
  const subtype = (job && job.subtype) || 'Commercial';
  const hit = hardRuleViolation(row.toCrew, row.station, subtype, row.toWeek);
  if (hit) {
    return {
      valid: false,
      reason: `planner hard rule: ${hit} — the force would be rejected at apply time, so it is flagged here instead`,
    };
  }
  return { valid: true, reason: null };
}

// Returns { valid: bool, reason: string|null, softWarning?: string }.
// Lenient with checkbox: a row whose To Crew × To Week would exceed the
// week's cap is rejected by default and accepted (with softWarning) when
// allowOverCap is true. Pure clears (no To side) skip — there's nothing to
// add to. If the capacityGrid has no entry for (toCrew, toWeek), we cannot
// evaluate the cap and pass through (matches the planner's own handling
// of forces against absent slots — applyForceAssignments warns at runtime).
function checkCapacity(row, baselinePlan, allowOverCap) {
  if (!row.toCrew || !row.toWeek) {
    return { valid: true, reason: null };
  }
  const slot = baselinePlan?.capacityGrid?.[row.toCrew]?.[row.toWeek];
  if (!slot) return { valid: true, reason: null };

  const cap = Number(slot.avail || 0);
  const committed = Number(slot.committed || 0);
  const wouldBe = committed + Number(row.hours || 0);
  if (wouldBe <= cap) return { valid: true, reason: null };

  if (allowOverCap) {
    return {
      valid: true,
      reason: null,
      softWarning: `${row.toCrew} ${row.toWeek} would be ${wouldBe.toFixed(2)}/${cap} (over cap by ${(wouldBe - cap).toFixed(2)} hrs) — Allow Over-Cap is checked`,
    };
  }
  return {
    valid: false,
    reason: `${row.toCrew} ${row.toWeek} would be ${wouldBe.toFixed(2)}/${cap} hrs (over cap by ${(wouldBe - cap).toFixed(2)}). Tick Allow Over-Cap to apply anyway.`,
  };
}

// Resolves a raw board row (with foreign-key fields jobMpmId,
// fromCrewParentId, toCrewParentId) into the resolved-row shape the
// per-check functions consume. Returns either:
//   { ok: true, row: <resolvedRow> } or
//   { ok: false, reason: '<why resolution failed>' }
function resolveRow(rawRow, plJobs, crewParents) {
  const job = (plJobs || []).find(j => String(j.masterPmId) === String(rawRow.jobMpmId));
  if (!job) {
    return { ok: false, reason: `unresolved job: no Production Load entry for Master PM id ${rawRow.jobMpmId}` };
  }

  let fromCrew = null, fromWeek = null;
  if (rawRow.fromCrewParentId) {
    const ref = (crewParents || []).find(p => String(p.parentId) === String(rawRow.fromCrewParentId));
    if (!ref) {
      return { ok: false, reason: `unresolved From crew parent id ${rawRow.fromCrewParentId} — no matching Crew Allocation parent row` };
    }
    fromCrew = ref.crew;
    fromWeek = ref.week;
  }

  let toCrew = null, toWeek = null;
  if (rawRow.toCrewParentId) {
    const ref = (crewParents || []).find(p => String(p.parentId) === String(rawRow.toCrewParentId));
    if (!ref) {
      return { ok: false, reason: `unresolved To crew parent id ${rawRow.toCrewParentId} — no matching Crew Allocation parent row` };
    }
    toCrew = ref.crew;
    toWeek = ref.week;
  }

  return {
    ok: true,
    row: {
      rowId: rawRow.rowId,
      jobMpmId: rawRow.jobMpmId,
      jobId: job.id,
      station: rawRow.station,
      hours: Number(rawRow.hours || 0),
      status: rawRow.status,
      allowOverCap: !!rawRow.allowOverCap,
      fromCrew, fromWeek,
      toCrew,   toWeek,
    },
  };
}

// Partition Pending + Applied rows into { accepted, conflicts }. Conflict
// and Cleared rows are dropped silently — Conflict rows need an operator's
// explicit Conflict→Pending flip in monday UI to retry; Cleared rows are
// terminal.
//
// Phase 1.1: Applied rows re-validate each run so they keep their effect
// across days. Pre-1.1 this filter was Pending-only, and an Applied row
// from Day 1 lost its forceAssignment on Day 2's --plan — spec Section B
// Step 3 ("Translate each Applied row into an internal forceAssignment")
// wasn't met. The re-validation also gives the planner a chance to flip
// Applied → Conflict if the baseline shifted (delivery push, capacity
// shrink, etc.). Auto-stale automation handles the row at its natural
// end-of-life when the row's relevant week passes.
//
// Each accepted entry is the resolved row plus { decision: 'accepted',
// softWarning? } so the caller can both translate into forceAssignments and
// surface soft warnings (capacity over-cap with Allow Over-Cap checked).
//
// Each conflict entry is the resolved-or-raw row plus { decision: 'conflict',
// reason }. The reason combines all failing checks for that row.
function validateAll(rawRows, baselinePlan, plJobs, crewParents, jobWindows) {
  const accepted = [];
  const conflicts = [];

  for (const raw of rawRows || []) {
    if (raw.status !== 'Pending' && raw.status !== 'Applied') continue;

    const resolved = resolveRow(raw, plJobs, crewParents);
    if (!resolved.ok) {
      conflicts.push({
        rowId: raw.rowId,
        decision: 'conflict',
        reason: resolved.reason,
        _raw: raw,
      });
      continue;
    }
    const row = resolved.row;

    const reasons = [];
    let softWarning = null;

    const f = checkFieldUnsupported(row);
    if (!f.valid) reasons.push(f.reason);

    const h = checkHardRule(row, plJobs);
    if (!h.valid) reasons.push(h.reason);

    const d = checkDeliveryDateConstraint(row, plJobs);
    if (!d.valid) reasons.push(d.reason);

    const w = checkWindowMembership(row, jobWindows);
    if (!w.valid) reasons.push(w.reason);

    const c = checkConsistency(row, baselinePlan);
    if (!c.valid) reasons.push(c.reason);

    const cap = checkCapacity(row, baselinePlan, row.allowOverCap);
    if (!cap.valid) reasons.push(cap.reason);
    else if (cap.softWarning) softWarning = cap.softWarning;

    if (reasons.length > 0) {
      conflicts.push({
        rowId: row.rowId,
        decision: 'conflict',
        reason: reasons.join('; '),
        _row: row,
      });
    } else {
      accepted.push({
        ...row,
        decision: 'accepted',
        ...(softWarning ? { softWarning } : {}),
      });
    }
  }

  return { accepted, conflicts };
}

module.exports = {
  checkDeliveryDateConstraint,
  checkConsistency,
  checkCapacity,
  checkFieldUnsupported,
  checkHardRule,
  checkWindowMembership,
  validateAll,
  // Exposed for run-planner.js to reuse the same resolution logic when
  // translating accepted rows into forceAssignments / crewExclusions.
  resolveRow,
};
