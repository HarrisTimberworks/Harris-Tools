#!/usr/bin/env node
/**
 * scripts/diff-plans.js — JSON differ for plan JSONs saved by --plan (logs/).
 *
 * Compares two plan JSONs and reports differences in placements[] and
 * capacityGrid. Reusable in B5 (validation pipeline output checks) and B7
 * (smoke matrix verification). Task A2v from docs/phase-1-manual-overrides-plan.md.
 *
 *   CLI:   node scripts/diff-plans.js <oldPlan.json> <newPlan.json>
 *   Exit:  0 if no differences, 1 if differences (CI-friendly)
 *
 * Identity:
 *   - Placement key  = (jobId, station, crew, week). hours is the mutable field.
 *   - Capacity cell  = (crew, week). Compares numeric fields {avail, committed,
 *                      timeOff, over}; skips the denormalized `assignments` array
 *                      (already covered by placement diffs).
 *
 * The differ ignores `generatedAt` — that's why it isn't read at all.
 */

const fs = require('fs');
const path = require('path');

const PLACEMENT_KEY_FIELDS = ['jobId', 'station', 'crew', 'week'];
const CAPACITY_NUMERIC_FIELDS = ['avail', 'committed', 'timeOff', 'over'];

function placementKey(pl) {
  return PLACEMENT_KEY_FIELDS.map(f => pl[f]).join('||');
}

function diffPlacements(oldPlan, newPlan) {
  const oldByKey = new Map();
  const newByKey = new Map();
  for (const pl of oldPlan.placements || []) oldByKey.set(placementKey(pl), pl);
  for (const pl of newPlan.placements || []) newByKey.set(placementKey(pl), pl);

  const records = [];
  for (const [key, oldPl] of oldByKey) {
    if (!newByKey.has(key)) {
      records.push({
        type: 'removed',
        jobId: oldPl.jobId,
        jobName: oldPl.jobName,
        station: oldPl.station,
        crew: oldPl.crew,
        week: oldPl.week,
        oldHours: oldPl.hours,
      });
      continue;
    }
    const newPl = newByKey.get(key);
    if (oldPl.hours !== newPl.hours) {
      records.push({
        type: 'changed',
        jobId: oldPl.jobId,
        jobName: newPl.jobName ?? oldPl.jobName,
        station: oldPl.station,
        crew: oldPl.crew,
        week: oldPl.week,
        oldHours: oldPl.hours,
        newHours: newPl.hours,
      });
    }
  }
  for (const [key, newPl] of newByKey) {
    if (oldByKey.has(key)) continue;
    records.push({
      type: 'added',
      jobId: newPl.jobId,
      jobName: newPl.jobName,
      station: newPl.station,
      crew: newPl.crew,
      week: newPl.week,
      newHours: newPl.hours,
    });
  }
  return records;
}

function numericPart(cell) {
  const out = {};
  for (const f of CAPACITY_NUMERIC_FIELDS) out[f] = cell?.[f];
  return out;
}

function numericPartsEqual(a, b) {
  for (const f of CAPACITY_NUMERIC_FIELDS) {
    if ((a?.[f] ?? null) !== (b?.[f] ?? null)) return false;
  }
  return true;
}

function diffCapacityGrid(oldPlan, newPlan) {
  const oldGrid = oldPlan.capacityGrid || {};
  const newGrid = newPlan.capacityGrid || {};
  const crews = new Set([...Object.keys(oldGrid), ...Object.keys(newGrid)]);
  const records = [];

  for (const crew of crews) {
    const oldByWeek = oldGrid[crew] || {};
    const newByWeek = newGrid[crew] || {};
    const weeks = new Set([...Object.keys(oldByWeek), ...Object.keys(newByWeek)]);
    for (const week of weeks) {
      const oldCell = oldByWeek[week];
      const newCell = newByWeek[week];
      if (oldCell && !newCell) {
        records.push({ type: 'removed', crew, week, oldValue: numericPart(oldCell) });
      } else if (!oldCell && newCell) {
        records.push({ type: 'added', crew, week, newValue: numericPart(newCell) });
      } else if (!numericPartsEqual(oldCell, newCell)) {
        records.push({
          type: 'changed', crew, week,
          oldValue: numericPart(oldCell),
          newValue: numericPart(newCell),
        });
      }
    }
  }
  return records;
}

