#!/usr/bin/env node
/**
 * Quote hours model — Lead Time Calculator V2 (spec §4.1).
 * THE single home of station-hour factors for hypothetical quote jobs.
 * Factors mirror the LIVE Production Load Board formula columns (board
 * 18407601557) — NOT docs/htw-production-system-handoff.md, which was stale
 * on Panel FF (0.38 vs live 0.55, corrected 2026-06-12). Drift is guarded by
 * test-quote-hours-model.js against scripts/fixtures/plb-formulas.json;
 * recapture instructions live in that test file.
 *
 * Quote defaults (everything not in the pure-minimal input set is zero/off):
 * miter fold, countertop SF, PP override, backsplash, CU overrides, slab
 * veneer doors, SW nosing, inset (mult 1.0), P-Lam (off).
 */
const { ROUTING } = require('./rebalance-schedule.js');

// Keys ARE the planner ROUTING keys, verbatim — one vocabulary (spec §2).
const JOB_TYPES = {
  'Res - Face Frame': { boxType: 'FF', display: 'Face frame' },
  'Res - Frameless':  { boxType: 'FL', display: 'Frameless' },
  'Commercial':       { boxType: 'FL', display: 'Commercial' }, // commercial casework is frameless construction
};
for (const k of Object.keys(JOB_TYPES)) {
  if (!ROUTING[k]) throw new Error(`quote-hours-model: job type '${k}' is not a planner ROUTING key`);
}

const COMPLEXITY_MULT = { 1: 0.8, 2: 1.0, 3: 1.15, 4: 1.4, 5: 1.75 };

const STATION_FACTORS = {
  eng:     { FF: 0.6,  FL: 0.4 },
  panel:   { FF: 0.55, FL: 0.55 },
  bench:   { FF: 0.3,  FL: 0.15 },
  prefin:  { FF: 1.10, FL: 0 },
  postfin: { FF: 0.45, FL: 0.65 },
};

// monday number columns accept non-integers; round-half-up then bounds-check
// (spec §4.4). Returns the integer 1-5 or null (caller turns null into a
// named validation error).
function normalizeComplexity(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || raw === '' || raw === null || raw === undefined) return null;
  const rounded = Math.round(n);
  return rounded >= 1 && rounded <= 5 ? rounded : null;
}

function computeQuoteHours(jobType, boxes, complexity) {
  const jt = JOB_TYPES[jobType];
  if (!jt) throw new Error(`unknown job type '${jobType}' — valid: ${Object.keys(JOB_TYPES).join(' | ')}`);
  const c = normalizeComplexity(complexity);
  if (c === null) throw new Error(`complexity '${complexity}' invalid — must round to an integer 1-5`);
  const mult = COMPLEXITY_MULT[c];
  const hours = {};
  for (const [station, f] of Object.entries(STATION_FACTORS)) {
    hours[station] = Number((f[jt.boxType] * boxes * mult).toFixed(1));
  }
  return { hours, complexityUsed: c, boxType: jt.boxType };
}

module.exports = { JOB_TYPES, COMPLEXITY_MULT, STATION_FACTORS, computeQuoteHours, normalizeComplexity };
