# Partial-Station Progress Entry (⏳ Hrs Left) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the shop floor (Bob) report partial station progress as per-station "Hrs Left" numbers on the Production Load Board, consumed by the planner with zero Chris/config involvement.

**Architecture:** Five `numbers` columns on the PLB feed a new tier in `computeRemainingHours` (tick > board Hrs Left > config remainingHours > formula). A pure `shopProgressWarnings` function surfaces nudges/contradictions/overruns in the run summary (summary-only, never notifies, never blocks). `isReadyToShip` gains a required-set extension so board-added work can't be skipped. Spec: `docs/superpowers/specs/2026-06-12-partial-station-progress-design.md` (approved 2026-06-12).

**Tech Stack:** Plain Node (no frameworks), existing 28-file `scripts/test-*.js` suite conventions (`check()` helpers, exit 1 on failure), monday MCP for board ops, monday GraphQL API-Version `next`.

**Execution ground rules (non-negotiable, from project memory + ops manual):**
- The system is LIVE: a Task Scheduler poll tick runs `planner-trigger.js` from `main` every minute. Work directly on main is OK (poll is read-only unless someone sets Run Requested) but **commit every file in the same breath as editing it** — parallel sessions share this working tree and can silently restore uncommitted edits.
- `git add` ONLY the files named in each task — the tree carries other sessions' edits (`docs/htw-cross-training-matrix.md`, `docs/operations-manual.md`, untracked `skills/` folders). Never `git add -A`.
- DRY_RUN-verify before any live run. Destructive/negative-path live verification is Chris-triggered, never yours.
- Tests must run without `MONDAY_API_TOKEN` (pure-function pattern; only one suite file needs the token).
- Append the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` to every commit (omitted from the snippets below for brevity).

**Run the suite:** `node scripts/test-stations-complete.js` (single file) / all files: `Get-ChildItem scripts/test-*.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { throw $_.Name } }`

---

### Task 1: Create the five ⏳ Hrs Left columns on the Production Load Board

Live-board op, additive only (approved in spec §Board changes). No code, no commit.

**Files:** none (board 18407601557).

- [ ] **Step 1: Create the columns via monday MCP `create_column`** — five calls, boardId `18407601557`, columnType `numbers`:

| title | description (use verbatim, swap station name) |
|---|---|
| `⏳ Eng Hrs Left` | `Shop-floor estimate of remaining Engineering hours. Empty = planner uses config/formula. 0 = nothing left (also tick ✅ Stations Complete if truly done). May exceed the formula if the job is running over. Read by the planner on every run.` |
| `⏳ Panel Hrs Left` | same, "Panel Processing hours" |
| `⏳ Bench Hrs Left` | same, "Benchwork hours" |
| `⏳ PreFin Hrs Left` | same, "Pre Fin Cab Assembly hours" |
| `⏳ PostFin Hrs Left` | same, "Post Fin Cab Assembly hours" |

- [ ] **Step 2: Verify + record ids** — `get_board_info(18407601557)`, confirm five new `numbers` columns; record their column ids in this plan file (edit the table below) for Task 7:

| station | column id |
|---|---|
| eng | _(fill in)_ |
| panel | _(fill in)_ |
| bench | _(fill in)_ |
| prefin | _(fill in)_ |
| postfin | _(fill in)_ |

- [ ] **Step 3: Commit the plan-file id update**

```powershell
git add docs/superpowers/plans/2026-06-12-partial-station-progress.md
git commit -m "plan: record PLB Hrs Left column ids"
```

---

### Task 2: `computeRemainingHours` — board Hrs Left tier (TDD)

**Files:**
- Modify: `scripts/rebalance-schedule.js:101-112` (function + comment), exports block ~line 2295
- Test: `scripts/test-stations-complete.js` (append after Test 6, before the final summary block)

- [ ] **Step 1: Write the failing tests** — append to `scripts/test-stations-complete.js` (inside the async IIFE, after Test 6):

```js
  console.log('\nTest 7: ⏳ Hrs Left tier — between tick and config');
  {
    const HL = { eng: 7, panel: 5, bench: 0, prefin: null, postfin: 12 };
    const CFG = { eng: 4, panel: 8, bench: 2.3, prefin: 6, postfin: 5 };
    const h = computeRemainingHours(FORMULA, CFG, ['Eng'], HL);
    check('tick beats Hrs Left (Eng 0 despite ⏳7)', h.eng === 0, JSON.stringify(h));
    check('Hrs Left beats config (Panel 5 not 8)', h.panel === 5, JSON.stringify(h));
    check('explicit 0 honored (Bench 0 not 2.3)', h.bench === 0, JSON.stringify(h));
    check('empty cell falls through to config (PreFin 6)', h.prefin === 6, JSON.stringify(h));
    check('Hrs Left beats config (PostFin 12 not 5)', h.postfin === 12, JSON.stringify(h));
  }

  console.log('\nTest 8: ⏳ Hrs Left — formula fallback, overrun unclamped, invalid ignored, back-compat');
  {
    const h0 = computeRemainingHours(FORMULA, null, [], { eng: null, panel: null, bench: 1, prefin: null, postfin: null });
    check('no config: Hrs Left beats formula (Bench 1 not 2.3)', h0.bench === 1 && h0.panel === 19.5, JSON.stringify(h0));
    const h1 = computeRemainingHours(FORMULA, null, [], { eng: null, panel: 99, bench: null, prefin: null, postfin: null });
    check('overrun passes verbatim (99 > formula 19.5, never clamped)', h1.panel === 99, JSON.stringify(h1));
    const h2 = computeRemainingHours(FORMULA, null, [], { eng: -3, panel: NaN, bench: null, prefin: null, postfin: null });
    check('negative ignored → formula', h2.eng === 8.6, JSON.stringify(h2));
    check('NaN ignored → formula', h2.panel === 19.5, JSON.stringify(h2));
    const h3 = computeRemainingHours(FORMULA, null, []);
    check('missing 4th arg ≡ legacy behavior', h3.panel === 19.5 && h3.eng === 8.6, JSON.stringify(h3));
  }
