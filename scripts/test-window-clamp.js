#!/usr/bin/env node
// Current-week truthfulness (2026-06-12): computeWindows past-window clamping.
// Tests that entirely-past and partially-past auto-computed windows are clamped
// forward to effectiveWeek; customWindow stations are exempt; finishing-cycle
// violations from clamped windows do not throw; unclamped violations still throw.
const { computeWindows, checkFinishingCycleValid } = require('./rebalance-schedule.js');

const failures = []; let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else { failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label} — ${detail}`); }
}

// Synthetic job helper — matches loadJobs' shape (see rebalance-schedule.js ~510).
const job = (over = {}) => ({
  id: 'J1', name: 'Clamp Test', delivery: '2026-06-17', subtype: 'Commercial',
  pLam: true, finishingDays: 0, masterPmId: 'M1', customWindow: null,
  hours: { eng: 0, panel: 0, bench: 40, prefin: 0, postfin: 0 }, ...over,
});

console.log('Test 1: back-compat — no opts ⇒ identical to today, no clamps key');
{
  const w = computeWindows(job());
  check('bench window computed', w.bench.start === '2026-06-08', JSON.stringify(w.bench));
  check('no clamps key without opts', !('clamps' in w));
}

console.log('\nTest 2: entirely-past window collapses to one week at effectiveWeek');
{
  const w = computeWindows(job(), { effectiveWeek: '2026-06-15' });
  // computed bench 6/08–6/12 is entirely past 6/15 (BCH case)
  check('bench start clamped', w.bench.start === '2026-06-15', JSON.stringify(w.bench));
  check('bench end one week',  w.bench.end === '2026-06-19');
  check('clamp recorded', w.clamps.length === 1 && w.clamps[0].station === 'bench'
    && w.clamps[0].entirelyPast === true && w.clamps[0].computedStart === '2026-06-08');
}

console.log('\nTest 3: partially-past window clamps start only');
{
  const w = computeWindows(job({ delivery: '2026-06-24', hours: { eng: 0, panel: 0, bench: 80, prefin: 0, postfin: 0 } }),
    { effectiveWeek: '2026-06-15' });
  // computed bench 6/08–6/19 → start clamps to 6/15, end stays 6/19
  check('start clamped', w.bench.start === '2026-06-15', JSON.stringify(w.bench));
  check('end preserved', w.bench.end === '2026-06-19');
  check('entirelyPast false', w.clamps[0].entirelyPast === false);
}

console.log('\nTest 4: customWindow is exempt from clamping');
{
  const w = computeWindows(job({ customWindow: { bench: { start: '2026-06-08', end: '2026-06-12' } } }),
    { effectiveWeek: '2026-06-15' });
  check('customWindow untouched', w.bench.start === '2026-06-08' && w.bench.end === '2026-06-12');
  check('no clamp recorded', w.clamps.length === 0);
}

console.log('\nTest 5: future windows untouched, clamps empty');
{
  // delivery 2026-07-01 → bench 2026-06-22 to 2026-06-26 — all past effectiveWeek 2026-06-08
  // Use effectiveWeek before the windows so there is nothing to clamp
  const w = computeWindows(job({ delivery: '2026-07-01' }), { effectiveWeek: '2026-06-08' });
  const wNoOpts = computeWindows(job({ delivery: '2026-07-01' }));
  check('clamps array empty', w.clamps.length === 0, JSON.stringify(w.clamps));
  check('bench start identical to no-opts', w.bench.start === wNoOpts.bench.start);
  check('bench end identical to no-opts',   w.bench.end === wNoOpts.bench.end);
}

console.log('\nTest 6: no-throw on clamp-broken finishing cycle');
{
  // finishing job whose prefin clamps into the finish-drop — must NOT throw;
  // validity is reported, not asserted, for clamped jobs.
  const j = job({ pLam: false, finishingDays: 5, delivery: '2026-06-22',
    hours: { eng: 0, panel: 0, bench: 0, prefin: 30, postfin: 20 } });
  let threw = false, w = null;
  try { w = computeWindows(j, { effectiveWeek: '2026-06-15' }); } catch (e) { threw = true; }
  check('no throw', threw === false);
  check('cycle reported invalid', w && checkFinishingCycleValid(j, w).valid === false);
}

console.log('\nTest 7: unclamped jobs keep the compute-time assert (config-error defense)');
{
  // A finishing job with a customWindow for prefin that violates the cycle and NO
  // clamping opts — computeWindows must still throw (same as today).
  const j = job({ pLam: false, finishingDays: 5, delivery: '2026-06-22',
    hours: { eng: 0, panel: 0, bench: 0, prefin: 30, postfin: 20 },
    customWindow: { prefin: { start: '2026-06-15', end: '2026-06-19' } },
  });
  let threw = false;
  try { computeWindows(j); } catch (e) { threw = true; }
  check('unclamped violating job throws', threw === true);
}

console.log('\nTest 8: packShip clamps when the delivery week itself is past (overdue job)');
{
  const w = computeWindows(job({ delivery: '2026-06-10' }), { effectiveWeek: '2026-06-15' });
  check('packShip pulled forward', w.packShip.start === '2026-06-15', JSON.stringify(w.packShip));
  check('clamp recorded for packShip', w.clamps.some(c => c.station === 'packShip'));
}

console.log();
if (failures.length) { console.log(`❌ ${failures.length} failure(s) of ${checks}`); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log(`✅ All window-clamp tests passed (${checks} checks).`);
