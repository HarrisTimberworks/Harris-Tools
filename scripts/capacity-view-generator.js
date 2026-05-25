// C1 — Capacity View / Weekly Briefing generator (priority-order leaf).
//
// Pure functions only. No monday I/O. Consumed by C2 (Capacity View per-week
// section generator) and C6 (Weekly Briefing generator). See
// docs/phase-2-manual-overrides-plan.md §C and §B/D4 for spec.
//
// Exported here:
//   - buildPriorityOrder(weekISO, plan, jobsById) → { highest, high, normal }
//
// C2/C3/C5/C6 will add to this file (or sibling files in this directory) as
// Phase 2 progresses; deliberately starting small.

// ============================================================================
// Date helpers (inlined to keep this module side-effect-free at require time;
// importing scripts/rebalance-schedule.js would trigger its OVERRIDES JSON
// read at require time. The token check moved inside `if (require.main ===
// module)` during the B3 refactor, so token is no longer the concern, but
// the JSON read remains.)
// ============================================================================

function parseISO(s) { return new Date(s + 'T00:00:00Z'); }

function getMondayOfWeek(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

// Calendar-week distance between two ISO dates. weekISO is assumed to be a
// Monday-of-week (per contract); the delivery date is snapped to its
// Monday-of-week before differencing so partial-week math doesn't drift.
function weeksUntil(weekISO, deliveryISO) {
  const fromMon = parseISO(weekISO);
  const delMon  = getMondayOfWeek(parseISO(deliveryISO));
  const diffDays = (delMon.getTime() - fromMon.getTime()) / 86400000;
  return Math.round(diffDays / 7);
}

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatDeliveryRelative(deliveryISO) {
  const d = parseISO(deliveryISO);
  return `${WEEKDAY_ABBR[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

// ============================================================================
// Tiering per D4 — see docs/phase-2-manual-overrides-plan.md §B/D4
// ============================================================================
//
//   🔴 highest = weeksUntilDelivery in [0, 1]
//   🟡 high    = weeksUntilDelivery == 2
//   🟢 normal  = weeksUntilDelivery > 2  OR  < 0 (past-delivery is defensively
//                routed to green; should not appear in active jobs but might
//                via planner data drift)
function tierFor(weeks) {
  if (weeks < 0) return 'normal';
  if (weeks <= 1) return 'highest';
  if (weeks === 2) return 'high';
  return 'normal';
}

// ============================================================================
// buildPriorityOrder — C1
// ============================================================================
//
// Groups the week's placements by (crew × jobId), rolls up stations, computes
// tier from delivery proximity, returns three sorted arrays.
//
// Skip conditions (per task prompt edge-case list):
//   - placement.jobId missing/null  → orphan, skip
//   - placement.week !== weekISO    → wrong week, skip
//   - jobsById[jobId] missing       → inactive job (caller pre-filtered), skip
//   - job.delivery missing          → defensive omit (D4 spec assumes delivery)
//
// Sort within each tier: deliveryDate ascending, then crew name ascending
// (alphabetical tiebreaker).
function buildPriorityOrder(weekISO, plan, jobsById) {
  const result = { highest: [], high: [], normal: [] };
  const placements = (plan && plan.placements) || [];
  const jobs = jobsById || {};

  // Group by (crew × jobId). Map<string, GroupState>.
  // GroupState = { crew, jobId, jobName, deliveryDate, deliveryRelative,
  //                stationMap: Map<station, {station, hours, pinned?}> }
  const groups = new Map();

  for (const p of placements) {
    if (!p || !p.jobId) continue;
    if (p.week !== weekISO) continue;
    const job = jobs[p.jobId];
    if (!job || !job.delivery) continue;

    const key = `${p.crew}|${p.jobId}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        crew: p.crew,
        jobId: p.jobId,
        jobName: job.name,
        deliveryDate: job.delivery,
        deliveryRelative: formatDeliveryRelative(job.delivery),
        stationMap: new Map(),
      };
      groups.set(key, g);
    }

    const isPinned = !!(p.pinned || p.force);
    const existing = g.stationMap.get(p.station);
    if (existing) {
      existing.hours += Number(p.hours || 0);
      if (isPinned) existing.pinned = true;
    } else {
      const entry = { station: p.station, hours: Number(p.hours || 0) };
      if (isPinned) entry.pinned = true;
      g.stationMap.set(p.station, entry);
    }
  }

  // Materialize items and bucket by tier.
  for (const g of groups.values()) {
    const stations = Array.from(g.stationMap.values());
    const item = {
      crew: g.crew,
      jobName: g.jobName,
      jobId: g.jobId,
      stations,
      deliveryDate: g.deliveryDate,
      deliveryRelative: g.deliveryRelative,
      pinned: stations.some(s => s.pinned),
    };
    const tier = tierFor(weeksUntil(weekISO, g.deliveryDate));
    result[tier].push(item);
  }

  // Sort each tier in-place.
  for (const tier of ['highest', 'high', 'normal']) {
    result[tier].sort((a, b) => {
      if (a.deliveryDate !== b.deliveryDate) return a.deliveryDate.localeCompare(b.deliveryDate);
      return a.crew.localeCompare(b.crew);
    });
  }

  return result;
}

module.exports = {
  buildPriorityOrder,
};