```

- [ ] **Step 2: Run to verify failure**

Run: `node scripts/test-stations-complete.js`
Expected: Tests 7/8 FAIL (e.g., `Hrs Left beats config (Panel 5 not 8)` — current function ignores the 4th arg). Tests 1–6 still pass.

- [ ] **Step 3: Implement** — in `scripts/rebalance-schedule.js`, replace the function + its comment (currently lines 101–112) with:

```js
// Per-station precedence: board-done → 0 (ALWAYS wins — the board is live
// shop-floor truth and kills config staleness) → else board ⏳ Hrs Left (a
// non-empty cell is the shop's current remaining estimate, verbatim — may
// exceed the formula on overruns, never clamped; spec 2026-06-12) → else
// config remainingHours → else formula. Unknown labels are ignored.
function computeRemainingHours(formulaHours, overrideRemaining, stationsComplete, hrsLeft) {
  const done = new Set((stationsComplete || []).map(l => STATION_LABEL_TO_KEY[l]).filter(Boolean));
  const base = overrideRemaining && overrideRemaining !== null ? overrideRemaining : (formulaHours || {});
  const hl = hrsLeft || {};
  const out = {};
  for (const k of STATION_HOUR_KEYS) {
    if (done.has(k)) { out[k] = 0; continue; }
    out[k] = isValidHrsLeft(hl[k]) ? hl[k] : Number(base[k] || 0);
  }
  return out;
}

// A usable ⏳ Hrs Left value: finite number ≥ 0. Anything else (null for an
// empty cell, NaN, negatives) falls through to config/formula;
// shopProgressWarnings surfaces the garbage.
function isValidHrsLeft(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}
```

Add `isValidHrsLeft,` to `module.exports` (next to `computeRemainingHours`, ~line 2296).

- [ ] **Step 4: Run to verify pass**

Run: `node scripts/test-stations-complete.js`
Expected: `✅ All stations-complete tests passed` (check count grows by 10).

- [ ] **Step 5: Commit**

```powershell
git add scripts/rebalance-schedule.js scripts/test-stations-complete.js
git commit -m "feat(progress): computeRemainingHours gains board Hrs Left tier (tick > hrsLeft > config > formula)"
```

---

### Task 3: `isReadyToShip` — required-set extension (TDD)

**Files:**
- Modify: `scripts/rebalance-schedule.js:114-125`
- Test: `scripts/test-stations-complete.js` (append after Test 8)

- [ ] **Step 1: Write the failing tests:**

```js
  console.log('\nTest 9: isReadyToShip — ⏳ required-set extension');
  {
    const F = { eng: 4, panel: 8, bench: 0, prefin: 0, postfin: 5 };
    check('legacy 2-arg: all formula>0 ticked → true',
      isReadyToShip(F, ['Eng', 'Panel', 'PostFin']) === true, '');
    check('board-added work blocks RTS (bench formula 0, ⏳5, unticked)',
      isReadyToShip(F, ['Eng', 'Panel', 'PostFin'], { bench: 5 }) === false, '');
    check('ticking the board-added station restores RTS (tick wins per spec)',
      isReadyToShip(F, ['Eng', 'Panel', 'PostFin', 'Bench'], { bench: 5 }) === true, '');
    check('⏳0 does not add a required station',
      isReadyToShip(F, ['Eng', 'Panel', 'PostFin'], { bench: 0 }) === true, '');
    check('all-zero formulas + empty hrsLeft → still false',
      isReadyToShip({ eng: 0, panel: 0, bench: 0, prefin: 0, postfin: 0 }, ['Eng'], {}) === false, '');
  }
