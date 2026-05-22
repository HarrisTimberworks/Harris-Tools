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

const { getMondayOfWeek, parseISO, toISO } = require('./rebalance-schedule.js');

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

// Partition Pending rows into { accepted, conflicts }. Non-Pending rows
// (Applied / Conflict / Cleared) are dropped silently — they were validated
// on a prior run. Re-validating them would either double-write (Applied)
// or re-surface stale conflicts.
//
// Each accepted entry is the resolved row plus { decision: 'accepted',
// softWarning? } so the caller can both translate into forceAssignments and
// surface soft warnings (capacity over-cap with Allow Over-Cap checked).
//
// Each conflict entry is the resolved-or-raw row plus { decision: 'conflict',
// reason }. The reason combines all failing checks for that row.
function validateAll(rawRows, baselinePlan, plJobs, crewParents) {
  const accepted = [];
  const conflicts = [];

  for (const raw of rawRows || []) {
    if (raw.status !== 'Pending') continue;

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

    const d = checkDeliveryDateConstraint(row, plJobs);
    if (!d.valid) reasons.push(d.reason);

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
  validateAll,
  // Exposed for run-planner.js to reuse the same resolution logic when
  // translating accepted rows into forceAssignments / crewExclusions.
  resolveRow,
};
