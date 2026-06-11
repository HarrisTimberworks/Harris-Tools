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

    // NB: the planner emits `forced: true` (rebalance-schedule.js:1091).
    // `pinned`/`force` are kept for synthetic-fixture backwards-compat; the
    // real-plan field is `forced`. See test-derive-override-tuples.js
    // Tests 14–15 (same incident family as the `avail` field-name bug).
    const isPinned = !!(p.pinned || p.force || p.forced);
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

// ============================================================================
// C2 — buildWeekSection (per-week markdown section generator)
// ============================================================================
//
// Shape decisions locked via chat-approved proposal:
//   - Heading: ## Week of M/D — XX.XX crew hrs (2 decimals always)
//   - Key-dates: 📌 finish drop / 🎯 finish return / 🚚 client delivery
//     (🚧 holiday deferred to Phase 5 — no planner data source yet)
//   - Crew table (5 cols Crew/Load/Job/Station/Hrs): alphabetical crews;
//     multi-station continuation rows have blank Crew + blank Load; sub
//     rows show "N / —" in Load and "*(sub)*" italic suffix on Hrs;
//     pinned cells append "*(pinned)*" italic; PTO-only rows use em-dash
//     (—) for empty cells (not truly blank — matches existing doc style)
//   - Capacity thresholds sourced from SOFT_CAP_MULTIPLIER = 1.05 at
//     rebalance-schedule.js:169 (the planner's actual over-cap test):
//       🔴: committed > available * 1.05
//       🟡: committed / available ≥ 0.95 AND NOT over
//       blank: under 0.95
//     The planner's console output at rebalance-schedule.js:1881 uses
//     🚨 + >0.9 — that's debug output, not the doc convention. C2
//     emits the doc convention (🔴 + ≥95%).
//   - 🔧 indicator (C5 hook): options.acceptedOverrides = [{ jobId,
//     station, crew, week }, ...] — when a placement's tuple matches,
//     prefix the Hrs cell with "🔧 ". Default empty/missing → no 🔧
//     anywhere (backwards-compat).
//   - Priority order: bold "Priority order…" label, tier headers with
//     auto-scaffolded "<JobName> delivery <DayAbbr M/D>" context for
//     🔴 / 🟡 (🟢 NORMAL gets no context — matches existing doc),
//     continuous numbering across tiers, item format
//       **<Crew> — <Job> <stations summary>** — delivery <DayAbbr M/D>
//     Stations summary: abbreviated names joined with " + ", pinned
//     marker per station: Bench (8h, pinned).
//   - Job names: full Master PM names as-is (no auto-shortener; the
//     existing doc's "MAG R5-P2 CU" abbreviations were operator hand-
//     edits and Phase 2's automation goal removes that overhead).
//   - Station abbreviations: per the capacity-view-refresh skill table.
//   - Trailing divider: "---" — lets C3 concatenate per-week sections
//     directly.

// Station name → abbreviated form for tables + priority lists.
// Source: docs/htw-production-system-handoff.md + capacity-view-refresh
// skill's "Station name mapping (doc → board)" table.
const STATION_ABBR = Object.freeze({
  'Engineering':           'Eng',
  'Panel Processing':      'Panel',
  'Benchwork':             'Bench',
  'Pre Fin Cab Assembly':  'PreFin',
  'Post Fin Cab Assembly': 'PostFin',
  'Pack & Ship':           'P&S',
  'Delivery':              'Deliver',
  'Field':                 'Field',
});

// Mirrors the planner's SOFT_CAP_MULTIPLIER at scripts/rebalance-schedule.js:169.
const SOFT_CAP_MULTIPLIER = 1.05;

function abbrStation(s) {
  return STATION_ABBR[s] || s;
}