```

- [ ] **Step 2: Run to verify failure** — `node scripts/test-stations-complete.js`; expected FAIL on `board-added work blocks RTS`.

- [ ] **Step 3: Implement** — replace `isReadyToShip` (keep its existing comment block, append one line to it):

```js
// True when EVERY station with formula hours > 0 is marked done. Drives the
// derived "Ready to Ship" status in run-planner.js: production is finished
// but the job stays ACTIVE so P&S/Delivery keep planning (the Liz Stapp
// Complete-cliff fix — flipping straight to Complete dropped jobs while
// delivery work remained). All-zero formulas → false (nothing to complete
// is not the same as ready).
// 2026-06-12: a station with board ⏳ Hrs Left > 0 also counts as required
// even at formula 0 — board-added work can't be skipped by the RTS flip.
function isReadyToShip(formulaHours, stationsComplete, hrsLeft) {
  const done = new Set((stationsComplete || []).map(l => STATION_LABEL_TO_KEY[l]).filter(Boolean));
  const hl = hrsLeft || {};
  const required = STATION_HOUR_KEYS.filter(k =>
    Number((formulaHours || {})[k] || 0) > 0
    || (isValidHrsLeft(hl[k]) && hl[k] > 0));
  if (required.length === 0) return false;
  return required.every(k => done.has(k));
}
```

- [ ] **Step 4: Run to verify pass** — `node scripts/test-stations-complete.js` → all green.

- [ ] **Step 5: Commit**

```powershell
git add scripts/rebalance-schedule.js scripts/test-stations-complete.js
git commit -m "feat(progress): isReadyToShip counts board-added Hrs Left stations as required"
```

---

### Task 4: `parseHrsLeftCell` — monday cell text → null | number (TDD)

**Files:**
- Modify: `scripts/rebalance-schedule.js` (new function near `computeRemainingHours`; export)
- Test: `scripts/test-stations-complete.js` (append after Test 9; add `parseHrsLeftCell` to the require at the top)

- [ ] **Step 1: Write the failing tests** (also add `parseHrsLeftCell,` and `isValidHrsLeft,` to the destructured `require('./rebalance-schedule.js')` at the top of the test file):

```js
  console.log('\nTest 10: parseHrsLeftCell — monday numbers-column text');
  {
    check('empty string → null (empty cell ≠ 0)', parseHrsLeftCell('') === null, '');
    check('undefined → null', parseHrsLeftCell(undefined) === null, '');
    check('whitespace → null', parseHrsLeftCell('  ') === null, '');
    check('"0" → 0 (explicit zero)', parseHrsLeftCell('0') === 0, '');
    check('"102" → 102', parseHrsLeftCell('102') === 102, '');
    check('"2.3" → 2.3', parseHrsLeftCell('2.3') === 2.3, '');
    check('"1,234" → 1234 (thousands separator)', parseHrsLeftCell('1,234') === 1234, '');
    check('"-5" → -5 (sanitized downstream by isValidHrsLeft)', parseHrsLeftCell('-5') === -5, '');
    check('isValidHrsLeft rejects null/-5/NaN, accepts 0/2.3',
      !isValidHrsLeft(null) && !isValidHrsLeft(-5) && !isValidHrsLeft(NaN)
      && isValidHrsLeft(0) && isValidHrsLeft(2.3), '');
  }
```

- [ ] **Step 2: Run to verify failure** — `parseHrsLeftCell is not a function`.

- [ ] **Step 3: Implement** — add below `isValidHrsLeft` in `rebalance-schedule.js`, and export:

```js
// monday numbers-column text → null (empty cell = "no board info") or a
// number. May return NaN/negative for garbage — isValidHrsLeft gates use.
function parseHrsLeftCell(text) {
  const t = (text ?? '').trim();
  return t === '' ? null : parseFloat(t.replace(/,/g, ''));
}
```

- [ ] **Step 4: Run to verify pass** — `node scripts/test-stations-complete.js` → all green.

- [ ] **Step 5: Commit**

```powershell
git add scripts/rebalance-schedule.js scripts/test-stations-complete.js
git commit -m "feat(progress): parseHrsLeftCell — empty monday cell is null, never 0"
```

---

### Task 5: `shopProgressWarnings` — nudges, contradictions, overrun info (TDD)

**Files:**
- Modify: `scripts/rebalance-schedule.js` (new function + two constants; exports)
- Test: `scripts/test-stations-complete.js` (append after Test 10; add `shopProgressWarnings` to the require)

- [ ] **Step 1: Write the failing tests:**

```js
  console.log('\nTest 11: shopProgressWarnings — nudges, contradictions, overrun info');
  {
    const F = { eng: 4, panel: 8, bench: 10, prefin: 0, postfin: 5 };
    const empty = { eng: null, panel: null, bench: null, prefin: null, postfin: null };
    const jobs = [
      { name: 'NudgeJob', status: 'Scheduled', formulaHours: F,
        stationsComplete: [], hrsLeft: { ...empty, panel: 0 } },
      { name: 'ContraJob', status: 'Finishing', formulaHours: F,
        stationsComplete: ['Bench'], hrsLeft: { ...empty, bench: 6 } },
      { name: 'OverrunJob', status: 'Not Started', formulaHours: F,
        stationsComplete: [], hrsLeft: { ...empty, panel: 30 } },
      { name: 'InvalidJob', status: 'Scheduled', formulaHours: F,
        stationsComplete: [], hrsLeft: { ...empty, eng: -2 } },
      { name: 'CompleteJob', status: 'Complete', formulaHours: F,
        stationsComplete: [], hrsLeft: { ...empty, panel: 0 } },
      { name: 'QuietJob', status: 'Scheduled', formulaHours: F,
        stationsComplete: [], hrsLeft: { ...empty, panel: 5 } },
    ];
    const w = shopProgressWarnings(jobs);
    check('tick nudge fired', w.some(x => /NudgeJob Panel: .*0 but station not ticked/.test(x)), JSON.stringify(w));
    check('contradiction fired (tick wins)', w.some(x => /ContraJob Bench: ticked complete but/.test(x)), JSON.stringify(w));
    check('overrun info fired', w.some(x => /OverrunJob Panel: .*30 exceeds formula 8/.test(x)), JSON.stringify(w));
    check('invalid value fired', w.some(x => /InvalidJob Eng: invalid/.test(x)), JSON.stringify(w));
    check('Complete jobs skipped', !w.some(x => /CompleteJob/.test(x)), JSON.stringify(w));
    check('healthy partial entry silent (5 < formula 8)', !w.some(x => /QuietJob/.test(x)), JSON.stringify(w));
    check('exactly 4 warnings', w.length === 4, JSON.stringify(w));
    check('null/empty jobs safe', Array.isArray(shopProgressWarnings(null)) && shopProgressWarnings([]).length === 0, '');
  }
