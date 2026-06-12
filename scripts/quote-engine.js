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

module.exports = { loadQuotePolicy, lintQuotePolicy, POLICY_PATH, buildSyntheticJob, withSyntheticParents, quoteRunPlan };