// "6/8" no zero-pad
function formatMD(iso) {
  const d = parseISO(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

// Returns whether `dateISO` lands in the Mon-Sun window starting on weekISO.
function isInWeek(dateISO, weekISO) {
  const start = parseISO(weekISO).getTime();
  const end = start + 6 * 86400000;  // Mon + 6d = Sun
  const t = parseISO(dateISO).getTime();
  return t >= start && t <= end;
}

// "" | " 🟡" | " 🔴" suffix for the Load cell, mirroring the existing
// Capacity View doc's legend ("🔴 = over cap • 🟡 = ≥95% • blank = under cap")
// while anchoring "over" to the planner's SOFT_CAP_MULTIPLIER threshold so
// the two stay coherent.
function capacityMarker(committed, available) {
  const c = Number(committed || 0);
  const a = Number(available || 0);
  if (a === 0) return c > 0 ? ' 🔴' : '';
  if (c > a * SOFT_CAP_MULTIPLIER) return ' 🔴';
  if (c / a >= 0.95) return ' 🟡';
  return '';
}

// Format the Load cell for a regular (non-sub) crew row.
function formatLoadRegular(committed, available) {
  return `${Number(committed || 0)} / ${Number(available || 0)}${capacityMarker(committed, available)}`;
}

// Format the Load cell for a subcontractor crew row — no cap, em-dash.
function formatLoadSub(committed) {
  return `${Number(committed || 0)} / —`;
}

// Format the Hrs cell for one placement. Combines: optional 🔧 prefix from
// the C5 acceptedOverrides set, the raw hours value, optional *(pinned)*
// italic suffix when the placement is force-pinned, optional *(sub)*
// italic suffix when the crew is a subcontractor.
function formatHrsCell(placement, isSub, options) {
  // `forced` is the planner's canonical field (rebalance-schedule.js:1091);
  // `pinned`/`force` accepted for synthetic fixtures.
  const pinned = !!(placement.pinned || placement.force || placement.forced);
  const wrenched = (options?.acceptedOverrides || []).some(o =>
    String(o.jobId) === String(placement.jobId) &&
    o.station === placement.station &&
    o.crew === placement.crew &&
    o.week === placement.week
  );
  let cell = String(Number(placement.hours || 0));
  if (wrenched) cell = `🔧 ${cell}`;
  if (pinned)   cell += ' *(pinned)*';
  if (isSub)    cell += ' *(sub)*';
  return cell;
}

// Detect whether a crew is a subcontractor virtual entity. Source-of-truth:
// the planner sets `slot.subcontractor = true` for virtual sub crews
// (rebalance-schedule.js:734). Fall back to name-pattern when grid is
// missing for some reason (defensive, unlikely in real --plan output).
function isSubcontractor(crew, capacityGrid, weekISO) {
  const slot = capacityGrid?.[crew]?.[weekISO];
  if (slot && slot.subcontractor === true) return true;
  return /sub/i.test(crew);
}

// Heading: "## Week of M/D — XX.XX crew hrs". XX.XX is the sum of placement
// hours for this week's placements, fixed to 2 decimals always (matches the
// existing doc's "83.95" / "111.95" style).
function buildHeading(weekISO, plan) {
  const placements = (plan?.placements || []).filter(p => p.week === weekISO);
  const total = placements.reduce((s, p) => s + Number(p.hours || 0), 0);
  return `## Week of ${formatMD(weekISO)} — ${total.toFixed(2)} crew hrs`;
}

// Key-dates block: 📌 finish drop, 🎯 finish return, 🚚 client delivery —
// emoji-prefixed bold lines, sorted by date ascending, grouped by date so a
// shared date renders as "📌 Fri 5/29 — Liz Stapp + SH McMorris finish drops".
// Returns '' when no events land in the week (caller decides whether to emit
// a blank line for spacing).
function buildKeyDatesBlock(weekISO, plan, jobsById) {
  const drops = new Map();      // date → [jobNames]
  const returns = new Map();
  const deliveries = new Map();

  const fcRows = plan?.finishingCycleReport?.rows || [];
  for (const r of fcRows) {
    if (r.finishDrop && isInWeek(r.finishDrop, weekISO)) {
      if (!drops.has(r.finishDrop)) drops.set(r.finishDrop, []);
      drops.get(r.finishDrop).push(r.jobName);
    }
    if (r.finishReturn && isInWeek(r.finishReturn, weekISO)) {
      if (!returns.has(r.finishReturn)) returns.set(r.finishReturn, []);
      returns.get(r.finishReturn).push(r.jobName);
    }
  }
  for (const jobId of Object.keys(jobsById || {})) {
    const job = jobsById[jobId];
    if (job?.delivery && isInWeek(job.delivery, weekISO)) {
      if (!deliveries.has(job.delivery)) deliveries.set(job.delivery, []);
      deliveries.get(job.delivery).push(job.name);
    }
  }

  const lines = [];
  const emit = (map, emoji, singular, plural) => {
    for (const date of [...map.keys()].sort()) {
      const names = map.get(date);
      const suffix = names.length > 1 ? plural : singular;
      lines.push(`**${emoji} ${formatDeliveryRelative(date)} — ${names.join(' + ')} ${suffix}**`);
    }
  };
  emit(drops,      '📌', 'finish drop',   'finish drops');
  emit(returns,    '🎯', 'finish return', 'finish returns');
  emit(deliveries, '🚚', 'delivery',      'deliveries');
  return lines.join('\n');
}

// Crew table: header row + per-crew rows. Multi-station continuation rows
// have blank Crew + blank Load cells. PTO-only rows use em-dash for the
// content cells (Job / Station / Hrs). Subs get "N / —" in Load and
// *(sub)* italic on Hrs.
function buildCrewTable(weekISO, plan, jobsById, timeOff, options) {
  const placements = (plan?.placements || []).filter(p => p.week === weekISO);
  const capacityGrid = plan?.capacityGrid || {};
  const timeOffForWeek = (timeOff || []).filter(t => t.week === weekISO);

  const crewSet = new Set();
  for (const p of placements) crewSet.add(p.crew);
  for (const t of timeOffForWeek) crewSet.add(t.crew);
  const crews = [...crewSet].sort();

  const rows = ['| Crew | Load | Job | Station | Hrs |', '|---|---|---|---|---|'];

  for (const crew of crews) {
    const ptoEntry = timeOffForWeek.find(t => t.crew === crew);
    const crewPlacements = placements.filter(p => p.crew === crew);

    if (ptoEntry && crewPlacements.length === 0) {
      rows.push(`| ${crew} | PTO (${ptoEntry.hours}h) | — | — | — |`);
      continue;
    }

    const slot = capacityGrid[crew]?.[weekISO];
    const isSub = isSubcontractor(crew, capacityGrid, weekISO);

    crewPlacements.forEach((p, i) => {
      const job = (jobsById || {})[p.jobId];
      const jobName = job?.name || p.jobId;
      const stationCell = abbrStation(p.station);
      const hrsCell = formatHrsCell(p, isSub, options);
      let crewCell = '', loadCell = '';
      if (i === 0) {
        crewCell = crew;
        // NB: plan JSON serializes the available-capacity field as `slot.avail`
      // (NOT `slot.available`) — see scripts/rebalance-schedule.js's runPlan
      // output shape. Reading the wrong field name was the 2026-05-25
      // Capacity View live-regen incident; the regression in
      // scripts/test-capacity-view-section.js Test 26 anchors to the
      // canonical shape via scripts/fixtures/sample-plan-snapshot.json.
      loadCell = isSub
          ? formatLoadSub(slot?.committed)
          : formatLoadRegular(slot?.committed, slot?.avail);
      }
      rows.push(`| ${crewCell} | ${loadCell} | ${jobName} | ${stationCell} | ${hrsCell} |`);
    });
  }
  return rows.join('\n');
}

// Priority order section: bold label, tier blocks with auto-scaffolded
// context, continuous numbering across tiers, item format
//   **<Crew> — <Job> <stations summary>** — delivery <DayAbbr M/D>
// Stations summary builds from the buildPriorityOrder item's stations
// array — abbreviated names joined with " + ", "(8h, pinned)" suffix when
// a station carries the pinned flag.
function buildPriorityListBlock(weekISO, plan, jobsById) {
  const tiered = buildPriorityOrder(weekISO, plan, jobsById);
  const lines = ['**Priority order (earliest downstream date first):**'];

  const tiers = [
    { key: 'highest', label: '🔴 HIGHEST', context: true  },
    { key: 'high',    label: '🟡 HIGH',    context: true  },
    { key: 'normal',  label: '🟢 NORMAL',  context: false },
  ];

  let n = 1;
  for (const t of tiers) {
    const items = tiered[t.key];
    if (!items || items.length === 0) continue;
    lines.push('');
    if (t.context) {
      const earliest = items[0]; // items already sorted by deliveryDate asc
      lines.push(`**${t.label} — ${earliest.jobName} delivery ${earliest.deliveryRelative}**`);
    } else {
      lines.push(`**${t.label}**`);
    }
    lines.push('');
    for (const item of items) {
      const stationsSummary = item.stations.map(s => {
        const abbr = abbrStation(s.station);
        const pin = s.pinned ? ', pinned' : '';
        return `${abbr} (${Number(s.hours || 0)}h${pin})`;
      }).join(' + ');
      lines.push(`${n}. **${item.crew} — ${item.jobName} ${stationsSummary}** — delivery ${item.deliveryRelative}`);
      n++;
    }
  }
  return lines.join('\n');
}

// buildWeekSection — assemble the heading + key-dates + crew table +
// priority list + trailing divider into one markdown string.
function buildWeekSection(weekISO, plan, jobsById, timeOff, options) {
  const heading      = buildHeading(weekISO, plan);
  const keyDates     = buildKeyDatesBlock(weekISO, plan, jobsById);
  const table        = buildCrewTable(weekISO, plan, jobsById, timeOff, options);
  const priorityList = buildPriorityListBlock(weekISO, plan, jobsById);

  const parts = [heading];
  if (keyDates) parts.push('', keyDates);
  parts.push('', table);
  parts.push('', priorityList);
  parts.push('', '---', '');
  return parts.join('\n');
}

// ============================================================================
// C3 — buildCapacityViewDoc (full-doc generator)
// ============================================================================
//
// Concatenates 8 weekly C2 sections with a header (generation timestamp +
// source + edit pointer) and a static symbol legend. Pure function — no
// monday I/O.
//
// Locked design (D8–D11, chat-approved):
//   D8. Rolling-window start = getMondayOfWeek(generatedAt || new Date()).
//       Single source of truth: generatedAt drives both header timestamp
//       and rolling-window start. options.generatedAt overrides for
//       deterministic tests.
//   D9. Empty weeks render full structure (heading "0.00 crew hrs" + empty
//       table + priority order label only). C2 already handles this; C3
//       just iterates and concatenates, no special-case needed.
//   D10. Header format (one line, three bullet-separated pieces):
//        **Generated:** YYYY-MM-DD HH:MM (local) • **Source:** auto-generated
//        by `scripts/run-planner.js --plan` • **Edit:** Manual Overrides
//        board (18413101550)
//        Trailing --- divider separates header from first week section.
//   D11. Legend heading = "## Legend" (not "& notes" — that suffix was
//        operator hand-added context which C3 doesn't generate). Static
//        symbol meanings only — no per-instance enumeration that would
//        drift as plan changes.

// Pad a number to two digits with a leading zero if needed.
function pad2(n) { return String(n).padStart(2, '0'); }

// Format a Date as "YYYY-MM-DD HH:MM" in LOCAL time. Operator-facing —
// the wall clock when the doc was generated. Planner internals use UTC
// for date arithmetic; this is purely human display.
function formatGeneratedAt(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ISO-Monday string for a JS Date.
function toMondayISO(d) {
  const m = getMondayOfWeek(d);
  return `${m.getUTCFullYear()}-${pad2(m.getUTCMonth() + 1)}-${pad2(m.getUTCDate())}`;
}

// Returns an array of 8 consecutive ISO-Monday strings starting at the
// Monday-of-week of `referenceDate`.
function computeRollingWindow(referenceDate) {
  const start = getMondayOfWeek(referenceDate);
  const weeks = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + 7 * i);
    weeks.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`);
  }
  return weeks;
}

function buildHeader(generatedAt) {
  return [
    `**Generated:** ${formatGeneratedAt(generatedAt)} • **Source:** auto-generated by \`scripts/run-planner.js --plan\` • **Edit:** Manual Overrides board (18413101550)`,
    '',
    '---',
    '',
  ].join('\n');
}

function buildLegend() {
  return [
    '## Legend',
    '',
    '- **Load:** `committed / available` hrs per crew per week.',
    '  - 🔴 over cap (committed > available × 1.05)',
    '  - 🟡 ≥95% (committed/available ≥ 0.95, not over)',
    '  - blank under-cap',
    '- **Pinned** *(pinned)*: placement is a `forceAssignment` from `rebalance-overrides.json` config (won\'t be re-routed).',
    '- **Subs** *(sub)*: subcontractor virtual crew, off-board work. Load shows `N / —` (no cap).',
    '- **Job dates:** 📌 finish drop • 🎯 finish return • 🚚 client delivery',
    '- **🔧:** override-driven cell from the Manual Overrides board (18413101550). The cell\'s hours come from an accepted override row at last `--plan` run.',
    '- **Refresh:** re-run `node scripts/run-planner.js --plan` to regenerate this doc.',
    '',
  ].join('\n');
}

function buildCapacityViewDoc(plan, jobsById, timeOff, options) {
  const generatedAt = options?.generatedAt || new Date();
  const acceptedOverrides = options?.acceptedOverrides || [];
  const weekOptions = { acceptedOverrides };

  const weeks = computeRollingWindow(generatedAt);
  const sections = weeks.map(weekISO =>
    buildWeekSection(weekISO, plan, jobsById, timeOff, weekOptions)
  );

  // Each section already ends with `---\n` (trailing divider from C2).
  // Concatenate header → sections → legend.
  return buildHeader(generatedAt) + sections.join('') + buildLegend();
}

// ============================================================================
// C5 — accepted-overrides → 🔧 tuple derivation
// ============================================================================
//
// Bridges validate-overrides.js's accepted rows to the acceptedOverrides
// matcher consumed by formatHrsCell. Semantics settled 2026-06-10 session
// (docs/phase-2-manual-overrides-plan.md §F.4/§F.5/§D):
//
//   - To-side rows (move / pure assign): the override drives exactly the
//     destination cell → { jobId, station, crew: toCrew, week: toWeek }.
//   - Pure-clear rows (empty To): the override drives placement via
//     crewExclusion — wrench every final-plan (crew × week) cell of this
//     (jobId × station) whose hours-sum differs from the baseline plan.
//     Unchanged cells aren't override-driven. Requires BOTH plans, so this
//     runs inside run-planner.js (C8) where both are in memory; the result
//     is persisted as validation.acceptedTuples for standalone callers.
//   - Stale-🔧 (F.5b): derivation input is the CURRENT run's accepted set.
//     A row that re-validated to Conflict is absent → its old cells lose
//     the wrench with zero extra logic.
//   - F.4: JSON forceAssignments never appear in accepted → never wrench.
//     Their marker remains *(pinned)*.
function deriveAcceptedOverrideTuples(accepted, baselinePlan, finalPlan) {
  const tuples = [];
  const seen = new Set();
  const push = (jobId, station, crew, week) => {
    const k = `${jobId}|${station}|${crew}|${week}`;
    if (seen.has(k)) return;
    seen.add(k);
    tuples.push({ jobId, station, crew, week });
  };

  // Sum a plan's placement hours for one (jobId × station), keyed crew|week.
  const sumByCell = (plan, jobId, station) => {
    const m = new Map();
    for (const p of (plan && plan.placements) || []) {
      if (String(p.jobId) !== String(jobId)) continue;
      if (p.station !== station) continue;
      const k = `${p.crew}|${p.week}`;
      m.set(k, (m.get(k) || 0) + Number(p.hours || 0));
    }
    return m;
  };

  const EPS = 1e-6;
  for (const a of accepted || []) {
    if (a.toCrew && a.toWeek) {
      push(a.jobId, a.station, a.toCrew, a.toWeek);
      continue;
    }
    // Pure clear — diff final vs baseline cells of (jobId × station).
    const base = sumByCell(baselinePlan, a.jobId, a.station);
    const fin  = sumByCell(finalPlan,    a.jobId, a.station);
    for (const [cell, hrs] of fin) {
      const b = base.get(cell);
      if (b === undefined || Math.abs(b - hrs) > EPS) {
        const sep = cell.indexOf('|');
        push(a.jobId, a.station, cell.slice(0, sep), cell.slice(sep + 1));
      }
    }
  }
  return tuples;
}

// For callers that read a persisted override-validation JSON instead of
// holding both plans in memory (the write-capacity-view.js CLI). Prefer the
// acceptedTuples array persisted by run-planner.js (C8 — full semantics
// including pure-clear diffs); fall back to a to-side-only mapping for
// pre-C8 validation files, where pure clears are skipped (the baseline
// needed to diff them isn't on disk).
function tuplesFromPersistedValidation(validation) {
  if (Array.isArray(validation && validation.acceptedTuples)) {
    return validation.acceptedTuples;
  }
  return ((validation && validation.accepted) || [])
    .filter(a => a.toCrew && a.toWeek)
    .map(a => ({ jobId: a.jobId, station: a.station, crew: a.toCrew, week: a.toWeek }));
}

module.exports = {
  buildPriorityOrder,
  buildWeekSection,
  buildCapacityViewDoc,
  deriveAcceptedOverrideTuples,
  tuplesFromPersistedValidation,
  // Exposed for C3 / C6 reuse without re-implementing.
  STATION_ABBR,
  SOFT_CAP_MULTIPLIER,
  formatGeneratedAt,
  toMondayISO,
};