```

- [ ] **Step 2: Run to verify failure** — `shopProgressWarnings is not a function`.

- [ ] **Step 3: Implement** — add below `parseHrsLeftCell`; export `shopProgressWarnings` (constants stay module-private):

```js
// Run-summary warnings for the ⏳ Hrs Left columns (spec 2026-06-12).
// Summary-only: never blocks the run, never triggers a notification.
const PROGRESS_WARN_STATUSES = new Set([
  'Not Started', 'Ready to Schedule', 'Scheduled', 'Finishing', 'Ready to Ship',
]);
const STATION_KEY_TO_LABEL = Object.freeze(
  Object.fromEntries(Object.entries(STATION_LABEL_TO_KEY).map(([l, k]) => [k, l])));

function shopProgressWarnings(jobs) {
  const warnings = [];
  for (const j of jobs || []) {
    if (!PROGRESS_WARN_STATUSES.has(j.status)) continue;
    const done = new Set((j.stationsComplete || []).map(l => STATION_LABEL_TO_KEY[l]).filter(Boolean));
    const hl = j.hrsLeft || {};
    for (const k of STATION_HOUR_KEYS) {
      const v = hl[k];
      if (v === null || v === undefined) continue;
      const label = STATION_KEY_TO_LABEL[k];
      const f = Number((j.formulaHours || {})[k] || 0);
      if (!isValidHrsLeft(v)) {
        warnings.push(`${j.name} ${label}: invalid ⏳ Hrs Left (${v}) ignored — using config/formula`);
      } else if (done.has(k) && v > 0) {
        warnings.push(`${j.name} ${label}: ticked complete but ⏳ Hrs Left is ${v} — tick wins (0 hrs); clear the cell or untick`);
      } else if (!done.has(k) && v === 0) {
        warnings.push(`${j.name} ${label}: ⏳ Hrs Left is 0 but station not ticked — tick ✅ Stations Complete if truly done`);
      } else if (v > f + 1e-9) {
        warnings.push(`${j.name} ${label}: ⏳ Hrs Left ${v} exceeds formula ${f} — overrun or change order pending (info)`);
      }
    }
  }
  return warnings;
}
```

- [ ] **Step 4: Run to verify pass** — `node scripts/test-stations-complete.js` → all green.

- [ ] **Step 5: Commit**

```powershell
git add scripts/rebalance-schedule.js scripts/test-stations-complete.js
git commit -m "feat(progress): shopProgressWarnings — tick nudge, contradiction, overrun info, invalid"
```

---

### Task 6: Anchor the pin-vs-remaining edge (spec §Code 4)

Current behavior already exists — PATCH 5 in `scheduleStation` (`rebalance-schedule.js:1547-1553`) warns `forceAssignment exceeds remaining job budget … placements stand` and clamps budget tracking, no throw. It is **not test-anchored anywhere** (verified 2026-06-12). Board Hrs Left shrinking a station below a config pin flows through the same `hours` parameter, so one test anchors the whole edge. This test should **pass immediately** — it anchors existing behavior; if it fails, STOP and investigate before proceeding.

**Files:**
- Test: `scripts/test-force-unplaced-accounting.js` (append after Test 3, before the final summary block)

- [ ] **Step 1: Write the anchor test** — uses the file's existing `buildGrid`/`syntheticJob` helpers and its 31.5h Spencer force fixture:

```js
console.log('\nTest 4 (spec 2026-06-12 §Code 4): force exceeding board-shrunk remaining warns + places, never throws');
{
  // Shop floor reports ⏳ Hrs Left = 10 while a 31.5h force is pinned: the
  // station budget (10) is below the force. PATCH-5 behavior: place the
  // force (operator pin wins), warn loudly, clamp budget tracking, no throw.
  const grid = buildGrid({ bobW2Committed: 0 });
  const job = syntheticJob(FORCED_JOB_ID);
  let result, threw = null;
  try {
    result = scheduleStation(grid, job, 'Benchwork', 10, W2, W2);
  } catch (e) { threw = e; }
  check('no throw', threw === null, threw && threw.message);
  const forced = (result?.placements || []).filter(p => p.forced);
  check('force still placed in full (31.5h, placements stand)',
        forced.length === 1 && Math.abs(forced[0].hours - 31.5) < 0.01, JSON.stringify(forced));
  check('budget warning emitted',
        (result?.warnings || []).some(w => /exceeds remaining job budget/.test(w)),
        JSON.stringify(result?.warnings));
  check('no spurious unplaced hours', Math.abs(result?.unplaced || 0) < 0.01, `unplaced=${result?.unplaced}`);
}
```

- [ ] **Step 2: Run — expect immediate PASS** — `node scripts/test-force-unplaced-accounting.js`. If any check fails, STOP: current behavior differs from the spec's assumption; report to Chris before continuing.

- [ ] **Step 3: Commit**

```powershell
git add scripts/test-force-unplaced-accounting.js
git commit -m "test(progress): anchor PATCH-5 force-exceeds-remaining behavior (warn + place, no throw)"
```

---

### Task 7: `loadJobs` wiring — read the five columns

No new pure logic (parsing already TDD'd in Task 4); this is mechanical wiring, verified end-to-end by Task 8's orchestrator test and Task 10's live DRY_RUN.

**Files:**
- Modify: `scripts/rebalance-schedule.js` — `COL_PL` (~line 85) and `loadJobs` (~lines 447-471)

- [ ] **Step 1: Add column ids to `COL_PL`** (ids from Task 1's table), after the `stationsComplete` entry:

```js
  // 2026-06-12 — shop-floor partial progress (⏳ Hrs Left, numbers columns).
  // Empty cell = no info; see computeRemainingHours precedence.
  hrsLeftEng: '<id from Task 1>',
  hrsLeftPanel: '<id from Task 1>',
  hrsLeftBench: '<id from Task 1>',
  hrsLeftPrefin: '<id from Task 1>',
  hrsLeftPostfin: '<id from Task 1>',
