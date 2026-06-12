#!/usr/bin/env node
// Current-week truthfulness (2026-06-12): nowContext is the single source of
// truth for effective planning week + day-weighted remaining workdays.
// LOCAL time on purpose — the Saturday 18:00 MDT run is Sunday 00:00 UTC,
// which is exactly the bug this kills.
const { nowContext } = require('./rebalance-schedule.js');

const failures = []; let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else { failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label} — ${detail}`); }
}
// new Date(y, m, d, h) is LOCAL by definition — these tests are clock-zone-safe.
const ctx = (...a) => nowContext(new Date(...a));

console.log('Test 1: weekday before noon counts today');
check('Mon 09:00 → 5 days', ctx(2026, 5, 8, 9).remainingWorkdays === 5, JSON.stringify(ctx(2026, 5, 8, 9)));
check('Wed 09:00 → 3 days', ctx(2026, 5, 10, 9).remainingWorkdays === 3);
check('Fri 09:00 → 1 day',  ctx(2026, 5, 12, 9).remainingWorkdays === 1);

console.log('\nTest 2: weekday after noon excludes today (the 3:40 PM Friday incident)');
check('Mon 13:00 → 4 days', ctx(2026, 5, 8, 13).remainingWorkdays === 4);
check('Wed 14:00 → 2 days', ctx(2026, 5, 10, 14).remainingWorkdays === 2);
check('Fri 15:40 → 0 days', ctx(2026, 5, 12, 15, 40).remainingWorkdays === 0);

console.log('\nTest 3: weekday effective week = this Monday, isMidWeek true');
check('Fri 6/12 effectiveWeek 6/08', ctx(2026, 5, 12, 15).effectiveWeek === '2026-06-08');
check('Fri 6/12 currentWeekMonday 6/08', ctx(2026, 5, 12, 15).currentWeekMonday === '2026-06-08');
check('isMidWeek', ctx(2026, 5, 12, 15).isMidWeek === true);

console.log('\nTest 4: Sat/Sun roll to next Monday with a full week');
check('Sat 6/13 18:00 → effectiveWeek 6/15', ctx(2026, 5, 13, 18).effectiveWeek === '2026-06-15');
check('Sat currentWeekMonday stays 6/08', ctx(2026, 5, 13, 18).currentWeekMonday === '2026-06-08');
check('Sat remainingWorkdays 5', ctx(2026, 5, 13, 18).remainingWorkdays === 5);
check('Sat isMidWeek false', ctx(2026, 5, 13, 18).isMidWeek === false);
check('Sun 6/14 20:00 → 6/15', ctx(2026, 5, 14, 20).effectiveWeek === '2026-06-15');

console.log('\nTest 5: noon boundary is strict <12');
check('11:59 counts today', ctx(2026, 5, 10, 11, 59).remainingWorkdays === 3);
check('12:00 does not',     ctx(2026, 5, 10, 12, 0).remainingWorkdays === 2);

console.log('\nTest 6: defaults to the real clock without throwing');
const live = nowContext();
check('shape', typeof live.effectiveWeek === 'string' && live.effectiveWeek.length === 10
  && live.remainingWorkdays >= 0 && live.remainingWorkdays <= 5, JSON.stringify(live));

console.log();
if (failures.length) { console.log(`❌ ${failures.length} failure(s) of ${checks}`); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log(`✅ All now-context tests passed (${checks} checks).`);
