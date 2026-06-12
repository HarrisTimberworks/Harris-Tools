#!/usr/bin/env node
/**
 * Quote engine — Lead Time Calculator V2 (spec docs/superpowers/specs/2026-06-12-lead-time-calculator-design.md).
 * READS ONLY: fresh board fetch + pure in-memory planning. Every monday
 * mutation lives in planner-trigger.js's quote handler; every file write
 * lives in write-lead-times.js. The planner is reachable ONLY through
 * quoteRunPlan(), which hard-codes savePath:null (the 2026-05-25 incident
 * class: a what-if plan must never overwrite the file --execute deploys).
 */
const fs = require('fs');
const path = require('path');
const {
  loadAll, runPlan, ROUTING, findMissingCrewParents,
  getMondayOfWeek, parseISO, toISO, addDays,
  CREW_BASE_HOURS, BOB_START_DATE, CREW_END_DATES,
} = require('./rebalance-schedule.js');
const { JOB_TYPES, computeQuoteHours, normalizeComplexity } = require('./quote-hours-model.js');

const POLICY_PATH = path.join(__dirname, '..', 'config', 'quote-policy.json');

function lintQuotePolicy(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return ['quote-policy: not an object'];
  if (!Number.isInteger(p.preProductionWeeks) || p.preProductionWeeks < 0) {
    errors.push(`quote-policy: preProductionWeeks must be a non-negative integer (got ${JSON.stringify(p.preProductionWeeks)})`);
  }
  if (!p.minLeadWeeks || typeof p.minLeadWeeks !== 'object') {
    errors.push('quote-policy: minLeadWeeks missing');
  } else {
    for (const [k, v] of Object.entries(p.minLeadWeeks)) {
      if (!ROUTING[k]) errors.push(`quote-policy: minLeadWeeks key '${k}' is not a planner ROUTING key (valid: ${Object.keys(ROUTING).join(' | ')})`);
      if (!Number.isInteger(v) || v < 0) errors.push(`quote-policy: minLeadWeeks['${k}'] must be a non-negative integer`);
    }
    for (const jt of Object.keys(JOB_TYPES)) {
      if (!(jt in p.minLeadWeeks)) errors.push(`quote-policy: minLeadWeeks missing entry for '${jt}'`);
    }
  }
  if (!Number.isInteger(p.defaultFinishingDays) || p.defaultFinishingDays < 0) {
    errors.push('quote-policy: defaultFinishingDays must be a non-negative integer');
  }
  if (!Array.isArray(p.referenceBasket)) {
    errors.push('quote-policy: referenceBasket must be an array');
  } else {
    p.referenceBasket.forEach((b, i) => {
      if (!JOB_TYPES[b.jobType]) errors.push(`quote-policy: referenceBasket[${i}].jobType '${b.jobType}' unknown`);
      if (!(b.boxes >= 1)) errors.push(`quote-policy: referenceBasket[${i}].boxes must be >= 1`);
      if (normalizeComplexity(b.complexity) === null) errors.push(`quote-policy: referenceBasket[${i}].complexity invalid`);
    });
  }
  return errors;
}