```

- [ ] **Step 2: Parse in `loadJobs`** — after the `stationsComplete` parse (~line 451), replace the `const hours = …` line and add `hrsLeft` to the returned object:

```js
    // ⏳ Hrs Left (2026-06-12): shop-floor remaining-hours estimate per
    // station. Empty cell → null (falls through to config/formula).
    const hrsLeft = {
      eng: parseHrsLeftCell(cv[COL_PL.hrsLeftEng]?.text),
      panel: parseHrsLeftCell(cv[COL_PL.hrsLeftPanel]?.text),
      bench: parseHrsLeftCell(cv[COL_PL.hrsLeftBench]?.text),
      prefin: parseHrsLeftCell(cv[COL_PL.hrsLeftPrefin]?.text),
      postfin: parseHrsLeftCell(cv[COL_PL.hrsLeftPostfin]?.text),
    };

    const hours = computeRemainingHours(formulaHours, override.remainingHours || null, stationsComplete, hrsLeft);
```

and in the `return { … }` object add `hrsLeft,` directly under `stationsComplete,`.

- [ ] **Step 3: Run the two touched suites as a smoke check**

Run: `node scripts/test-stations-complete.js; node scripts/test-force-unplaced-accounting.js`
Expected: both green (wiring is additive; nothing references the new ids in tests).

- [ ] **Step 4: Commit**

```powershell
git add scripts/rebalance-schedule.js
git commit -m "feat(progress): loadJobs reads the five PLB Hrs Left columns"
```

---

### Task 8: `run-planner.js` wiring — progress section, return field, RTS call site (TDD)

**Files:**
- Modify: `scripts/run-planner.js` — after the CONFIG LINT console block (~line 138), the early return (~line 237), the final return (~line 370), and the `rtsCandidates` filter (~line 285)
- Test: `scripts/test-run-planner-orchestrator.js` (new Test 16c after Test 16b, which ends ~line 934)

- [ ] **Step 1: Write the failing test** — read Test 16b (`test-run-planner-orchestrator.js:861-934`) and clone its local harness (the `mkBoards`/`run(dry)` pattern with console capture + gql-call recording) into a new Test 16c with these fixture jobs and assertions:

```js
  console.log('\nTest 16c: ⏳ HRS LEFT — progress warnings in result + RTS required-set extension');
  {
    const empty = { eng: null, panel: null, bench: null, prefin: null, postfin: null };
    // mkBoards: clone Test 16b's mkBoards shape, with these two jobs:
    //  1) Would flip RTS on ticks alone, but bench (formula 0) carries ⏳5 → must NOT flip.
    { id: 'PL-HL-BLOCK', masterPmId: 'MPM-HLB', name: 'Blocked By Board Hours', delivery: '2026-06-26', status: 'Finishing',
      formulaHours: { eng: 4, panel: 8, bench: 0, prefin: 0, postfin: 5 },
      stationsComplete: ['Eng', 'Panel', 'PostFin'],
      hrsLeft: { ...empty, bench: 5 },
      hours: { eng: 0, panel: 0, bench: 5, prefin: 0, postfin: 0 } },
    //  2) ⏳0 unticked → nudge warning.
    { id: 'PL-HL-NUDGE', masterPmId: 'MPM-HLN', name: 'Nudge Me', delivery: '2026-07-02', status: 'Scheduled',
      formulaHours: { eng: 4, panel: 8, bench: 10, prefin: 0, postfin: 5 },
      stationsComplete: [],
      hrsLeft: { ...empty, panel: 0 },
      hours: { eng: 4, panel: 0, bench: 10, prefin: 0, postfin: 5 } },
    // Assertions (live run, like Test 16b's run(false)):
    check('console prints SHOP-FLOOR PROGRESS section', /=== SHOP-FLOOR PROGRESS ===/.test(blob), blob.slice(-600));
    check('result carries progressWarnings array', Array.isArray(result.progressWarnings), typeof result.progressWarnings);
    check('nudge warning present', result.progressWarnings.some(w => /Nudge Me Panel/.test(w)), JSON.stringify(result.progressWarnings));
    check('board-added-work info present (bench ⏳5 > formula 0)',
      result.progressWarnings.some(w => /Blocked By Board Hours Bench/.test(w)), JSON.stringify(result.progressWarnings));
    check('exactly 2 warnings', result.progressWarnings.length === 2, JSON.stringify(result.progressWarnings));
    check('NO RTS flip (bench ⏳5 blocks despite all formula>0 ticks)',
      gqlCalls.filter(c => /change_multiple_column_values/.test(c.q) && /Ready to Ship/.test(JSON.stringify(c.v))).length === 0,
      JSON.stringify(gqlCalls.map(c => c.v)));
  }
