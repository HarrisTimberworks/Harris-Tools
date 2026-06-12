# Current-Week Truthfulness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The planner stops treating the current week as a full nominal week — day-weighted remaining capacity (noon rule), past station windows clamped forward with loud reporting, deploys preserve past + current weeks, weekend runs roll to next Monday, and the 2026-06-12 stop-gap customWindows come out.

**Architecture:** One new pure helper (`nowContext`) becomes the single source of truth for "what week is it / how much of it is left", threaded through `runPlan` via the existing `opts` parameter. Clamping lives inside `computeWindows` behind an optional second argument (absent ⇒ bit-for-bit today's behavior). Deploy preservation is a week-aware extension of `computeSubitemDeletes` plus a scoped PATCH A carve-out. All reporting rides existing surfaces: plan JSON → trigger summary → Capacity View → notifications.

**Tech Stack:** Plain Node (no deps), monday.com GraphQL API-Version `next`, existing `scripts/test-*.js` plain-Node test convention (`check()` helper, exit 1 on failure).

**Spec:** `docs/superpowers/specs/2026-06-12-current-week-truthfulness-design.md` (approved 2026-06-12).

---

## Build constraints (read first)

1. **Worktree-mandatory.** The Task Scheduler minute-poll executes `planner-trigger.js` → `rebalance-schedule.js` from `main`'s working tree. NEVER build this on main. Create a worktree (superpowers:using-git-worktrees) and merge back only when the full suite is green. Task Scheduler must never point into `.claude/worktrees/` (Phase-3 rule).
2. **Sibling in flight.** The partial-station Hrs Left build is landing on main in a parallel session (commits `feat(progress): …`). Before creating the worktree, `git pull`/`git log` and branch from the latest main. Merge points: `buildRunSummary` in planner-trigger.js (sibling adds shop-progress warning sections; ours adds clamp + plan-warnings sections — both additive), `loadJobs` (sibling adds `hrsLeft` parsing — we don't touch it). If a merge conflict appears at integration, both features are additive line-blocks; keep both.
3. **Commit per task, immediately** (shared-working-tree rule applies the moment we merge to main; inside the worktree it keeps the journal clean for review).
4. **Tests:** the full `scripts/test-*.js` suite must stay green after every task. One file needs `MONDAY_API_TOKEN` (load from `.token` at repo root). Synthetic-plan tests MUST pass `savePath: null` to `runPlan` (2026-05-25 incident class).
5. **Fixture reference:** `scripts/test-overrides-read-pipeline.js` already builds full `boards` fixtures (jobs/crewParents/timeOff/existingSubs/overrideRows) for real `runPlan` calls, including parent rows for every crew × horizon week (the A4 check `process.exit(1)`s without them). Copy its builder rather than inventing one.
6. **Destructive verification is Chris-triggered** (standing practice): we do unit tests + DRY_RUN + plan-only live runs; mid-week-deploy preservation on the live board is verified by Chris with the procedure in Task 13.

---

### Task 1: Worktree + baseline

**Files:** none modified.

- [ ] **Step 1:** Sync and branch: `git -C C:\Users\chris\Harris-Tools pull` (or verify up to date), then create the worktree per superpowers:using-git-worktrees (branch name `feat/current-week-truthfulness`). All subsequent tasks run in the worktree.
- [ ] **Step 2:** Baseline suite. From the worktree root, run every `scripts/test-*.js` (PowerShell):
```powershell
$env:MONDAY_API_TOKEN = (Get-Content .token -Raw).Trim()
Get-ChildItem scripts/test-*.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { Write-Host "FAIL: $($_.Name)" -ForegroundColor Red } }
```
Expected: every file ends with its `✅ All … passed` line. If the sibling session left a red test, STOP and report — do not build on a red baseline.
- [ ] **Step 3:** Note the count of test files + checks in the task journal (the build record needs before/after counts).

---

### Task 2: `nowContext` — the effective-week + noon-rule helper

**Files:**
- Modify: `scripts/rebalance-schedule.js` (new function near the date helpers ~line 350; add to `module.exports`)
- Create: `scripts/test-now-context.js`

- [ ] **Step 1: Write the failing test** (`scripts/test-now-context.js`, standard `check()` harness as in `test-execute-delete-guard.js`):

```js
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
```

- [ ] **Step 2:** Run `node scripts/test-now-context.js` — expect FAIL (`nowContext is not a function`).
- [ ] **Step 3: Implement** in `rebalance-schedule.js`, after `getWeekList` (~line 403):

```js
// ============================================================================
// Current-week truthfulness (2026-06-12): the ONLY place "what week is it"
// is decided. LOCAL clock deliberately — Sat 18:00 MDT is Sun 00:00 UTC, and
// the UTC-based startWeek made the Saturday auto-run plan into the week that
// had just ended. The noon rule: today is a remaining workday only if the
// run starts before 12:00 local.
//   currentWeekMonday — Monday of the calendar week containing `now`
//   effectiveWeek     — currentWeekMonday on Mon–Fri; NEXT Monday on Sat/Sun
//   remainingWorkdays — 0..5 placeable days in the effective week
//   isMidWeek         — effectiveWeek === currentWeekMonday
// ============================================================================
function nowContext(now = new Date()) {
  const dow = now.getDay(); // local: 0=Sun..6=Sat
  const localISO = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() + (dow === 0 ? -6 : 1 - dow));
  const currentWeekMonday = localISO(monday);
  if (dow === 0 || dow === 6) {
    const next = new Date(monday); next.setDate(next.getDate() + 7);
    return { currentWeekMonday, effectiveWeek: localISO(next), remainingWorkdays: 5, isMidWeek: false };
  }
  const remainingWorkdays = (5 - dow) + (now.getHours() < 12 ? 1 : 0);
  return { currentWeekMonday, effectiveWeek: currentWeekMonday, remainingWorkdays, isMidWeek: true };
}
```
Add `nowContext,` to `module.exports`.
- [ ] **Step 4:** Run the test — expect PASS. Run the full suite — expect green (additive change).
- [ ] **Step 5:** Commit: `git add scripts/rebalance-schedule.js scripts/test-now-context.js && git commit -m "feat(truthfulness): nowContext — local effective week + noon-rule remaining workdays (TDD)"`

---

### Task 3: Window clamping in `computeWindows`

**Files:**
- Modify: `scripts/rebalance-schedule.js` (`computeWindows` ~line 1188; new `clampStationWindows` helper directly above it; exports)
- Create: `scripts/test-window-clamp.js`

- [ ] **Step 1: Write the failing test** (same harness; representative checks shown — implement ALL):

```js
const { computeWindows, checkFinishingCycleValid } = require('./rebalance-schedule.js');
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
// craft a job whose CUSTOM windows violate the cycle with no clamping — expect throw, same as today.
console.log('\nTest 8: packShip clamps when the delivery week itself is past (overdue job)');
{
  const w = computeWindows(job({ delivery: '2026-06-10' }), { effectiveWeek: '2026-06-15' });
  check('packShip pulled forward', w.packShip.start === '2026-06-15', JSON.stringify(w.packShip));
  check('clamp recorded for packShip', w.clamps.some(c => c.station === 'packShip'));
}
```

- [ ] **Step 2:** Run it — expect FAIL on Test 2 (`clamps` undefined).
- [ ] **Step 3: Implement.** Above `computeWindows`, add:

```js
// Clamp one auto-computed window forward to effectiveWeek. customWindow
// stations never pass through here (operator intent wins; the config lint
// flags stale ones instead). Entirely-past windows collapse to one week at
// effectiveWeek — late work's only honest schedule is "now".
function clampStationWindow(station, win, effectiveWeek, clamps) {
  if (!win || !effectiveWeek || win.start >= effectiveWeek) return win;
  const entirelyPast = win.end < effectiveWeek;
  const clamped = {
    start: effectiveWeek,
    end: entirelyPast ? toISO(addDays(parseISO(effectiveWeek), 4)) : win.end,
  };
  clamps.push({
    station,
    computedStart: win.start, computedEnd: win.end,
    clampedStart: clamped.start, clampedEnd: clamped.end,
    entirelyPast,
  });
  return clamped;
}
```
Then in `computeWindows(job)` → `computeWindows(job, opts = {})`:
1. `const effectiveWeek = opts.effectiveWeek || null; const clamps = [];`
2. In each station block's **auto-computed else-branch only** (postfin, prefin, bench, panel, eng), wrap the assignment: `windows.postfin = clampStationWindow('postfin', { start: postfinStart, end: ... }, effectiveWeek, clamps);` — and (critical) the downstream anchor variables (`postfinEndWeek`, `prefinStartWeek`, `benchStartWeek`, `panelStartWeek`) must read from the CLAMPED window (`windows.postfin.start` etc.), so later stations chain off reality. The customWindow branches stay byte-identical.
3. packShip: after building it, `windows.packShip = clampStationWindow('packShip', windows.packShip, effectiveWeek, clamps);`
4. finishDrop/finishReturn: never altered.
5. Replace the unconditional assert with:
```js
if (clamps.length === 0) {
  assertFinishingCycleValid(job, windows);  // unchanged defense for unclamped jobs
}
if (effectiveWeek) windows.clamps = clamps;  // key absent on legacy calls
```
- [ ] **Step 4:** Run `node scripts/test-window-clamp.js` — PASS. Full suite — green (no caller passes opts yet).
- [ ] **Step 5:** Commit: `feat(truthfulness): computeWindows clamps past auto-windows to effectiveWeek, never throws on clamp (TDD)`

---

### Task 4: Thread `nowContext` through `runPlan` (startWeek, clamp report, unplaced total)

**Files:**
- Modify: `scripts/rebalance-schedule.js` (`runPlan` ~lines 1700–1900)
- Create: `scripts/test-runplan-effective-week.js` (fixture builder copied from `scripts/test-overrides-read-pipeline.js`)

- [ ] **Step 1: Write the failing test.** Copy the boards-fixture builder from `test-overrides-read-pipeline.js` (it generates crewParents for every crew × horizon week — required by the A4 check). Then:

```js
// Fixed clock context for hermetic runs:
const FRI_PM = { currentWeekMonday: '2026-06-08', effectiveWeek: '2026-06-08', remainingWorkdays: 0, isMidWeek: true };
const SAT    = { currentWeekMonday: '2026-06-08', effectiveWeek: '2026-06-15', remainingWorkdays: 5, isMidWeek: false };

console.log('Test 1: weekend run — grid starts at next Monday (dead week absent)');
{
  const plan = await runPlan(boards, { savePath: null, nowContext: SAT });
  const weeks = new Set(Object.values(plan.capacityGrid).flatMap(c => Object.keys(c)));
  check('no 6/08 cells in grid', ![...weeks].includes('2026-06-08'), [...weeks].slice(0, 3).join(','));
  check('placements all >= 6/15', plan.placements.every(p => p.week >= '2026-06-15'));
}
console.log('\nTest 2: windowClamps + nowContext persisted in the plan report');
{
  // boards fixture includes the BCH-shaped job (delivery 6/17, bench 40) → its
  // computed 6/08 window clamps to 6/15 under SAT context.
  const plan = await runPlan(boards, { savePath: null, nowContext: SAT });
  check('windowClamps present', Array.isArray(plan.windowClamps) && plan.windowClamps.length >= 1,
    JSON.stringify(plan.windowClamps));
  check('clamp carries job name', plan.windowClamps[0].jobName !== undefined);
  check('nowContext persisted', plan.nowContext && plan.nowContext.effectiveWeek === '2026-06-15');
}
console.log('\nTest 3: unplacedTotal aggregates scheduleStation shortfalls');
// fixture with hours exceeding all capacity in the window → plan.unplacedTotal > 0
console.log('\nTest 4: no nowContext opt ⇒ live clock used, no throw (smoke)');
console.log('\nTest 5: clamped job with broken cycle lands as invalid FCV row with clamp note, run completes');
```

- [ ] **Step 2:** Run — FAIL (grid still starts at the UTC Monday / no `windowClamps`).
- [ ] **Step 3: Implement** in `runPlan`:
1. Signature already `runPlan(boards, opts)`. Add: `const ctx = opts.nowContext || nowContext();`
2. Replace `const startWeek = toISO(getMondayOfWeek(today));` (~1712) with `const startWeek = ctx.effectiveWeek;` (keep `const today = new Date();` — the horizon floor still uses it).
3. `const windows = computeWindows(job);` (~1796) → wrap per-job to honor the clamp/no-throw contract:
```js
let windows;
try {
  windows = computeWindows(job, { effectiveWeek: ctx.effectiveWeek });
} catch (e) {
  warnings.push(`Could not compute windows for ${job.name}: ${e.message}`);
  finishingCycleSkipped++;
  continue;
}
for (const c of windows.clamps || []) {
  windowClamps.push({ jobId: job.id, jobName: job.name, ...c });
}
```
with `const windowClamps = [];` declared next to `const warnings = [];`. When the job had clamps AND its `fcRow` is invalid, append context to the row's errors: `fcRow.errors.push(\`window clamped: ${windows.clamps.map(c => \`${c.station} ${c.computedStart}→${c.clampedStart}\`).join(', ')}\`)` and set `fcRow.clamped = true` before pushing into `finishingCycleRows`.
4. In the per-station placement loop, accumulate `unplacedTotal += result.unplaced;` (declare `let unplacedTotal = 0;`); include `unplaced: Number(unplacedTotal.toFixed(2))` — name it `unplacedTotal` — plus `windowClamps`, and `nowContext: ctx` in the `report` object (~1870).
- [ ] **Step 4:** Run new test — PASS. Full suite — green. (Existing fixture tests run with the live clock; if any asserts a specific startWeek, inject a fixed `nowContext` there — flag it in the commit message.)
- [ ] **Step 5:** Commit: `feat(truthfulness): runPlan plans from effectiveWeek; windowClamps/nowContext/unplacedTotal in plan JSON (TDD)`

---

### Task 5: Day-weighted `placeable` capacity for the current week

**Files:**
- Modify: `scripts/rebalance-schedule.js` (`buildCapacityGrid` ~679; `allocateStationWeek` ~1456; primaries filter ~1591; `applyForceAssignments` warning ~1155; capacityGrid report ~1899; exports gain `buildCapacityGrid`)
- Create: `scripts/test-day-weighted-capacity.js`

- [ ] **Step 1: Write the failing test:**

```js
const { buildCapacityGrid, allocateStationWeek, SOFT_CAP_MULTIPLIER } = require('./rebalance-schedule.js');
const weeks = ['2026-06-08', '2026-06-15'];
const parents = (crew, base = 40) => weeks.map(w => ({ parentId: `${crew}-${w}`, week: w, crew, base, timeOff: 0, nonProd: 0 }));

console.log('Test 1: Friday-PM context zeroes current-week placeable, future weeks untouched');
{
  const ctx = { currentWeekMonday: '2026-06-08', effectiveWeek: '2026-06-08', remainingWorkdays: 0, isMidWeek: true };
  const grid = buildCapacityGrid(parents('Bob'), [], weeks, [], new Set(), ctx);
  check('placeable 0 on 6/08', grid.Bob['2026-06-08'].placeable === 0, JSON.stringify(grid.Bob['2026-06-08']));
  check('no placeable cap on 6/15', grid.Bob['2026-06-15'].placeable === undefined);
  check('nominal available intact (display)', grid.Bob['2026-06-08'].available === 40);
}
console.log('\nTest 2: Wednesday-PM → 16h placeable (2 days × 8)');
console.log('\nTest 3: allocateStationWeek respects placeable, not just soft cap');
{
  const ctx = { currentWeekMonday: '2026-06-08', effectiveWeek: '2026-06-08', remainingWorkdays: 2, isMidWeek: true };
  const grid = buildCapacityGrid(parents('Bob'), [], weeks, [], new Set(), ctx);
  const job = { id: 'J', name: 'J', subtype: 'Commercial', masterPmId: 'M' };
  const r = allocateStationWeek(grid, job, 'Benchwork', '2026-06-08', 40, ['Bob']);
  const placed = r.placements.reduce((s, p) => s + p.hours, 0);
  check('placed capped at 16', Math.abs(placed - 16) < 0.01, String(placed));
  check('rest unplaced', Math.abs(r.unplaced - 24) < 0.01);
}
console.log('\nTest 4: explicit crewCapacityOverrides.available exempts from weighting');
// OVERRIDES.crewCapacityOverrides is module-level config; emulate via the exported
// OVERRIDES object: set OVERRIDES.crewCapacityOverrides['2026-06-08'] = { Bob: { available: 20, reason: 'test' } }
// before buildCapacityGrid, restore after. Expect placeable === 20 even with remainingWorkdays 0.
console.log('\nTest 5: weekendHours boost adds to placeable');
console.log('\nTest 6: subcontractor slots never get a placeable cap');
console.log('\nTest 7: committed preExisting beyond placeable → no new room (committed >= cap path)');
console.log('\nTest 8: back-compat — no ctx arg ⇒ no placeable anywhere (all existing callers)');
```

- [ ] **Step 2:** Run — FAIL (`buildCapacityGrid` not exported).
- [ ] **Step 3: Implement:**
1. `buildCapacityGrid(crewParents, timeOffList, weeks, existingSubs, activeJobMasterPmIds, ctx = null, preserveOpts = null)` — after the crewCapacityOverrides PATCH D block (so the exemption sees overrides), add:
```js
// Day-weighted current week (2026-06-12): physical bound on NEW work.
// min(available, dailyBase × remainingDays). Explicit operator overrides and
// subcontractor pools are exempt — see overrideReason/weekendBoost handling.
if (ctx && ctx.isMidWeek) {
  for (const crew of Object.keys(grid)) {
    const slot = grid[crew][ctx.currentWeekMonday];
    if (!slot || slot.subcontractor) continue;
    if (slot.overrideReason !== undefined) {
      slot.placeable = slot.available;            // explicit operator number wins verbatim
    } else {
      slot.placeable = Math.min(slot.available, (slot.base / 5) * ctx.remainingWorkdays);
      if (slot.weekendBoost) slot.placeable += slot.weekendBoost;  // deliberate weekend capacity survives weighting
    }
  }
}
```
(PATCH D adds `weekendHours` into `available` only — the `min(available, …)` would strip it, so the explicit `+= weekendBoost` restores it. Verify field names against the real PATCH D block with Test 5 before committing.)
2. `allocateStationWeek` room: replace `const softCap = slot.available * SOFT_CAP_MULTIPLIER;` with:
```js
let softCap = slot.available * SOFT_CAP_MULTIPLIER;
if (slot.placeable !== undefined) softCap = Math.min(softCap, slot.placeable); // physical bound — no 5% grace
```
3. Same two-line cap in the `primariesAvailableThisWeek` filter (~1595) and in `applyForceAssignments`' over-cap warning threshold (~1155) — forces still PLACE (warning only), but the warning text for capped weeks gains `(day-weighted: ${slot.placeable}h placeable)`.
4. Report cells (~1899): add `...(slot.placeable !== undefined ? { placeableAvail: Number(slot.placeable.toFixed(2)) } : {}),`.
5. `runPlan`'s `buildCapacityGrid(...)` call (~1772) passes `ctx`.
6. Export `buildCapacityGrid`.
- [ ] **Step 4:** Run new test — PASS. Full suite — green (ctx defaults null ⇒ no placeable).
- [ ] **Step 5:** Commit: `feat(truthfulness): day-weighted placeable cap on current-week slots; report placeableAvail (TDD)`

---

### Task 6: Deploy preservation — PATCH A carve-out + preserved-hours subtraction

**Files:**
- Modify: `scripts/rebalance-schedule.js` (PATCH A block ~761; `runPlan` stations array ~1825 + P&S loop ~1849)
- Create: `scripts/test-current-week-preservation.js`

- [ ] **Step 1: Write the failing test** (fixture-based `runPlan` like Task 4):

```js
// Fixture: active job (mpm 'M1', bench 40h remaining, delivery 6/24) with
// existing subitems: 24h bench on Bob @ 6/08 (current week), 8h bench @ 6/01 (past).
// Context: Wednesday AM, currentWeek 6/08 (remainingWorkdays 3, isMidWeek true).
console.log('Test 1: current-week rows load as preExisting committed');
{
  const plan = await runPlan(boards, { savePath: null, nowContext: WED_AM });
  const cell = plan.capacityGrid.Bob['2026-06-08'];
  check('24h preExisting committed', cell.assignments.some(a => a.preExisting && a.hours === 24),
    JSON.stringify(cell.assignments));
}
console.log('\nTest 2: preserved hours subtract from planable remaining (no double-schedule)');
{
  // bench remaining 40, preserved 24 → only 16 should be (re)placed across the window
  const plan = await runPlan(boards, { savePath: null, nowContext: WED_AM });
  const benchPlaced = plan.placements.filter(p => p.station === 'Benchwork' && String(p.masterPmId) === 'M1')
    .reduce((s, p) => s + p.hours, 0);
  check('16h placed, not 40', Math.abs(benchPlaced - 16) < 0.01, String(benchPlaced));
}
console.log('\nTest 3: preserved current-week rows NOT in the delete set; past-week rows NOT either');
{
  const plan = await runPlan(boards, { savePath: null, nowContext: WED_AM });
  check('6/08 sub preserved', !plan.existingSubitemIdsToDelete.includes('sub-608'));
  check('6/01 sub preserved (history)', !plan.existingSubitemIdsToDelete.includes('sub-601'));
}
console.log('\nTest 4: future-week rows of replanned jobs still deleted (full overwrite ahead)');
console.log('\nTest 5: weekend context — ending week falls under history protection');
console.log('\nTest 6: P&S/Delivery preserved rows reduce the 2h re-place');
console.log('\nTest 7: remaining < preserved floors at 0 (no negative hours)');
```

- [ ] **Step 2:** Run — FAIL (deletes include current-week rows; 40h placed).
- [ ] **Step 3: Implement** in `runPlan` (before the grid build, after `activeJobMasterPmIds`):
```js
// Current-week preservation (2026-06-12): mid-week, the deployed current week
// is committed reality — preserved on the board, counted as preExisting,
// and its hours subtracted from what gets re-planned. rewriteJobIds (Task 7)
// carves jobs with a current-week override row back into full rewrite.
const rewriteJobIds = computeCurrentWeekRewriteIds(boards.overrideRows || [], crewParents, ctx.currentWeekMonday);
const preservedKey = (mpm, station) => `${mpm}|${station}`;
const preservedCurrentWeekHours = new Map();
if (ctx.isMidWeek) {
  for (const sub of existingSubs) {
    if (!activeJobMasterPmIds.has(sub.masterPmId)) continue;
    if (sub.parentWeek !== ctx.currentWeekMonday) continue;
    if (rewriteJobIds.has(String(sub.masterPmId))) continue;
    const k = preservedKey(String(sub.masterPmId), sub.station);
    preservedCurrentWeekHours.set(k, (preservedCurrentWeekHours.get(k) || 0) + sub.hours);
  }
}
const preservedFor = (job, station) => preservedCurrentWeekHours.get(preservedKey(String(job.masterPmId), station)) || 0;
```
(Task 7 supplies `computeCurrentWeekRewriteIds`; for THIS task stub it inline as `() => new Set()` and replace in Task 7 — note it in the commit.)
PATCH A block: pass `ctx` + the preserved set into `buildCapacityGrid` (extend its signature: `preserveOpts = { currentWeekMonday, rewriteJobIds }`); inside the PATCH A loop:
```js
if (activeJobMasterPmIds.has(sub.masterPmId)) {
  const preservedHere = preserveOpts && sub.parentWeek === preserveOpts.currentWeekMonday
    && !preserveOpts.rewriteJobIds.has(String(sub.masterPmId));
  if (!preservedHere) continue;  // future rows: deleted on deploy, don't count
}
```
Stations array (~1825): each entry becomes `hours: Math.max(0, job.hours.eng - preservedFor(job, 'Engineering'))` (and Panel Processing / Benchwork / Pre Fin Cab Assembly / Post Fin Cab Assembly respectively). P&S loop: `const remaining = Math.max(0, 2 - forceResult.hoursConsumed - preservedFor(job, ps));`
- [ ] **Step 4:** Tests 1–2, 6–7 PASS (3–5 need Task 7's delete change — mark them `SKIP(awaiting task 7)` in the test with a console note, or assert current behavior and flip in Task 7; choose flip-in-Task-7 and say so in the file).
- [ ] **Step 5:** Full suite green. Commit: `feat(truthfulness): preserve current-week reality in grid + subtract from planable remaining (TDD)`

---

### Task 7: `computeCurrentWeekRewriteIds` + week-aware `computeSubitemDeletes`

**Files:**
- Modify: `scripts/rebalance-schedule.js` (`computeSubitemDeletes` ~2068; new helper near it; `runPlan` report line ~1885; exports)
- Modify: `scripts/test-execute-delete-guard.js` (extend), `scripts/test-current-week-preservation.js` (un-skip Tests 3–5)

- [ ] **Step 1: Write failing tests** — extend `test-execute-delete-guard.js`:

```js
console.log('\nTest 7: week-aware — past-week subitems never deleted, any job');
{
  const subs = [
    { id: 'p1', masterPmId: 'MPM-A', parentWeek: '2026-06-01' },
    { id: 'c1', masterPmId: 'MPM-A', parentWeek: '2026-06-08' },
    { id: 'f1', masterPmId: 'MPM-A', parentWeek: '2026-06-15' },
  ];
  const placements = [{ masterPmId: 'MPM-A', week: '2026-06-15', hours: 8 }];
  const opts = { effectiveWeek: '2026-06-08', currentWeekMonday: '2026-06-08', isMidWeek: true, rewriteJobIds: new Set() };
  const ids = computeSubitemDeletes(subs, placements, opts);
  check('past p1 protected', !ids.includes('p1'), JSON.stringify(ids));
  check('current c1 preserved (no rewrite row)', !ids.includes('c1'));
  check('future f1 deleted', ids.includes('f1'));
}
console.log('\nTest 8: rewriteJobIds opts current week back into rewrite');
// same subs, rewriteJobIds = new Set(['MPM-A']) → c1 IS deleted, p1 still protected
console.log('\nTest 9: weekend context — ending week is history');
// opts.effectiveWeek '2026-06-15', isMidWeek false → c1 (6/08) protected as past
console.log('\nTest 10: missing parentWeek → protected (safety default)');
console.log('\nTest 11: no opts ⇒ legacy behavior (Tests 1–6 shapes unchanged)');
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement:**
```js
// Current-week truthfulness (2026-06-12): jobs with an accepted override row
// touching the current week opt OUT of preservation — explicit mid-week moves
// rewrite that job's current week exactly as before.
function computeCurrentWeekRewriteIds(overrideRows, crewParents, currentWeekMonday) {
  const weekByParent = new Map();
  for (const p of crewParents || []) weekByParent.set(String(p.parentId), p.week);
  const ids = new Set();
  for (const row of overrideRows || []) {
    if (row.status !== 'Pending' && row.status !== 'Applied') continue;
    const fromWeek = row.fromCrewParentId ? weekByParent.get(String(row.fromCrewParentId)) : null;
    const toWeek = row.toCrewParentId ? weekByParent.get(String(row.toCrewParentId)) : null;
    if (fromWeek === currentWeekMonday || toWeek === currentWeekMonday) {
      if (row.jobMpmId != null) ids.add(String(row.jobMpmId));
    }
  }
  return ids;
}
```
`computeSubitemDeletes(existingSubs, placements, opts = null)` — after the existing `replanned.has(...)` filter, when `opts` is provided:
```js
.filter(s => {
  if (!opts) return true;                                  // legacy callers
  if (!s.parentWeek) return false;                         // safety: unknown week → protect
  if (s.parentWeek < opts.effectiveWeek) return false;     // history guard
  if (opts.isMidWeek && s.parentWeek === opts.currentWeekMonday
      && !opts.rewriteJobIds.has(String(s.masterPmId))) return false;  // committed reality
  return true;
})
```
`runPlan` ~1885: `existingSubitemIdsToDelete: computeSubitemDeletes(existingSubs, allPlacements, { effectiveWeek: ctx.effectiveWeek, currentWeekMonday: ctx.currentWeekMonday, isMidWeek: ctx.isMidWeek, rewriteJobIds })` — and replace Task 6's stub with the real `computeCurrentWeekRewriteIds`. When any replanned sub has a missing `parentWeek`, push a warning: `` `subitem ${s.id} (${s.name}) has no parent week — protected from deletion, clean up manually` ``. Export `computeCurrentWeekRewriteIds`.
- [ ] **Step 4:** Both test files fully PASS (un-skip Task 6's Tests 3–5). Full suite green.
- [ ] **Step 5:** Commit: `feat(truthfulness): week-aware delete guard — past weeks immutable, current week preserved unless override row touches it (TDD)`

---

### Task 8: Validator honors day-weighted capacity; jobWindows clamp-consistent

**Files:**
- Modify: `scripts/validate-overrides.js` (`checkCapacity` ~218)
- Modify: `scripts/run-planner.js` (jobWindows loop ~154; pass nowContext into both runPlan calls)
- Test: extend `scripts/test-validate-overrides.js` (or the existing validator test file found via `grep -l checkCapacity scripts/test-*.js`)

- [ ] **Step 1: Write failing tests:** baselinePlan fixture cell `{ avail: 40, committed: 6, placeableAvail: 0 }` for (Bob, 2026-06-08):
```js
console.log('Test N: current-week row over day-weighted cap → Conflict citing placeable');
// row { toCrew:'Bob', toWeek:'2026-06-08', hours: 8 } → invalid; reason mentions 'day-weighted'
console.log('Test N+1: Allow Over-Cap still forces through with softWarning');
console.log('Test N+2: cells without placeableAvail behave exactly as today');
```
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** in `checkCapacity`: replace `const cap = Number(slot.avail || 0);` with:
```js
const dayWeighted = slot.placeableAvail !== undefined ? Number(slot.placeableAvail) : null;
const cap = dayWeighted !== null ? Math.min(Number(slot.avail || 0), dayWeighted) : Number(slot.avail || 0);
```
and append `' (day-weighted current week)'` to both the softWarning and the reject reason when `dayWeighted !== null && cap === dayWeighted`. In `run-planner.js`: `const ctx = (deps.nowContext || reb.nowContext)();` near the top of plan mode; jobWindows loop calls `_computeWindows(job, { effectiveWeek: ctx.effectiveWeek })`; both `_runPlan(baselineBoards)` / `_runPlan(finalBoards)` become `_runPlan(x, { nowContext: ctx })` — **check `_runPlan`'s existing call signature in the orchestrator stubs** (`test-run-planner-orchestrator.js`) and extend stubs to accept the second arg.
- [ ] **Step 4:** Tests PASS; orchestrator test green; full suite green.
- [ ] **Step 5:** Commit: `feat(truthfulness): validator rejects current-week rows past the day-weighted cap; clamp-consistent jobWindows (TDD)`

---

### Task 9: Trigger run summary + notifications

**Files:**
- Modify: `scripts/planner-trigger.js` (`buildRunSummary` ~125, `shouldNotify` ~173)
- Test: extend `scripts/test-planner-trigger.js`

- [ ] **Step 1: Write failing tests** (follow that file's existing buildRunSummary fixtures):
```js
console.log('Test N: summary renders window clamps + plan warnings');
{
  const result = { validation: { accepted: [], conflicts: [] }, finalPlan: {
    placements: [], unplacedTotal: 12.5,
    windowClamps: [{ jobName: 'MAG - BCH', station: 'bench', computedStart: '2026-06-08', computedEnd: '2026-06-12', clampedStart: '2026-06-15', clampedEnd: '2026-06-19', entirelyPast: true }],
    warnings: Array.from({ length: 20 }, (_, i) => `warning ${i}`),
    finishingCycleReport: { rows: [], invalidCount: 0 },
  } };
  const s = buildRunSummary(result, { mode: 'poll' });
  check('clamp line', s.includes('⏰ Window clamps: 1') && s.includes('MAG - BCH / bench: 2026-06-08→2026-06-15 (entirely past)'), s);
  check('warnings capped at 15', s.includes('⚠️ Plan warnings: 20') && s.includes('warning 14') && !s.includes('warning 15') && s.includes('+5 more'), s);
  check('unplaced line', s.includes('UNPLACED: 12.5'), s);
}
console.log('Test N+1: clean run (no clamps/warnings/unplaced) renders neither section');
console.log('Test N+2: shouldNotify on unplacedTotal > 0');
console.log('Test N+3: shouldNotify on clamp-induced invalid FCV row (row.clamped && !row.valid)');
console.log('Test N+4: clamps alone (feasible placement) do NOT notify');
```
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** in `buildRunSummary`, after the `Plan: N placement(s)` line:
```js
const clamps = result?.finalPlan?.windowClamps || [];
if (clamps.length > 0) {
  lines.push(`⏰ Window clamps: ${clamps.length} (late work pulled forward)`);
  for (const c of clamps) {
    lines.push(`  - ${c.jobName} / ${c.station}: ${c.computedStart}→${c.clampedStart}${c.entirelyPast ? ' (entirely past)' : ''}`);
  }
}
const planWarnings = result?.finalPlan?.warnings || [];
if (planWarnings.length > 0) {
  lines.push(`⚠️ Plan warnings: ${planWarnings.length}`);
  for (const w of planWarnings.slice(0, 15)) lines.push(`  - ${w}`);
  if (planWarnings.length > 15) lines.push(`  … +${planWarnings.length - 15} more — see logs/planner-<date>.log`);
}
const unplaced = result?.finalPlan?.unplacedTotal || 0;
if (unplaced > 0) lines.push(`🚨 UNPLACED: ${unplaced} hr(s) could not be scheduled before delivery — see warnings`);
```
`shouldNotify` additions:
```js
if ((result?.finalPlan?.unplacedTotal || 0) > 0) reasons.push(`${result.finalPlan.unplacedTotal} unplaced hour(s)`);
const clampInvalid = (result?.finalPlan?.finishingCycleReport?.rows || []).filter(r => r.clamped && !r.valid);
if (clampInvalid.length > 0) reasons.push(`${clampInvalid.length} finishing cycle(s) broken by window clamping`);
```
- [ ] **Step 4:** PASS; full suite green. **Sibling note:** if the Hrs Left build already added its shop-progress section to `buildRunSummary`, place ours after it; both are additive.
- [ ] **Step 5:** Commit: `feat(truthfulness): clamps/warnings/unplaced in trigger summary; notify on unplaced + clamp-broken cycles (TDD)`

---

### Task 10: Capacity View — current-week annotation + clamp block

**Files:**
- Modify: `scripts/capacity-view-generator.js` (`buildWeekHeader` ~285; doc assembly in `buildCapacityViewDoc`)
- Test: extend `scripts/test-capacity-view-generator.js`

- [ ] **Step 1: Write failing tests** (use that file's existing plan fixtures):
```js
console.log('Test N: current-week header annotated when nowContext present and mid-week');
// plan.nowContext = { currentWeekMonday:'2026-06-08', effectiveWeek:'2026-06-08', remainingWorkdays:2, isMidWeek:true }
// header for week 2026-06-08 contains '(in progress — 2 of 5 workdays remain)'
// header for 2026-06-15 does NOT
console.log('Test N+1: no nowContext (legacy plan JSON) → headers unchanged');
console.log('Test N+2: clamp block renders once with per-line detail');
// plan.windowClamps = [ {jobName:'MAG - BCH', station:'bench', computedStart:'2026-06-08', clampedStart:'2026-06-15', entirelyPast:true} ]
// doc contains '## ⏰ Late work pulled forward' and the BCH line
console.log('Test N+3: no clamps → block absent entirely');
```
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement:** `buildWeekHeader(weekISO, plan)` (it already receives the plan or placements — match the real signature): append the annotation when `plan?.nowContext?.isMidWeek && weekISO === plan.nowContext.currentWeekMonday`:
```js
` *(in progress — ${plan.nowContext.remainingWorkdays} of 5 workdays remain)*`
```
In `buildCapacityViewDoc`, after the finishing-cycle section (find the FCV assembly near where `finishingCycleReport` is consumed, ~line 299 region), insert:
```js
const clampLines = (plan?.windowClamps || []).map(c =>
  `- **${c.jobName}** / ${c.station}: computed ${c.computedStart}–${c.computedEnd} → ${c.clampedStart}–${c.clampedEnd}${c.entirelyPast ? ' *(entirely past — late work)*' : ''}`);
if (clampLines.length > 0) {
  sections.push(`## ⏰ Late work pulled forward\n\n${clampLines.join('\n')}`);
}
```
(Adapt to the generator's actual section-assembly idiom — read the function before editing; it may concatenate strings rather than push to an array.)
- [ ] **Step 4:** PASS; full suite green (legacy plans lack the new keys → unchanged output, anchored by Test N+1/N+3).
- [ ] **Step 5:** Commit: `feat(truthfulness): capacity view marks in-progress week + late-work clamp block (TDD)`

---

### Task 11: Config lint — stale customWindow detection

**Files:**
- Modify: `scripts/validate-config.js` (+ its `validateOverridesConfig` opts), `scripts/run-planner.js` (pass effectiveWeek)
- Test: extend `scripts/test-validate-config.js`

- [ ] **Step 1: Write failing tests:**
```js
console.log('Test N: customWindow entirely before effectiveWeek → warning');
// cfg.jobOverrides.X.customWindow.bench = { start:'2026-05-18', end:'2026-05-22' }, opts.effectiveWeek='2026-06-15'
// → warnings contains `jobOverrides[X].customWindow.bench is entirely in the past (ended 2026-05-22, effective week 2026-06-15) — stale stop-gap?`
console.log('Test N+1: window spanning effectiveWeek → no warning');
console.log('Test N+2: no effectiveWeek in opts → check skipped (back-compat)');
```
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** in `validateOverridesConfig(cfg, opts)`: iterate `cfg.jobOverrides[id].customWindow[station]`, and when `opts.effectiveWeek && win.end < opts.effectiveWeek` push the warning above. In `run-planner.js`, add `effectiveWeek: ctx.effectiveWeek` to the existing `validateOverridesConfig` opts (ctx exists from Task 8).
- [ ] **Step 4:** PASS; full suite green.
- [ ] **Step 5:** Commit: `feat(truthfulness): config lint flags customWindows entirely in the past (TDD)`

---

### Task 12: Full-suite + DRY_RUN live verification (in worktree)

- [ ] **Step 1:** Full suite with token — every file green. Record file/check counts.
- [ ] **Step 2:** `DRY_RUN=1` live plan from the worktree (PowerShell: `$env:DRY_RUN='1'; $env:MONDAY_API_TOKEN=(Get-Content .token -Raw).Trim(); node scripts/run-planner.js --plan`). Verify in output:
  - `Planning horizon:` starts at the correct effective week for the run moment (Friday after noon → this Monday with 0-day placeable; Sat/Sun → next Monday).
  - `=== CONFIG LINT ===` — the four stop-gap customWindows must NOT be flagged while still current; if run after their windows pass, the stale warnings appearing is correct behavior — note either way.
  - Clamp lines appear for any in-flight job with past computed windows; zero `could not be placed` for jobs that have stop-gap windows (they're exempt).
  - No mutations fired (DRY RUN markers on writeback/outputs).
- [ ] **Step 3:** Compare against a pre-feature baseline: `git stash` is NOT available across worktrees — instead run main's checkout (`node C:\Users\chris\Harris-Tools\scripts\run-planner.js --plan` with DRY_RUN=1) and `node scripts/diff-plans.js <main-plan> <worktree-plan>`; explain every difference (expected: placements move off the dying current week / clamped windows; nothing else).
- [ ] **Step 4:** Commit any fixes. Report findings to Chris before merge.

---

### Task 13: Merge to main + live exercise via ▶️ Planner Trigger

- [ ] **Step 1:** Merge per superpowers:finishing-a-development-branch (fast-forward or merge to `main`); immediately run the full suite on main (the poll executes from here — a broken main pages the shop, not CI).
- [ ] **Step 2:** Plan-only live run through the production path: set ▶️ Planner Trigger (board 18413101550, item 12248969189) Status = **Run Requested** (via monday MCP `change_item_column_values` or ask Chris). Within ~3 min verify: status returned to Idle, run-summary update on the trigger item shows the new ⏰/⚠️ sections (or their clean absence), Capacity View regenerated with the in-progress annotation.
- [ ] **Step 3:** Hand Chris the deploy-side verification procedure (Chris-triggered, standing practice):
  1. Mid-week (Mon–Thu), pick a quiet moment; note current-week subitem ids for one active job (monday UI).
  2. Set trigger to **Deploy Requested**.
  3. Verify: that job's current-week rows survived untouched (same ids), past-week rows survived, future-week rows rewritten; deploy summary counts match.
  4. Negative path: add an override row moving hours off the current week, re-deploy, verify THAT job's current week was rewritten (opt-out) while others stayed.
- [ ] **Step 4:** Commit nothing here unless fixes were needed (each fix = its own TDD commit).

---

### Task 14: D5 cleanup — remove the 2026-06-12 stop-gap customWindows

**Files:**
- Modify: `config/rebalance-overrides.json`

- [ ] **Step 1:** Baseline: `DRY_RUN=1 node scripts/run-planner.js --plan`; copy `logs/rebalance-plan-<today>.json` to `logs/rebalance-plan-d5-baseline.json` (a name `findLatestPlanFile`'s strict date regex will NOT pick up).
- [ ] **Step 2:** Edit config — remove the entire `customWindow` objects from **BCH (11693166564)** (panel 6/08–6/19 + bench 6/15–6/19) and **R5-P2 (11835189937)** (panel 6/15–6/19 + bench 6/15–6/26). KEEP: both jobs' `remainingHours` + `parallelPostFin`, the Spencer 31.5h forceAssignment @ 6/15, everything else. Update both jobs' `note` fields: append `| <date>: stop-gap customWindows removed — superseded by current-week truthfulness (clamping reproduces them).`
- [ ] **Step 3:** Re-run `DRY_RUN=1 --plan`; `node scripts/diff-plans.js logs/rebalance-plan-d5-baseline.json logs/rebalance-plan-<today>.json`. Expected: zero placement differences (clamped auto-windows reproduce the stop-gaps: BCH bench → 6/15–6/19, BCH panel → 6/15, R5-P2 bench → 6/15–6/26, R5-P2 panel → 6/15). **Any non-zero diff: STOP, show Chris, do not commit until he approves the delta.**
- [ ] **Step 4:** On Chris's approval: `git add config/rebalance-overrides.json && git commit -m "config: remove 2026-06-12 stop-gap customWindows (BCH, R5-P2) — clamping supersedes; plan verified unchanged"` — commit IMMEDIATELY (shared working tree).
- [ ] **Step 5:** Delete `logs/rebalance-plan-d5-baseline.json`.

---

### Task 15: Documentation + build record + memory

**Files:**
- Modify: `docs/operations-manual.md`, `docs/superpowers/specs/2026-06-12-current-week-truthfulness-design.md`
- Modify: memory `project_overrides_build_worktree.md`

- [ ] **Step 1:** Ops-manual edits (then bump "Last updated"):
  - §1 table, Saturday row → "Full planning run for the **upcoming** week — fresh plan, fresh 📊 Capacity View, fresh 📋 Weekly Briefing for Monday morning. The just-finished week is closed; placements land Monday onward."
  - §1 table, "On every planning run" row: append "; late station windows are pulled forward automatically and reported (⏰ in the run summary)".
  - §2.3 deploy: append "Deploys never touch past weeks (history) or the current week's existing rows (committed reality) — only future weeks are rewritten. Exception: a job whose override row moves work into/out of the current week gets its current week rewritten too."
  - §2.5 delivery-date note: replace "> If production is already in flight and windows land in the past, the run's warnings will say so — that currently needs Chris (config window override)." with "> If production is already in flight and computed windows land in the past, the planner pulls them forward to the current week automatically and reports it (⏰ in the run summary; 🚨 + a notification if hours can no longer fit before delivery)."
  - §4.2 customWindow bullet: append "Windows lying entirely in the past are flagged by the config lint as stale — remove them."
  - §5 table: add row "⏰ Window clamps in the run summary | A job is running behind its computed schedule; the planner pulled the late station(s) forward | Usually nothing — it's informational. If 🚨 UNPLACED appears with it, hours no longer fit before delivery: move the delivery date or add capacity."
- [ ] **Step 2:** Republish the monday ops-manual copy (doc **18417585088**) — same procedure as commit `ace0736` (check `git show ace0736` for the method; monday MCP `update_doc` flow).
- [ ] **Step 3:** Append the Build record to the spec: commits, suite counts before/after, DRY_RUN + trigger-run evidence, D5 diff result, the Chris-triggered deploy checklist status (done/pending).
- [ ] **Step 4:** Update memory `project_overrides_build_worktree.md`: current-week truthfulness LIVE; remove "computeWindows past-window clamp" from the remaining-backlog list.
- [ ] **Step 5:** Commit docs: `docs: operations manual — current-week truthfulness behavior (clamps, deploy preservation, weekend rollover); spec build record`

---

## Self-review notes

- **Spec coverage:** D1→Tasks 2/5, D2→Tasks 3/4/9/10/11, D3→Tasks 6/7 (+13 live), D4→Tasks 2/4, D5→Task 14, reporting→9/10, validator→8, docs→15. Past-week history bug→Task 7. No-throw-on-clamp→Task 3.
- **Type consistency:** `nowContext` shape `{ currentWeekMonday, effectiveWeek, remainingWorkdays, isMidWeek }` used identically in Tasks 2, 4, 5, 6, 7, 8, 10. `windowClamps` entry shape `{ jobId, jobName, station, computedStart, computedEnd, clampedStart, clampedEnd, entirelyPast }` used in Tasks 3, 4, 9, 10. `placeable` (grid) / `placeableAvail` (report JSON) naming is deliberate — grid-internal vs persisted.
- **Known judgment calls for the executor:** Task 5's weekendBoost interaction must be verified against the real PATCH D field names before committing; Task 10 must adapt to the generator's actual section-assembly idiom; Task 8 must match the orchestrator stubs' call signature. Each is flagged in its step.
