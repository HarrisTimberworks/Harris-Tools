// AUDIT FIX (2026-06-11) — config lint.
//
// config/rebalance-overrides.json was trusted blindly: a typo'd jobId, the
// 'station' (singular) key instead of 'stations', a non-Monday week, or an
// unknown crew all silently no-op'd — the 'stations' one bit a live
// rebalance the same day this lint was written. validateOverridesConfig
// runs at the top of every --plan and reports loudly; it never blocks the
// run (surfacing is the job — historical garbage shouldn't stop production).
//
// errors   = entries that cannot possibly take effect (silent no-ops).
// warnings = suspicious but possibly intentional (past weeks, stale ids).

const { parseISO } = require('./rebalance-schedule.js');

function isMonday(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return false;
  return parseISO(iso).getUTCDay() === 1;
}

// cfg: the parsed overrides JSON.
// context: { jobIds: Set/array of valid PL job ids, crews: Set/array of
//            valid crew names (board crew parents + subcontractor pool
//            names), todayISO: 'YYYY-MM-DD' (for past-week warnings),
//            effectiveWeek: 'YYYY-MM-DD' (for stale-customWindow warnings;
//            absent → check skipped for back-compat) }
function validateOverridesConfig(cfg, context = {}) {
  const errors = [];
  const warnings = [];
  const jobIds = new Set([...(context.jobIds || [])].map(String));
  const crews = new Set([...(context.crews || [])].map(String));
  const todayISO = context.todayISO || null;
  const effectiveWeek = context.effectiveWeek || null;

  (cfg.forceAssignments || []).forEach((f, i) => {
    const tag = `forceAssignments[${i}] (${f.crew || '?'} / ${f.jobId || '?'} / ${f.week || '?'})`;
    if ('station' in f && !('stations' in f)) {
      errors.push(`${tag}: uses singular 'station' key — the planner matches 'stations' (array); this entry silently no-ops`);
    }
    if (!Array.isArray(f.stations) || f.stations.length === 0) {
      if (!('station' in f)) errors.push(`${tag}: missing/empty 'stations' array — silently no-ops`);
    }
    if (jobIds.size && f.jobId !== undefined && !jobIds.has(String(f.jobId))) {
      errors.push(`${tag}: jobId not found on the Production Load board — silently no-ops`);
    }
    if (crews.size && f.crew && !crews.has(String(f.crew))) {
      errors.push(`${tag}: unknown crew '${f.crew}' — silently no-ops`);
    }
    if (!isMonday(f.week)) {
      errors.push(`${tag}: week '${f.week}' is not a Monday — the placement loop keys on Monday-of-week; silently no-ops`);
    } else if (todayISO && f.week < todayISO) {
      warnings.push(`${tag}: week is in the past — skipped at plan time (candidate for cleanup)`);
    }
  });

  for (const [id, j] of Object.entries(cfg.jobOverrides || {})) {
    if (jobIds.size && !jobIds.has(String(id))) {
      warnings.push(`jobOverrides['${id}'] (${j.name || 'unnamed'}): id not found on the Production Load board — stale entry, has no effect`);
    }
    for (const [station, w] of Object.entries(j.customWindow || {})) {
      if (w && w.start && !isMonday(w.start)) {
        errors.push(`jobOverrides['${id}'].customWindow.${station}: start '${w.start}' is not a Monday — locked convention (2026-05-17): non-Monday starts silently fail placement`);
      }
      // Task 11 (2026-06-12): stale stop-gap detection — warn when the window
      // has entirely passed the effective planning week. Check only when
      // effectiveWeek is provided (absent → back-compat, skip the check).
      if (effectiveWeek && w && w.end && w.end < effectiveWeek) {
        warnings.push(`jobOverrides[${id}].customWindow.${station} is entirely in the past (ended ${w.end}, effective week ${effectiveWeek}) — stale stop-gap?`);
      }
    }
  }

  (cfg.skipJobs || []).forEach(id => {
    if (jobIds.size && !jobIds.has(String(id))) {
      warnings.push(`skipJobs '${id}': id not found on the Production Load board — stale entry`);
    }
  });

  for (const [week, crewsObj] of Object.entries(cfg.crewCapacityOverrides || {})) {
    if (!isMonday(week)) {
      errors.push(`crewCapacityOverrides['${week}']: key is not a Monday — never matched by the grid`);
    }
    for (const crew of Object.keys(crewsObj || {})) {
      if (crews.size && !crews.has(crew)) {
        errors.push(`crewCapacityOverrides['${week}'].${crew}: unknown crew — silently no-ops`);
      }
    }
  }

  return { errors, warnings };
}

module.exports = { validateOverridesConfig, isMonday };