```

Note: Test 16c needs `result` — capture `runPlanner`'s return value in the cloned harness (16b discards it; have `run()` return `{ gqlCalls, blob, result }`).

- [ ] **Step 2: Run to verify failure** — `node scripts/test-run-planner-orchestrator.js`; expected: 16c fails on missing `=== SHOP-FLOOR PROGRESS ===` / `progressWarnings` undefined / RTS flip DOES fire for PL-HL-BLOCK. Tests 1–16b must still pass.

- [ ] **Step 3: Implement in `run-planner.js`** (confirm the existing `reb` require name at the top of the file; it's the same module used at line ~280):

(a) After the CONFIG LINT console block (after the `for (const w of configLint.warnings)` line, ~line 138):

```js
  // ⏳ Hrs Left progress warnings (spec 2026-06-12): summary-only visibility
  // for shop-floor partial-progress entries — tick nudges, contradictions,
  // overrun info. Never blocks the run, never notifies.
  const _progressWarnings = (deps.shopProgressWarnings || reb.shopProgressWarnings)(boards.jobs || []);
  console.log('\n=== SHOP-FLOOR PROGRESS ===');
  if (_progressWarnings.length === 0) console.log('  clean ✅');
  for (const w of _progressWarnings) console.log(`  ⚠️  ${w}`);
```

(b) Early return ~line 237: `return { baselinePlan, validation, planError: msg, progressWarnings: _progressWarnings };`

(c) Final return ~line 370: add `progressWarnings: _progressWarnings,` to the object.

(d) `rtsCandidates` filter ~line 285: `_isReadyToShip(j.formulaHours, j.stationsComplete, j.hrsLeft)` (third arg added).

- [ ] **Step 4: Run to verify pass** — `node scripts/test-run-planner-orchestrator.js` → all green including 16c.

- [ ] **Step 5: Commit**

```powershell
git add scripts/run-planner.js scripts/test-run-planner-orchestrator.js
git commit -m "feat(progress): run-planner surfaces shop-floor progress warnings; RTS honors board Hrs Left"
```

---

### Task 9: `buildRunSummary` rendering + notification policy unchanged (TDD)

**Files:**
- Modify: `scripts/planner-trigger.js` — `buildRunSummary` (~line 125-170)
- Test: `scripts/test-planner-trigger.js` — extend Test 4 (~line 171)

- [ ] **Step 1: Write the failing tests** — append inside Test 4's block (after the `s4` checks, reusing its `meta` and `cleanResult()`):

```js
    const r5 = cleanResult();
    r5.progressWarnings = ['Nudge Me Panel: ⏳ Hrs Left is 0 but station not ticked — tick ✅ Stations Complete if truly done'];
    const s5 = buildRunSummary(r5, meta);
    check('progress warnings surfaced in summary', /Shop-floor progress: 1 note/.test(s5) && /Nudge Me Panel/.test(s5), s5);
    check('clean result has no progress block', !/Shop-floor progress/.test(buildRunSummary(cleanResult(), meta)), '');
    check('progress warnings alone do NOT notify (summary-only per spec)',
      shouldNotify(r5).notify === false, JSON.stringify(shouldNotify(r5)));
```

- [ ] **Step 2: Run to verify failure** — `node scripts/test-planner-trigger.js`; expected FAIL on `progress warnings surfaced in summary`. The `do NOT notify` check passes already (anchor against future regression).

- [ ] **Step 3: Implement** — in `buildRunSummary`, after the conflicts `for` loop (line ~135), before the `planError` block:

```js
  // ⏳ shop-floor progress notes (spec 2026-06-12) — summary-only, no
  // notification (shouldNotify deliberately ignores these).
  const pw = result?.progressWarnings || [];
  if (pw.length > 0) {
    lines.push(`Shop-floor progress: ${pw.length} note(s)`);
    for (const w of pw) lines.push(`  ⚠️ ${w}`);
  }
