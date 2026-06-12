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

module.exports = { loadQuotePolicy, lintQuotePolicy, POLICY_PATH };
