#!/usr/bin/env node
/**
 * Tests for scripts/diff-plans.js — the reusable plan JSON differ (task A2v).
 *
 * Uses synthetic plan JSON fixtures (no live monday calls). Asserts that
 *   diffPlacements(oldPlan, newPlan)  → [] when plans agree, populated otherwise
 *   diffCapacityGrid(oldPlan, newPlan) → [] when plans agree, populated otherwise
 *
 * Placement identity = (jobId, station, crew, week). Hours is the mutable field
 * for a given key. Different order is not a difference (set-equality, not
 * list-equality). The differ ignores `generatedAt`.
 *
 * Capacity-grid identity = (crew, week). The cell's diff-worthy fields are the
 * numeric ones: avail, committed, timeOff, over. The `assignments` sub-array
 * is denormalized from placements, so the differ skips it.
 */

const { diffPlacements, diffCapacityGrid } = require('./diff-plans.js');

let checks = 0;
const failures = [];
function check(label, cond, detail) {
  checks++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}: ${detail}`);
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers to build synthetic plan JSON shaped like the real plan logs.
// ──────────────────────────────────────────────────────────────────────────

function p(jobId, jobName, station, crew, week, hours, extra = {}) {
  return { jobId, jobName, station, crew, week, hours, ...extra };
}

function cell(avail, committed, timeOff = 0, over = 0) {
  return { avail, committed, timeOff, over, assignments: [] };
}

function makePlan({ placements = [], capacityGrid = {}, generatedAt = '2026-05-19T00:00:00Z' } = {}) {
  return { generatedAt, placements, capacityGrid };
}

// ──────────────────────────────────────────────────────────────────────────
// diffPlacements
// ──────────────────────────────────────────────────────────────────────────

console.log('Test 1: identical plans → empty placement diff');
{
  const placements = [
    p('J1', 'Quince', 'Engineering', 'Chris', '2026-05-18', 8),
    p('J1', 'Quince', 'Benchwork',   'Bob',   '2026-05-25', 16),
  ];
  const old = makePlan({ placements });
  const neu = makePlan({ placements: [...placements] });
  const diff = diffPlacements(old, neu);
  check('returns empty array', Array.isArray(diff) && diff.length === 0,
        `got ${JSON.stringify(diff)}`);
}

console.log('\nTest 2: added placement (in new, not in old)');
{
  const old = makePlan({ placements: [
    p('J1', 'Quince', 'Engineering', 'Chris', '2026-05-18', 8),
  ]});
  const neu = makePlan({ placements: [
    p('J1', 'Quince', 'Engineering', 'Chris', '2026-05-18', 8),
    p('J1', 'Quince', 'Benchwork',   'Bob',   '2026-05-25', 16),
  ]});
  const diff = diffPlacements(old, neu);
  check('exactly one diff record', diff.length === 1, `got ${diff.length}`);
  check('type=added', diff[0]?.type === 'added', `type=${diff[0]?.type}`);
  check('identifies the added placement', diff[0]?.jobId === 'J1' && diff[0]?.crew === 'Bob' && diff[0]?.week === '2026-05-25' && diff[0]?.station === 'Benchwork',
        JSON.stringify(diff[0]));
  check('records newHours', diff[0]?.newHours === 16, `newHours=${diff[0]?.newHours}`);
}

console.log('\nTest 3: removed placement (in old, not in new)');
{
  const old = makePlan({ placements: [
    p('J1', 'Quince', 'Engineering', 'Chris', '2026-05-18', 8),
    p('J1', 'Quince', 'Benchwork',   'Bob',   '2026-05-25', 16),
  ]});
  const neu = makePlan({ placements: [
    p('J1', 'Quince', 'Engineering', 'Chris', '2026-05-18', 8),
  ]});
  const diff = diffPlacements(old, neu);
  check('exactly one diff record', diff.length === 1, `got ${diff.length}`);
  check('type=removed', diff[0]?.type === 'removed', `type=${diff[0]?.type}`);
  check('records oldHours', diff[0]?.oldHours === 16, `oldHours=${diff[0]?.oldHours}`);
}

console.log('\nTest 4: changed hours on same (jobId, station, crew, week) key');
{
  const old = makePlan({ placements: [
    p('J1', 'Quince', 'Benchwork', 'Bob', '2026-05-25', 16),
  ]});
  const neu = makePlan({ placements: [
    p('J1', 'Quince', 'Benchwork', 'Bob', '2026-05-25', 12),
  ]});
  const diff = diffPlacements(old, neu);
  check('exactly one diff record', diff.length === 1, `got ${diff.length}`);
  check('type=changed', diff[0]?.type === 'changed', `type=${diff[0]?.type}`);
  check('oldHours=16', diff[0]?.oldHours === 16, `oldHours=${diff[0]?.oldHours}`);
  check('newHours=12', diff[0]?.newHours === 12, `newHours=${diff[0]?.newHours}`);
}

console.log('\nTest 5: same placements in different order → empty diff (set-equality)');
{
  const a = p('J1', 'Quince', 'Engineering', 'Chris', '2026-05-18', 8);
  const b = p('J1', 'Quince', 'Benchwork',   'Bob',   '2026-05-25', 16);
  const c = p('J2', 'SHI',    'Engineering', 'Chris', '2026-06-01', 4);
  const old = makePlan({ placements: [a, b, c] });
  const neu = makePlan({ placements: [c, a, b] });
  const diff = diffPlacements(old, neu);
  check('empty diff regardless of order', diff.length === 0, JSON.stringify(diff));
}

console.log('\nTest 6: empty plans → empty diff');
{
  const old = makePlan({ placements: [] });
  const neu = makePlan({ placements: [] });
  const diff = diffPlacements(old, neu);
  check('empty diff', diff.length === 0, JSON.stringify(diff));
}

console.log('\nTest 7: ignores generatedAt timestamp');
{
  const placements = [p('J1', 'Quince', 'Benchwork', 'Bob', '2026-05-25', 16)];
  const old = makePlan({ placements, generatedAt: '2026-05-08T12:00:00Z' });
  const neu = makePlan({ placements: [...placements], generatedAt: '2026-05-19T18:30:00Z' });
  const diff = diffPlacements(old, neu);
  check('empty diff despite different timestamps', diff.length === 0, JSON.stringify(diff));
}

console.log('\nTest 8: A2-style window shift surfaces as removed-old-week + added-new-week');
{
  // Real-world A2 case: a job's Pre-Fin window shifts from week-of-5/18 to
  // week-of-5/25. Identity key changes (week differs), so we expect ONE removed
  // record for the old week + ONE added record for the new week.
  const old = makePlan({ placements: [
    p('J7', 'Quince Ave', 'Pre Fin Cab Assembly', 'Bob', '2026-05-18', 32),
  ]});
  const neu = makePlan({ placements: [
    p('J7', 'Quince Ave', 'Pre Fin Cab Assembly', 'Bob', '2026-05-25', 32),
  ]});
  const diff = diffPlacements(old, neu);
  check('two diff records (one removed + one added)', diff.length === 2, `got ${diff.length}`);
  const removed = diff.find(d => d.type === 'removed');
  const added   = diff.find(d => d.type === 'added');
  check('removed record on old week', removed?.week === '2026-05-18', JSON.stringify(removed));
  check('added record on new week',   added?.week === '2026-05-25',   JSON.stringify(added));
  check('both reference same jobId', removed?.jobId === 'J7' && added?.jobId === 'J7',
        `removed.jobId=${removed?.jobId}, added.jobId=${added?.jobId}`);
}

// ──────────────────────────────────────────────────────────────────────────
// diffCapacityGrid
// ──────────────────────────────────────────────────────────────────────────

console.log('\nTest 9: identical capacity grids → empty diff');
{
  const grid = { Chris: { '2026-05-18': cell(15, 5) } };
  const old = makePlan({ capacityGrid: grid });
  const neu = makePlan({ capacityGrid: JSON.parse(JSON.stringify(grid)) });
  const diff = diffCapacityGrid(old, neu);
  check('empty diff', diff.length === 0, JSON.stringify(diff));
}

console.log('\nTest 10: changed committed value on existing (crew × week) cell');
{
  const old = makePlan({ capacityGrid: {
    Chris: { '2026-05-18': cell(15, 5) },
  }});
  const neu = makePlan({ capacityGrid: {
    Chris: { '2026-05-18': cell(15, 8) },
  }});
  const diff = diffCapacityGrid(old, neu);
  check('exactly one diff record', diff.length === 1, `got ${diff.length}`);
  check('type=changed', diff[0]?.type === 'changed', `type=${diff[0]?.type}`);
  check('crew=Chris',  diff[0]?.crew === 'Chris',    `crew=${diff[0]?.crew}`);
  check('week=2026-05-18', diff[0]?.week === '2026-05-18', `week=${diff[0]?.week}`);
  check('oldValue.committed=5', diff[0]?.oldValue?.committed === 5, JSON.stringify(diff[0]?.oldValue));
  check('newValue.committed=8', diff[0]?.newValue?.committed === 8, JSON.stringify(diff[0]?.newValue));
}

console.log('\nTest 11: changed avail/timeOff/over also surface');
{
  const old = makePlan({ capacityGrid: {
    Chris: { '2026-05-18': cell(15, 5, 0, 0) },
  }});
  const neu = makePlan({ capacityGrid: {
    Chris: { '2026-05-18': cell(20, 5, 8, 0) },  // avail and timeOff changed
  }});
  const diff = diffCapacityGrid(old, neu);
  check('one diff record (any numeric field change counts)', diff.length === 1, `got ${diff.length}`);
  check('oldValue.avail=15',   diff[0]?.oldValue?.avail === 15,   JSON.stringify(diff[0]?.oldValue));
  check('newValue.avail=20',   diff[0]?.newValue?.avail === 20,   JSON.stringify(diff[0]?.newValue));
  check('newValue.timeOff=8',  diff[0]?.newValue?.timeOff === 8,  JSON.stringify(diff[0]?.newValue));
}

console.log('\nTest 12: capacityGrid ignores assignments sub-array (denormalized from placements)');
{
  // Two cells with identical numeric fields but different `assignments` arrays
  // should not be flagged — `assignments` is derived from `placements[]`, which
  // diffPlacements already handles. Including it would double-report.
  const old = makePlan({ capacityGrid: {
    Chris: { '2026-05-18': { avail: 15, committed: 5, timeOff: 0, over: 0,
                              assignments: [{ job: 'Quince', station: 'Eng', hours: 5 }] } },
  }});
  const neu = makePlan({ capacityGrid: {
    Chris: { '2026-05-18': { avail: 15, committed: 5, timeOff: 0, over: 0,
                              assignments: [{ job: 'SHI', station: 'Eng', hours: 5 }] } },
  }});
  const diff = diffCapacityGrid(old, neu);
  check('empty diff (assignments ignored)', diff.length === 0, JSON.stringify(diff));
}

console.log('\nTest 13: added (crew × week) cell present only in new plan');
{
  const old = makePlan({ capacityGrid: { Chris: { '2026-05-18': cell(15, 5) } } });
  const neu = makePlan({ capacityGrid: {
    Chris: { '2026-05-18': cell(15, 5), '2026-05-25': cell(15, 10) },
  }});
  const diff = diffCapacityGrid(old, neu);
  check('exactly one diff record', diff.length === 1, `got ${diff.length}`);
  check('type=added', diff[0]?.type === 'added', `type=${diff[0]?.type}`);
  check('week=2026-05-25', diff[0]?.week === '2026-05-25', `week=${diff[0]?.week}`);
}

console.log('\nTest 14: removed (crew × week) cell present only in old plan');
{
  const old = makePlan({ capacityGrid: {
    Chris: { '2026-05-18': cell(15, 5), '2026-05-25': cell(15, 10) },
  }});
  const neu = makePlan({ capacityGrid: { Chris: { '2026-05-18': cell(15, 5) } } });
  const diff = diffCapacityGrid(old, neu);
  check('exactly one diff record', diff.length === 1, `got ${diff.length}`);
  check('type=removed', diff[0]?.type === 'removed', `type=${diff[0]?.type}`);
  check('week=2026-05-25', diff[0]?.week === '2026-05-25', `week=${diff[0]?.week}`);
}

console.log('\nTest 15: new crew added entirely (e.g., new hire mid-horizon)');
{
  const old = makePlan({ capacityGrid: { Chris: { '2026-05-18': cell(15, 5) } } });
  const neu = makePlan({ capacityGrid: {
    Chris: { '2026-05-18': cell(15, 5) },
    NewHire: { '2026-05-18': cell(20, 0) },
  }});
  const diff = diffCapacityGrid(old, neu);
  check('one added record for the new crew', diff.length === 1, `got ${diff.length}`);
  check('crew=NewHire', diff[0]?.crew === 'NewHire', JSON.stringify(diff[0]));
}

// ──────────────────────────────────────────────────────────────────────────

console.log();
if (failures.length > 0) {
  console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✅ All diff-plans tests passed (${checks} checks).`);