```

Do NOT touch `shouldNotify`.

- [ ] **Step 4: Run to verify pass** — `node scripts/test-planner-trigger.js` → all green.

- [ ] **Step 5: Commit**

```powershell
git add scripts/planner-trigger.js scripts/test-planner-trigger.js
git commit -m "feat(progress): trigger run-summary renders shop-floor progress notes (summary-only)"
```

---

### Task 10: Full suite + live DRY_RUN verification

**Files:** none modified.

- [ ] **Step 1: Run the full suite** (one file needs `MONDAY_API_TOKEN` — the `.bat` convention auto-loads `.token`; if running raw, set `$env:MONDAY_API_TOKEN = (Get-Content .token -Raw).Trim()` first):

```powershell
Get-ChildItem scripts/test-*.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { throw $_.Name } }
```

Expected: all 28 files green.

- [ ] **Step 2: Live DRY_RUN** — `$env:DRY_RUN = '1'; node scripts/run-planner.js --plan`
Expected: `=== SHOP-FLOOR PROGRESS ===` section prints `clean ✅` (no cells populated yet); plan completes; zero board/doc mutations (dry writeback lines only); placements identical in character to the previous run (no hours changed — all cells empty). Save the persisted plan JSON path printed by the run; it is the **baseline for Task 12's diff**. Clear the env var after: `Remove-Item Env:DRY_RUN`.

- [ ] **Step 3: Report** — paste the SHOP-FLOOR PROGRESS section and the plan summary line into the session for the record. No commit.

---

### Task 11: 🔧 Shop Floor view on the PLB

**Files:** none (board 18407601557).

- [ ] **Step 1: Create** via monday MCP `create_view_table` (or `create_view` type table) on board 18407601557, name `🔧 Shop Floor`.
- [ ] **Step 2: Configure** via `update_view_table`: visible columns ONLY `name`, `dropdown_mm48p4zs` (✅ Stations Complete), and the five ⏳ columns from Task 1, in that order. Filter: `color_mm26404x` (Production Status) ANY_OF the label ids for {Not Started, Ready to Schedule, Scheduled, Finishing} — ids 5, 13, 14, 8 per the board's status settings (compare_value uses label ids; Finish Booking view at `get_board_info` shows the working filter shape).
- [ ] **Step 3: Fallback** — if the MCP view tools can't express the filter, set columns only and tell Chris the one-time 10-second UI step ("add filter: Production Status is any of Not Started / Ready to Schedule / Scheduled / Finishing"). Do not fight the API.
- [ ] **Step 4: Verify** — `get_board_info(18407601557)` shows the view with expected column visibility; report the view id.

---

### Task 12: Backfill current reality — ⚠️ CHRIS APPROVAL GATE

Per spec: copy config remaining values to the board for active jobs; **config stays untouched** (shadowed, whole-object semantics — never delete individual station keys). BCH's bench customWindow (6/15–6/19) is a window pin — not touched by this task.

**Files:** none in repo (board writes only, after approval).

- [ ] **Step 1: Fetch live statuses** — monday MCP `get_board_items_page` on 18407601557 (columns: `color_mm26404x`, `dropdown_mm48p4zs`). Active = status ∉ {Complete}. Cross-reference with `config/rebalance-overrides.json` `jobOverrides` (skip `skipJobs` entries, e.g. Wrangler Way 11693166519).
- [ ] **Step 2: Build the per-job backfill table** with one row per (job × station) where config `remainingHours` exists, proposing per station:
  - config value > 0 → write that value to the ⏳ column (e.g., **R5-P2 11835189937 bench → 102**, panel → 22, postfin → 16; SciTech panel → 8, bench → 2.3; BCH panel → 4, bench → 40; etc. — exact set from live data);
  - config value = 0 AND formula > 0 → propose **ticking** ✅ Stations Complete instead of writing ⏳0 (it IS fully done; avoids permanent tick-nudge warnings). Include a column proving the proposed ticks do NOT complete any job's full required set (no accidental Ready-to-Ship flip);
  - config value = 0 AND formula = 0 → leave empty.
- [ ] **Step 3: STOP — present the table to Chris and wait for explicit approval.** Do not write anything to the board before he approves (possibly with edits).
- [ ] **Step 4: Write approved values** — monday MCP `change_item_column_values` per job; numbers columns take plain string values (`"102"`), the dropdown takes its existing label format. Re-read each item after writing to confirm.
- [ ] **Step 5: Verify shadowing** — `$env:DRY_RUN = '1'; node scripts/run-planner.js --plan`; then compare placements against Task 10's baseline plan JSON (use `scripts/diff-plans.js` if present — check first; else `node -e` compare of the two files' `placements` arrays sorted by crew|week|jobId|station). Expected: **identical placements** (board values equal the config values they shadow) and zero unexpected progress warnings. Clear DRY_RUN.
- [ ] **Step 6: Real run** — set the ▶️ Planner Trigger to **Run Requested** (or `node scripts/run-planner.js --plan`); confirm the trigger summary posts with a clean (or expected) Shop-floor progress section and regenerated docs.

---

### Task 13: Operations manual update + monday republish

⚠️ `docs/operations-manual.md` currently carries uncommitted parallel-session edits. **Read the file fresh before editing**, make these changes on top of whatever is there, then `git diff docs/operations-manual.md` and verify any hitchhiking changes look like deliberate edits (per the commit-config-immediately memory) before committing.

**Files:**
- Modify: `docs/operations-manual.md`
- Live: monday doc 18417585088

- [ ] **Step 1: §2.1** — retitle to "Mark production progress (anyone, ~10 seconds)" content split into **fully done** (existing tick steps, unchanged) and a new **partially done** block replacing the `> Partially done … goes through Chris (§4.2)` blockquote:

```markdown
**Partially done** ("27 of 55 boxes", "most of the bench work happened"):