function loadQuotePolicy({ fsImpl = fs, policyPath = POLICY_PATH } = {}) {
  const raw = fsImpl.readFileSync(policyPath, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    throw new Error(`quote-policy: ${policyPath} is not valid JSON — ${e.message}`);
  }
  const errors = lintQuotePolicy(parsed);
  if (errors.length) throw new Error(`quote-policy lint failed:\n  ${errors.join('\n  ')}`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Synthetic job + parents + the ONLY door to the planner
// ---------------------------------------------------------------------------

// Spec §4.1: every field is load-bearing. `status` keeps the job inside
// runPlan's activeJobs filter (a status-less job is SILENTLY DROPPED and every
// candidate week looks feasible). `id` flows into placements.jobId (the
// feasibility filter) and the OVERRIDES.skipJobs check.
function buildSyntheticJob(input, policy, deliveryWeekISO) {
  const { hours, complexityUsed } = computeQuoteHours(input.jobType, input.boxes, input.complexity);
  return {
    id: `QUOTE-${input.rowId}`,
    name: `QUOTE - ${input.name || input.rowId}`,
    status: 'Scheduled',
    subtype: input.jobType,           // dropdown labels ARE ROUTING keys (spec §2)
    delivery: deliveryWeekISO,
    hours,
    finishingDays: policy.defaultFinishingDays,
    pLam: false,
    masterPmId: null,
    customWindow: null,
    _complexityUsed: complexityUsed,
  };
}

// runPlan process.exit(1)s on missing Crew Allocation parent rows; board rows
// are pre-generated only through 2026-12-28 and a deep candidate walk crosses
// that TODAY (spec §4.1 horizon). Inject in-memory parents for every missing
// (crew × week) over a SUPERSET of runPlan's horizon — superset because
// runPlan computes its own window (max(maxDelivery+28d, today+84d)) and ours
// must cover it; extra parents are simply unused. Pure data, never written.
function withSyntheticParents(boards, syntheticJob, { now = () => new Date() } = {}) {
  const deliveries = boards.jobs.map(j => j.delivery).filter(Boolean);
  if (syntheticJob?.delivery) deliveries.push(syntheticJob.delivery);
  const maxDelivery = deliveries.length ? deliveries.reduce((m, d) => (d > m ? d : m)) : null;
  const startWeek = toISO(getMondayOfWeek(now()));
  const endA = maxDelivery ? toISO(getMondayOfWeek(addDays(parseISO(maxDelivery), 35))) : null;
  const endB = toISO(getMondayOfWeek(addDays(now(), 91)));
  const endWeek = endA && endA > endB ? endA : endB;

  const weeks = [];
  for (let w = startWeek; w <= endWeek; w = toISO(addDays(parseISO(w), 7))) weeks.push(w);

  const missing = findMissingCrewParents({
    crewParents: boards.crewParents,
    weeks,
    crews: Object.keys(CREW_BASE_HOURS),
    subcontractorNames: new Set(),
    crewStartDates: { Bob: BOB_START_DATE },
    crewEndDates: CREW_END_DATES,
  });
  let n = 0;
  const synthetic = missing.map(m => ({
    parentId: `synthetic-${++n}`,
    week: m.week,
    crew: m.crew,
    base: CREW_BASE_HOURS[m.crew] ?? 0,
    timeOff: 0,
    nonProd: 0,
  }));
  return [...boards.crewParents, ...synthetic];
}

// The ONLY call site of runPlan in quote code. savePath:null is hard-coded —
// do NOT add a savePath parameter, ever (2026-05-25 incident class; spec §4.1
// + test-quote-engine.js Test 7 enforce this).
async function quoteRunPlan(boards, syntheticJob, { runPlanFn = runPlan, now = () => new Date() } = {}) {
  const jobs = syntheticJob ? [...boards.jobs, syntheticJob] : boards.jobs;
  const crewParents = withSyntheticParents(boards, syntheticJob, { now });
  return runPlanFn({ ...boards, jobs, crewParents }, { savePath: null });
}

// ---------------------------------------------------------------------------
// Feasibility: candidate run vs baseline run (spec §4.1 step 3)
// ---------------------------------------------------------------------------
// Expected placement total = station hours + 4 (the planner places Pack & Ship
// and Delivery as flat 2h each in the delivery week).
function assessCandidate(baseline, candidate, syntheticJob) {
  const reasons = [];
  const expected = Object.values(syntheticJob.hours).reduce((s, h) => s + h, 0) + 4;
  const placed = (candidate.placements || [])
    .filter(p => p.jobId === syntheticJob.id)
    .reduce((s, p) => s + (p.hours || 0), 0);
  if (placed + 0.01 < expected) {
    reasons.push(`only ${Number(placed.toFixed(1))}h of ${Number(expected.toFixed(1))}h placed`);
  }
  for (const w of candidate.warnings || []) {
    if (String(w).includes(syntheticJob.name)) reasons.push(String(w));
  }
  // Strict no-worse-than-baseline (diff key crew × week): a quote must not
  // deepen ANY existing overload. Missing baseline slot ⇒ baseline over = 0.
  for (const [crew, weeksObj] of Object.entries(candidate.capacityGrid || {})) {
    for (const [week, slot] of Object.entries(weeksObj)) {
      const baseOver = baseline.capacityGrid?.[crew]?.[week]?.over || 0;
      if ((slot.over || 0) > baseOver + 0.01) {
        reasons.push(`over-cap: ${crew} w/o ${week} — committed ${slot.committed}/${slot.avail}h (over by ${slot.over}h, baseline ${baseOver}h)`);
      }
    }
  }
  return { feasible: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Walk + modes + policy floor (spec §3, §4.1 steps 3-6, §4.4 outcome table)
// ---------------------------------------------------------------------------
const WALK_CAP_WEEKS = 26;

function mondayOnOrAfter(dateISO) {
  const monday = toISO(getMondayOfWeek(parseISO(dateISO)));
  return monday === dateISO ? dateISO : toISO(addDays(parseISO(monday), 7));
}

function validateQuoteInput(raw, policy) {
  const boxes = Number(raw.boxes);
  if (!Number.isFinite(boxes) || boxes < 1) {
    return { ok: false, reason: `Boxes must be a number ≥ 1 (got '${raw.boxes ?? ''}')` };
  }
  if (!JOB_TYPES[raw.jobType]) {
    return { ok: false, reason: `Job Type '${raw.jobType ?? ''}' not recognized — valid: ${Object.keys(JOB_TYPES).join(' | ')}` };
  }
  const complexity = (raw.complexity === '' || raw.complexity === null || raw.complexity === undefined) ? 2 : raw.complexity;
  if (normalizeComplexity(complexity) === null) {
    return { ok: false, reason: `Complexity '${raw.complexity}' must round to an integer 1-5` };
  }
  if (raw.targetDate) {
    const walkStart = mondayOnOrAfter(toISO(addDays(new Date(), policy.preProductionWeeks * 7)));
    const targetWeek = toISO(getMondayOfWeek(parseISO(raw.targetDate)));
    if (targetWeek < walkStart) {
      return { ok: false, reason: `Target ${raw.targetDate} is in the past or inside the ${policy.preProductionWeeks}-week pre-production window (earliest quotable week: ${walkStart})` };
    }
  }
  return { ok: true, input: { ...raw, boxes: Math.round(boxes), complexity } };
}

// One quote, end to end. Caller supplies boards (fresh loadAll() in
// production; fixtures in tests). Returns the result object consumed by the
// trigger writeback and the lead-times writer — NEVER mutates anything.
async function runQuote(rawInput, { boards, policy, now = () => new Date(), runPlanFn } = {}) {
  const v = validateQuoteInput(rawInput, policy);
  if (!v.ok) return { ok: false, reason: v.reason };
  const input = v.input;
  const opts = runPlanFn ? { runPlanFn, now } : { now };

  const baseline = await quoteRunPlan(boards, null, opts);
  const walkStart = mondayOnOrAfter(toISO(addDays(now(), policy.preProductionWeeks * 7)));
  const floorWeek = mondayOnOrAfter(toISO(addDays(now(), policy.minLeadWeeks[input.jobType] * 7)));

  const tryWeek = async (week) => {
    const job = buildSyntheticJob(input, policy, week);
    const report = await quoteRunPlan(boards, job, opts);
    return { job, ...assessCandidate(baseline, report, job) };
  };

  // Earliest-feasible walk (linear, capped — feasibility is not assumed
  // monotone, first clean fit wins; spec §4.1 step 3). Also runs in target
  // mode (deliberate cheap extension, spec §4.1 step 4) so capacityWeek means
  // the same thing in both modes.
  let capacityWeek = null;
  let lastFail = null;
  for (let i = 0; i < WALK_CAP_WEEKS; i++) {
    const week = toISO(addDays(parseISO(walkStart), i * 7));
    const t = await tryWeek(week);
    if (t.feasible) { capacityWeek = week; break; }
    lastFail = t;
  }
  if (!capacityWeek) {
    return { ok: false, reason: `does not fit within ${WALK_CAP_WEEKS} weeks — last blocker: ${lastFail?.reasons?.[0] || 'unknown'}` };
  }

  const common = {
    ok: true,
    inputs: { jobType: input.jobType, boxes: input.boxes, complexity: input.complexity,
              complexityUsed: normalizeComplexity(input.complexity), targetDate: input.targetDate || null },
    hours: buildSyntheticJob(input, policy, capacityWeek).hours,
    capacityWeek, floorWeek,
    dataFreshness: now().toISOString(),
    policy: { preProductionWeeks: policy.preProductionWeeks, minLeadWeeks: policy.minLeadWeeks[input.jobType] },
  };

  if (!input.targetDate) {
    return { ...common, mode: 'earliest', verdict: 'EARLIEST',
      quotedWeek: capacityWeek > floorWeek ? capacityWeek : floorWeek, bottleneck: null };
  }

  const targetWeek = toISO(getMondayOfWeek(parseISO(input.targetDate)));
  const t = await tryWeek(targetWeek);
  if (t.feasible) {
    if (targetWeek >= floorWeek) {
      return { ...common, mode: 'target', verdict: 'FITS', quotedWeek: targetWeek, targetWeek, bottleneck: null };
    }
    return { ...common, mode: 'target', verdict: 'FITS_BELOW_FLOOR',
      quotedWeek: targetWeek > floorWeek ? targetWeek : floorWeek, targetWeek, bottleneck: null };
  }
  return { ...common, mode: 'target', verdict: 'DOES_NOT_FIT',
    quotedWeek: capacityWeek > floorWeek ? capacityWeek : floorWeek, targetWeek,
    bottleneck: t.reasons[0] || 'unknown constraint' };
}

function buildQuoteUpdate(res) {
  const lines = [];
  if (res.mode === 'earliest') {
    lines.push(`**Quote: deliver w/o ${res.quotedWeek}**`);
  } else if (res.verdict === 'FITS') {
    lines.push(`**${res.targetWeek} — FITS** ✅`);
  } else if (res.verdict === 'FITS_BELOW_FLOOR') {
    lines.push(`**${res.targetWeek} — fits capacity, but below the policy floor (${res.policy.minLeadWeeks} wks)** — quote w/o ${res.quotedWeek} unless deliberately overriding.`);
  } else {
    lines.push(`**${res.targetWeek} — DOES NOT FIT** ❌`);
    lines.push(`Blocker: ${res.bottleneck}`);
    lines.push(`Earliest that fits: w/o ${res.capacityWeek}`);
  }
  lines.push('');
  lines.push(`Capacity says earliest: **w/o ${res.capacityWeek}** · policy floor: **w/o ${res.floorWeek}** (${res.policy.minLeadWeeks} wks min) → quoted: **w/o ${res.quotedWeek}**`);
  lines.push(`Inputs: ${res.inputs.jobType}, ${res.inputs.boxes} boxes, complexity ${res.inputs.complexityUsed}${res.inputs.complexity !== res.inputs.complexityUsed ? ` (rounded from ${res.inputs.complexity})` : ''}. Defaults: finishing days, no inset/P-Lam/miter-fold/countertop/backsplash.`);
  lines.push(`Station hours: Eng ${res.hours.eng} · Panel ${res.hours.panel} · Bench ${res.hours.bench} · PreFin ${res.hours.prefin} · PostFin ${res.hours.postfin}. Pre-production ${res.policy.preProductionWeeks} wks included.`);
  lines.push(`Board data as of ${res.dataFreshness}.`);
  lines.push('');
  lines.push('_Confirm with PM before communicating to clients._');
  return lines.join('\n');
}

module.exports = { loadQuotePolicy, lintQuotePolicy, POLICY_PATH, buildSyntheticJob, withSyntheticParents, quoteRunPlan, assessCandidate, mondayOnOrAfter, validateQuoteInput, runQuote, buildQuoteUpdate, WALK_CAP_WEEKS };