// ──────────────────────────────────────────────────────────────────────────
// CLI — thin wrapper, only runs when invoked directly.
// ──────────────────────────────────────────────────────────────────────────

function formatPlacementDiff(records) {
  if (records.length === 0) return '  (no placement differences)\n';
  const byJob = new Map();
  for (const r of records) {
    const label = `${r.jobId} — ${r.jobName || '(unknown job name)'}`;
    if (!byJob.has(label)) byJob.set(label, []);
    byJob.get(label).push(r);
  }
  let out = '';
  for (const [label, group] of [...byJob.entries()].sort()) {
    out += `  ${label}\n`;
    group.sort((a, b) => (a.week || '').localeCompare(b.week || '') || (a.station || '').localeCompare(b.station || ''));
    for (const r of group) {
      if (r.type === 'added') {
        out += `    + ${r.station} / ${r.crew} / ${r.week} — ${r.newHours}h\n`;
      } else if (r.type === 'removed') {
        out += `    − ${r.station} / ${r.crew} / ${r.week} — ${r.oldHours}h\n`;
      } else {
        out += `    ~ ${r.station} / ${r.crew} / ${r.week} — ${r.oldHours}h → ${r.newHours}h\n`;
      }
    }
  }
  return out;
}

function formatCapacityDiff(records) {
  if (records.length === 0) return '  (no capacity grid differences)\n';
  const byCrew = new Map();
  for (const r of records) {
    if (!byCrew.has(r.crew)) byCrew.set(r.crew, []);
    byCrew.get(r.crew).push(r);
  }
  let out = '';
  for (const [crew, group] of [...byCrew.entries()].sort()) {
    out += `  ${crew}\n`;
    group.sort((a, b) => (a.week || '').localeCompare(b.week || ''));
    for (const r of group) {
      if (r.type === 'added') {
        out += `    + ${r.week} — ${JSON.stringify(r.newValue)}\n`;
      } else if (r.type === 'removed') {
        out += `    − ${r.week} — ${JSON.stringify(r.oldValue)}\n`;
      } else {
        const changes = CAPACITY_NUMERIC_FIELDS
          .filter(f => (r.oldValue?.[f] ?? null) !== (r.newValue?.[f] ?? null))
          .map(f => `${f}: ${r.oldValue?.[f]} → ${r.newValue?.[f]}`)
          .join(', ');
        out += `    ~ ${r.week} — ${changes}\n`;
      }
    }
  }
  return out;
}

function runCli(argv) {
  const args = argv.slice(2);
  if (args.length !== 2) {
    console.error('Usage: node scripts/diff-plans.js <oldPlan.json> <newPlan.json>');
    process.exit(2);
  }
  const [oldPath, newPath] = args;
  const oldPlan = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
  const newPlan = JSON.parse(fs.readFileSync(newPath, 'utf8'));

  const placementDiff = diffPlacements(oldPlan, newPlan);
  const capacityDiff  = diffCapacityGrid(oldPlan, newPlan);

  console.log(`Diff: ${path.basename(oldPath)}  →  ${path.basename(newPath)}`);
  console.log(`  generatedAt(old): ${oldPlan.generatedAt}`);
  console.log(`  generatedAt(new): ${newPlan.generatedAt}`);
  console.log('');
  console.log(`PLACEMENTS (${placementDiff.length} difference${placementDiff.length === 1 ? '' : 's'}):`);
  process.stdout.write(formatPlacementDiff(placementDiff));
  console.log('');
  console.log(`CAPACITY GRID (${capacityDiff.length} difference${capacityDiff.length === 1 ? '' : 's'}):`);
  process.stdout.write(formatCapacityDiff(capacityDiff));

  const total = placementDiff.length + capacityDiff.length;
  console.log('');
  console.log(total === 0 ? '✅ Plans agree.' : `❌ ${total} total difference(s).`);
  process.exit(total === 0 ? 0 : 1);
}

module.exports = { diffPlacements, diffCapacityGrid };

if (require.main === module) runCli(process.argv);