1. Open the **Production Load Board** → **🔧 Shop Floor** view → find the job.
2. Type your estimate of the hours still needed into that station's **⏳ Hrs Left** column.

The next planning run schedules from your number instead of the estimate/config. Rules of thumb:

- Update whenever reality drifts from the plan — weekly is plenty.
- Job running over the estimate? Enter the bigger number — the schedule absorbs it.
- **0 means nothing left.** If the station is truly done, tick ✅ Stations Complete instead of typing 0.
- Clearing the cell hands the station back to the estimate/config.
- Window slips ("bench didn't happen this week") are still override rows (§2.4) or Chris (§4.2) — ⏳ changes how much work is left, not when it lands.
```

- [ ] **Step 2: §4.2** — replace the `remainingHours` bullet:

```markdown
- `jobOverrides[id].remainingHours` — **legacy** partial-progress (pre-⏳). Still honored where the board's ⏳ cell is blank. Precedence: board ticks > board ⏳ Hrs Left > config > formula. ⚠️ Never delete individual station keys (the planner reads the object whole — a missing key means 0, not "use formula"); delete a job's whole object at completion or not at all. New partial progress belongs on the board (§2.1).
```

- [ ] **Step 3: §1 table** — in the "On every planning run" row, after "override rows are validated and stamped Applied/Conflict", insert "; ⏳ shop-floor progress notes land in the run summary". Update the "Last updated" date.
- [ ] **Step 4: Commit immediately**

```powershell
git add docs/operations-manual.md
git commit -m "docs(ops-manual): partial-progress procedure (⏳ Hrs Left), config remainingHours marked legacy"
```

- [ ] **Step 5: Republish** the full updated manual to monday doc 18417585088 — check `git log --oneline --all -- 'scripts/*publish*'` / `Glob scripts/*publish*` for an existing publisher script first; else monday MCP `update_doc` (replace content with the rendered markdown). Verify by reading the doc back (`read_docs`).

---

### Task 14: Build record + memory

**Files:**
- Modify: `docs/superpowers/specs/2026-06-12-partial-station-progress-design.md` (append Build record section: commits, column ids, view id, backfill table as executed, suite counts, DRY_RUN/live-run evidence)
- Modify (outside repo, Write tool): `C:\Users\chris\.claude\projects\C--Users-chris-Harris-Tools\memory\project_overrides_build_worktree.md` — add one sentence: ⏳ Hrs Left columns (ids) + Shop Floor view live; precedence tick > board ⏳ > config (legacy) > formula; config remainingHours never key-deleted.

- [ ] **Step 1: Append the build record** to the spec with the evidence above.
- [ ] **Step 2: Commit**

```powershell
git add docs/superpowers/specs/2026-06-12-partial-station-progress-design.md
git commit -m "docs(spec): partial-station progress build record"
```

- [ ] **Step 3: Update the memory file** (no git — it lives outside the repo).
- [ ] **Step 4: Final report to Chris** — summary of what landed, plus the explicit list of paths left for him to verify live (e.g., entering a real ⏳ value from his phone and watching the next run; any negative-path board entry he wants to exercise himself).

---

## Self-review notes (2026-06-12)

- **Spec coverage:** D1/D2 → Tasks 1, 7, 11; D3 → Tasks 2, 7, 8; D4 → Tasks 3, 8 (RTS) + 5, 9 (nudge); D5 → Tasks 12, 13; §Code 2 warnings → Tasks 5, 8, 9; §Code 4 pin edge → Task 6 (resolved: PATCH-5 behavior exists, plan anchors it); backfill caveats → Task 12 (config untouched, tick-instead-of-zero rule, no-RTS-flip proof column); docs → Task 13.
- **Suite stays at 28 files** — all new tests extend existing files (`test-stations-complete.js`, `test-force-unplaced-accounting.js`, `test-run-planner-orchestrator.js`, `test-planner-trigger.js`).
- **Known approximations the executor must resolve from the live files:** exact insertion line numbers may have drifted (the file is shared with parallel sessions — match on the quoted anchor text, not line numbers); Test 16c's harness is cloned from 16b (read 861–934 first); the `reb` require name in run-planner.js must be confirmed at the top of the file.
