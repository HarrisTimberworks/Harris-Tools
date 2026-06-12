# Lead Time Calculator V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live-load-aware quote engine — quote rows on the Manual Overrides board answered within ~2 minutes by in-memory what-if runs of the real planner, with a config policy floor and a dealer-portal lead-times artifact.

**Architecture:** `quote-engine.js` injects a synthetic job into in-memory `runPlan` calls (fresh `loadAll()` per quote, `savePath: null` structurally enforced) and walks candidate delivery Mondays; `planner-trigger.js`'s minute poll detects `Quote Requested` rows via a combined single-request query and owns all monday writebacks; `write-lead-times.js` emits headline-only artifacts per planner run. Spec: `docs/superpowers/specs/2026-06-12-lead-time-calculator-design.md` (read it first — esp. §3 formula definitions and §4.1 synthetic-job shape).

**Tech Stack:** plain Node (no frameworks), monday.com GraphQL API (version `next`), house test harness (`check()` pattern, hermetic, zero API).

**Execution context (read before Task 1):**
- **Work in an isolated worktree** (superpowers:using-git-worktrees). The Task Scheduler poll executes `planner-trigger.js` from main **every minute** — editing it incrementally on main means running half-written code in production. Merge to main only at Task 14.
- The merge is safe before monday-side setup: every quote code path is gated on `config/planner-trigger.json` containing `quotesGroupId`, which doesn't exist until `setup-quotes-group.js` runs (Task 14).
- Commit after every green step. Config edits commit in the same breath (parallel-session rule).
- All `node scripts/test-*` invocations are already allowlisted.

**Key existing interfaces (verified 2026-06-12, do not guess — they are exactly this):**

```js
// scripts/rebalance-schedule.js (exports at ~line 2281)
loadAll({ gqlFn })            // → { jobs, crewParents, timeOff, existingSubs, overrideRows }
runPlan(boards, opts = {})    // opts.savePath: undefined=save to logs/, null=NO SAVE, string=path
                              // → report: { generatedAt, mode, jobsScheduled, totalPlacements,
                              //   warnings[], capacityGrid[crew][week]={avail,committed,timeOff,over,assignments},
                              //   placements[]={crew,week,hours,parentId,station,jobId,jobName,masterPmId}, ... }
ROUTING                       // keys: 'Res - Face Frame','Res - Frameless','Commercial','Countertop/Surface','Mixed'
computeWindows(job)           // pure; needs job.{delivery,hours{eng,panel,bench,prefin,postfin},finishingDays,pLam,customWindow,name}
weeksCountForHours, findMissingCrewParents, getMondayOfWeek, parseISO, toISO, addDays
// NOT yet exported (Task 1 adds): CREW_BASE_HOURS (line ~197), BOB_START_DATE (~209), CREW_END_DATES (~215)
// runPlan filters: ['Not Started','Scheduled','Ready to Schedule','Finishing','Ready to Ship'].includes(j.status)
// runPlan horizon: endWeek = max(monday(maxDelivery+28d), monday(today+84d)); missing crew parents → process.exit(1)
// crewParents row shape: { parentId, week, crew, base, timeOff, nonProd }
// Pack & Ship + Delivery are each placed as flat 2h in the delivery week (total +4h beyond station hours)

// scripts/planner-trigger.js
acquireLock({ fsImpl, lockFile, now, staleMs, pid })   // → { ok, token } | { ok:false, reason }
releaseLock({ fsImpl, lockFile, token })
readLockState({ fsImpl, lockFile, now, staleMs })      // → { state: 'fresh'|'stale'|'absent', held }
// DEFAULT_LOCK_FILE = logs/planner.lock; LOCK_STALE_MS = 45 min
// runOnce({ mode, deps }) — poll status read at ~line 240: items(ids:[itemId]) single-item query
// postTriggerUpdate / notifyChris — create_update / create_notification patterns (~lines 204-214)

// scripts/run-planner.js
runPlanner({ mode, options, deps })  // deps.writeCapacityView / deps.writeWeeklyBriefing — injected writers,
                                     // per-writer try/catch, `boards` in scope in the outputs stage
                                     // CLI entry (~line 391) wires real writers; planner-trigger.js CLI wires runPlannerFn

// config/planner-trigger.json (current): { boardId:"18413101550", groupId, itemId, statusColumnId, createdAt }
```

**File structure:**

| File | Responsibility |
|---|---|
| Create `scripts/quote-hours-model.js` | job-type map, complexity mult, station factors, `computeQuoteHours` — the ONLY place factors live |
| Create `scripts/fixtures/plb-formulas.json` | live-board formula `settings_str` fixture (drift guard) |
| Create `config/quote-policy.json` | floor weeks, pre-production weeks, finishing-days default, reference basket |
| Create `scripts/quote-engine.js` | policy load/lint, synthetic job+parents, `quoteRunPlan` wrapper, feasibility, walk, target mode, basket |
| Create `scripts/write-lead-times.js` | artifact files (JSON ×2 + HTML snippet), no-leak discipline |
| Create `scripts/setup-quotes-group.js` | idempotent group/column creation, config persistence |
| Modify `scripts/rebalance-schedule.js` | +3 export lines |
| Modify `scripts/planner-trigger.js` | `readTickState` combined query, `processQuotes`, CLI wiring |
| Modify `scripts/run-planner.js` | `deps.writeLeadTimes` hook + CLI wiring |
| Modify `lead-time-calculator.html` | deprecation banner |
| Modify `docs/operations-manual.md` | operator procedures |
| Create `scripts/test-quote-hours-model.js`, `test-quote-engine.js`, `test-quote-trigger.js`, `test-write-lead-times.js` | hermetic suites |

---

### Task 1: Export crew constants from rebalance-schedule.js

**Files:**
- Create: `scripts/test-quote-engine.js` (exports check only; grows in Tasks 5–7)
- Modify: `scripts/rebalance-schedule.js` (module.exports block, ~line 2329)

- [ ] **Step 1: Write the failing test**

```js
#!/usr/bin/env node
// test-quote-engine.js — hermetic; no API, no token needed.
const reb = require('./rebalance-schedule.js');

const failures = [];
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else { failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label} — ${detail}`); }
}

console.log('Test 1: crew constants exported for quote engine');
check('CREW_BASE_HOURS exported', reb.CREW_BASE_HOURS && reb.CREW_BASE_HOURS.Ken === 40,
  `got ${JSON.stringify(reb.CREW_BASE_HOURS)}`);
check('BOB_START_DATE exported', reb.BOB_START_DATE === '2026-05-18', `got ${reb.BOB_START_DATE}`);
check('CREW_END_DATES exported', reb.CREW_END_DATES && typeof reb.CREW_END_DATES === 'object',
  `got ${JSON.stringify(reb.CREW_END_DATES)}`);

console.log(failures.length ? `\n❌ ${failures.length}/${checks} FAILED` : `\n✅ all ${checks} checks passed`);
process.exit(failures.length ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-quote-engine.js`
Expected: FAIL — `CREW_BASE_HOURS exported — got undefined`

- [ ] **Step 3: Add the exports** — in `scripts/rebalance-schedule.js`, inside `module.exports = { ... }` immediately after `SOFT_CAP_MULTIPLIER,`:

```js
  // Quote engine (Lead Time Calculator V2) — synthetic crew-parent injection
  // needs the same capacity constants the planner uses; exporting beats
  // duplication (see 2026-06-12 spec §4.1 and the shared-constants backlog).
  CREW_BASE_HOURS,
  BOB_START_DATE,
  CREW_END_DATES,
```

- [ ] **Step 4: Run test to verify it passes** — `node scripts/test-quote-engine.js` → `✅ all 3 checks passed`

- [ ] **Step 5: Sanity — existing suite untouched.** Run: `node scripts/test-run-planner-orchestrator.js 2>&1 | tail -1` → passes.

- [ ] **Step 6: Commit** — `git add scripts/rebalance-schedule.js scripts/test-quote-engine.js && git commit -m "feat(quote): export crew constants for quote engine (TDD)"`

---

### Task 2: quote-hours-model.js

**Files:**
- Create: `scripts/quote-hours-model.js`
- Create: `scripts/test-quote-hours-model.js`

- [ ] **Step 1: Write the failing test**

```js
#!/usr/bin/env node
// test-quote-hours-model.js — factors are spec §4.1; live-board drift guarded by Task 3.
const { JOB_TYPES, COMPLEXITY_MULT, STATION_FACTORS, computeQuoteHours, normalizeComplexity } =
  require('./quote-hours-model.js');
const { ROUTING } = require('./rebalance-schedule.js');

const failures = [];
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else { failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label} — ${detail}`); }
}

console.log('Test 1: every job type is a real planner ROUTING key (spec §2 — one vocabulary)');
for (const jt of Object.keys(JOB_TYPES)) {
  check(`'${jt}' in ROUTING`, !!ROUTING[jt], `ROUTING keys: ${Object.keys(ROUTING).join(', ')}`);
}

console.log('Test 2: FF 25-box complexity 2 (mult 1.0) — exact station hours');
const r = computeQuoteHours('Res - Face Frame', 25, 2);
check('eng 15',      r.hours.eng === 15,      `got ${r.hours.eng}`);        // 0.6  * 25
check('panel 13.8',  r.hours.panel === 13.8,  `got ${r.hours.panel}`);      // 0.55 * 25 = 13.75 → 13.8
check('bench 7.5',   r.hours.bench === 7.5,   `got ${r.hours.bench}`);      // 0.3  * 25
check('prefin 27.5', r.hours.prefin === 27.5, `got ${r.hours.prefin}`);     // 1.10 * 25
check('postfin 11.3',r.hours.postfin === 11.3,`got ${r.hours.postfin}`);    // 0.45 * 25 = 11.25 → 11.3

console.log('Test 3: FL job — prefin is zero (spec table)');
const fl = computeQuoteHours('Res - Frameless', 10, 2);
check('prefin 0', fl.hours.prefin === 0, `got ${fl.hours.prefin}`);
check('postfin 6.5', fl.hours.postfin === 6.5, `got ${fl.hours.postfin}`);  // 0.65 * 10

console.log('Test 4: Commercial maps to FL boxes');
const co = computeQuoteHours('Commercial', 10, 2);
check('eng 4 (FL 0.4)', co.hours.eng === 4, `got ${co.hours.eng}`);

console.log('Test 5: complexity multiplies ALL five stations (live-board behavior)');
const c5 = computeQuoteHours('Res - Face Frame', 10, 5);   // mult 1.75
check('eng 10.5', c5.hours.eng === 10.5, `got ${c5.hours.eng}`);            // 0.6*10*1.75
check('panel 9.6', c5.hours.panel === 9.6, `got ${c5.hours.panel}`);        // 0.55*10*1.75=9.625→9.6

console.log('Test 6: complexity rounding + bounds (spec §4.4)');
check('2.4 → 2', normalizeComplexity(2.4) === 2);
check('2.5 → 3', normalizeComplexity(2.5) === 3);
check('empty/NaN → null', normalizeComplexity('abc') === null);
check('6 → null (out of range)', normalizeComplexity(6) === null);
check('0 → null', normalizeComplexity(0) === null);
check('computeQuoteHours echoes complexityUsed', computeQuoteHours('Commercial', 5, 3.4).complexityUsed === 3);

let threw = false;
try { computeQuoteHours('Res FF', 5, 2); } catch (e) { threw = true; }
console.log('Test 7: shorthand job type rejected (the routing-key bug class)');
check('throws on unknown job type', threw);

console.log(failures.length ? `\n❌ ${failures.length}/${checks} FAILED` : `\n✅ all ${checks} checks passed`);
process.exit(failures.length ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails** — `node scripts/test-quote-hours-model.js` → FAIL `Cannot find module './quote-hours-model.js'`

- [ ] **Step 3: Implement `scripts/quote-hours-model.js`**

```js
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
```

- [ ] **Step 4: Run to verify it passes** — `node scripts/test-quote-hours-model.js` → `✅ all checks passed`

- [ ] **Step 5: Commit** — `git add scripts/quote-hours-model.js scripts/test-quote-hours-model.js && git commit -m "feat(quote): hours model — ROUTING-key job types, live-board factors (TDD)"`

---

### Task 3: PLB formula drift fixture

**Files:**
- Create: `scripts/fixtures/plb-formulas.json`
- Modify: `scripts/test-quote-hours-model.js` (append drift test)

- [ ] **Step 1: Capture the fixture from the LIVE board** (needs token; one-time, read-only):

```bash
export MONDAY_API_TOKEN=$(cat /c/Users/chris/Harris-Tools/.token) && node -e "
(async () => {
  const q = \`query { boards(ids: [18407601557]) { columns(ids: [\\\"formula_mm2dpf4n\\\",\\\"formula_mm2dxy2k\\\",\\\"formula_mm2d25dk\\\",\\\"formula_mm2df4w1\\\",\\\"formula_mm2d5fmw\\\"]) { id title settings_str } } }\`;
  const r = await fetch('https://api.monday.com/v2', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: process.env.MONDAY_API_TOKEN, 'API-Version': 'next' },
    body: JSON.stringify({ query: q }) });
  const j = await r.json();
  if (j.errors) { console.error(JSON.stringify(j.errors)); process.exit(1); }
  const out = { capturedAt: new Date().toISOString(), boardId: 18407601557, columns: j.data.boards[0].columns };
  require('fs').mkdirSync('scripts/fixtures', { recursive: true });
  require('fs').writeFileSync('scripts/fixtures/plb-formulas.json', JSON.stringify(out, null, 2));
  console.log('captured', out.columns.length, 'formula columns');
})();
"
```

Expected: `captured 5 formula columns`. Open the file and eyeball: each column has a `settings_str` containing a formula string.

- [ ] **Step 2: Append the drift test to `scripts/test-quote-hours-model.js`** (before the final summary lines):

```js
console.log('Test 8: drift guard — module factors appear in the live-board formula fixture');
const fs = require('fs');
const path = require('path');
const fixturePath = path.join(__dirname, 'fixtures', 'plb-formulas.json');
if (!fs.existsSync(fixturePath)) {
  check('fixture exists (recapture: see Task 3 Step 1 of docs/superpowers/plans/2026-06-12-lead-time-calculator-v2.md)',
    false, `missing ${fixturePath}`);
} else {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const byId = {};
  for (const c of fixture.columns) byId[c.id] = c.settings_str || '';
  // station → { columnId, factors-that-must-appear-in-the-formula-text }
  const expectations = {
    eng:     { col: 'formula_mm2dpf4n', nums: ['0.6', '0.4'] },
    panel:   { col: 'formula_mm2dxy2k', nums: ['0.55'] },
    bench:   { col: 'formula_mm2d25dk', nums: ['0.3', '0.15'] },
    prefin:  { col: 'formula_mm2df4w1', nums: ['1.1'] },
    postfin: { col: 'formula_mm2d5fmw', nums: ['0.45', '0.65'] },
  };
  for (const [station, exp] of Object.entries(expectations)) {
    const formula = byId[exp.col] || '';
    for (const n of exp.nums) {
      check(`${station} formula contains ${n}`, formula.includes(n),
        `live formula drifted? recapture fixture + recalibrate STATION_FACTORS. settings_str: ${formula.slice(0, 200)}`);
    }
  }
  // the stale-doc bug class: assert panel FF is NOT the old 0.38
  check('panel formula does NOT contain stale 0.38', !byId['formula_mm2dxy2k'].includes('0.38'),
    'live board reverted to 0.38?! — recalibrate');
}
```

- [ ] **Step 3: Run** — `node scripts/test-quote-hours-model.js` → all pass. If a factor check FAILS: the live formula disagrees with spec §4.1 — STOP, update `STATION_FACTORS` to the live value, re-run, and note the correction in the commit message.

- [ ] **Step 4: Commit** — `git add scripts/fixtures/plb-formulas.json scripts/test-quote-hours-model.js && git commit -m "feat(quote): live PLB formula drift fixture + guard test"`

---

### Task 4: config/quote-policy.json + policy loader/lint

**Files:**
- Create: `config/quote-policy.json`
- Create: `scripts/quote-engine.js` (policy section; grows in Tasks 5–7)
- Modify: `scripts/test-quote-engine.js` (append)

- [ ] **Step 1: Append failing tests to `scripts/test-quote-engine.js`** (before the summary lines):

```js
console.log('Test 2: policy loads and lints');
const { loadQuotePolicy, lintQuotePolicy } = require('./quote-engine.js');
const policy = loadQuotePolicy();
check('preProductionWeeks is 2', policy.preProductionWeeks === 2, `got ${policy.preProductionWeeks}`);
check('minLeadWeeks keyed by ROUTING keys', policy.minLeadWeeks['Res - Face Frame'] === 12,
  `got ${JSON.stringify(policy.minLeadWeeks)}`);
check('referenceBasket has 3 entries', policy.referenceBasket.length === 3);

console.log('Test 3: lint rejects bad shapes with named reasons');
check('bad job-type key named', lintQuotePolicy({ preProductionWeeks: 2, minLeadWeeks: { 'Res FF': 12 },
  defaultFinishingDays: 5, referenceBasket: [] }).some(e => e.includes('Res FF')),
  'expected an error naming the non-ROUTING key');
check('non-numeric weeks named', lintQuotePolicy({ preProductionWeeks: 'two', minLeadWeeks: {},
  defaultFinishingDays: 5, referenceBasket: [] }).some(e => e.includes('preProductionWeeks')));
check('clean policy lints clean', lintQuotePolicy(policy).length === 0,
  JSON.stringify(lintQuotePolicy(policy)));
```

- [ ] **Step 2: Run to verify failure** — `node scripts/test-quote-engine.js` → FAIL `Cannot find module './quote-engine.js'`

- [ ] **Step 3: Create `config/quote-policy.json`** (spec §4.2, launch values):

```json
{
  "preProductionWeeks": 2,
  "minLeadWeeks": { "Res - Face Frame": 12, "Res - Frameless": 12, "Commercial": 10 },
  "defaultFinishingDays": 5,
  "referenceBasket": [
    { "label": "Typical residential FF", "jobType": "Res - Face Frame", "boxes": 25, "complexity": 2 },
    { "label": "Typical residential FL", "jobType": "Res - Frameless", "boxes": 25, "complexity": 2 },
    { "label": "Typical commercial", "jobType": "Commercial", "boxes": 40, "complexity": 3 }
  ]
}
```

- [ ] **Step 4: Create `scripts/quote-engine.js`** (policy section only for now):

```js
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
```

- [ ] **Step 5: Run** — `node scripts/test-quote-engine.js` → all pass.

- [ ] **Step 6: Commit** — `git add config/quote-policy.json scripts/quote-engine.js scripts/test-quote-engine.js && git commit -m "feat(quote): policy config + lint (TDD)"`

---

### Task 5: Synthetic job, synthetic parents, quoteRunPlan wrapper

**Files:**
- Modify: `scripts/quote-engine.js`
- Modify: `scripts/test-quote-engine.js`

- [ ] **Step 1: Append failing tests.** Note the fixture helper — runPlan anchors its horizon to the REAL current date, so all fixture dates are computed relative to now:

```js
// ---- shared fixture helpers (used by Tasks 5-7 tests) ----
const { toISO: _toISO, getMondayOfWeek: _gmw, addDays: _addDays, parseISO: _parseISO } =
  require('./rebalance-schedule.js');
function mondayWeeksFromNow(n) { return _toISO(_addDays(_gmw(new Date()), n * 7)); }
// Crew parents for every crew × week over the next `weeks` weeks, full base hours.
function makeCrewParents(weeks) {
  const { CREW_BASE_HOURS: CBH, BOB_START_DATE: BSD, CREW_END_DATES: CED } = require('./rebalance-schedule.js');
  const rows = [];
  let id = 1;
  for (let w = 0; w < weeks; w++) {
    const week = mondayWeeksFromNow(w);
    for (const crew of Object.keys(CBH)) {
      if (crew === 'Bob' && week < BSD) continue;
      if (CED[crew] && week >= _toISO(_gmw(_parseISO(CED[crew])))) continue;
      rows.push({ parentId: `fix-${id++}`, week, crew, base: CBH[crew], timeOff: 0, nonProd: 0 });
    }
  }
  return rows;
}
function emptyBoards(parentWeeks = 16) {
  return { jobs: [], crewParents: makeCrewParents(parentWeeks), timeOff: [], existingSubs: [], overrideRows: [] };
}

console.log('Test 4: buildSyntheticJob carries every load-bearing field (spec §4.1)');
const { buildSyntheticJob, quoteRunPlan, withSyntheticParents } = require('./quote-engine.js');
const sj = buildSyntheticJob(
  { rowId: '999', name: 'Test Quote', jobType: 'Res - Face Frame', boxes: 25, complexity: 2 },
  loadQuotePolicy(), mondayWeeksFromNow(10));
check('id sentinel', sj.id === 'QUOTE-999', sj.id);
check('status in planner allowlist', sj.status === 'Scheduled', sj.status);
check('subtype is ROUTING key', sj.subtype === 'Res - Face Frame', sj.subtype);
check('delivery set', sj.delivery === mondayWeeksFromNow(10), sj.delivery);
check('hours from model', sj.hours.eng === 15 && sj.hours.prefin === 27.5, JSON.stringify(sj.hours));
check('finishingDays from policy', sj.finishingDays === 5, String(sj.finishingDays));
check('pLam false, masterPmId null, customWindow null',
  sj.pLam === false && sj.masterPmId === null && sj.customWindow === null);

console.log('Test 5: withSyntheticParents fills beyond-coverage weeks, never mutates input');
const shortBoards = emptyBoards(4); // parents only 4 weeks out
const before = shortBoards.crewParents.length;
const synth = withSyntheticParents(shortBoards, sj, { now: () => new Date() });
check('input untouched', shortBoards.crewParents.length === before);
check('synthetic rows added', synth.length > before, `${synth.length} <= ${before}`);
check('synthetic rows shaped like real ones',
  synth.filter(p => String(p.parentId).startsWith('synthetic-'))
       .every(p => p.week && p.crew && typeof p.base === 'number' && p.timeOff === 0 && p.nonProd === 0));
check('no synthetic Bob before start date',
  !synth.some(p => String(p.parentId).startsWith('synthetic-') && p.crew === 'Bob' && p.week < '2026-05-18'));

console.log('Test 6: quoteRunPlan — synthetic job actually PLACES (the silent-drop guard)');
(async () => {
  const boards = emptyBoards(16);
  const report = await quoteRunPlan(boards, sj);
  const quotePlacements = (report.placements || []).filter(p => p.jobId === 'QUOTE-999');
  const placedHours = quotePlacements.reduce((s, p) => s + (p.hours || 0), 0);
  const stationSum = Object.values(sj.hours).reduce((s, h) => s + h, 0);
  check('placements exist for the synthetic job', quotePlacements.length > 0,
    `0 placements — synthetic job silently dropped (status filter?)`);
  check('full station hours + 4h P&S/Delivery placed', placedHours >= stationSum + 4 - 0.01,
    `placed ${placedHours} of ${stationSum + 4}`);

  console.log('Test 7: quoteRunPlan structurally cannot write a plan file');
  const logsDir = path.join(__dirname, '..', 'logs');
  const beforeFiles = new Set(fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : []);
  await quoteRunPlan(emptyBoards(16), sj);
  const afterFiles = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
  check('no new rebalance-plan-*.json in logs/',
    !afterFiles.some(f => f.startsWith('rebalance-plan-') && !beforeFiles.has(f)),
    'quoteRunPlan wrote a plan file — savePath guard broken');

  console.log('Test 8: quoteRunPlan(boards, null) = baseline, no synthetic job');
  const base = await quoteRunPlan(emptyBoards(16), null);
  check('baseline has no QUOTE placements', !(base.placements || []).some(p => String(p.jobId).startsWith('QUOTE-')));

  console.log(failures.length ? `\n❌ ${failures.length}/${checks} FAILED` : `\n✅ all ${checks} checks passed`);
  process.exit(failures.length ? 1 : 0);
})();
```

(Move the existing summary/exit lines INTO the async IIFE as shown — the file now ends with the IIFE.)
Also add `const fs = require('fs'); const path = require('path');` near the top of the test file if not present.

- [ ] **Step 2: Run to verify failure** — `node scripts/test-quote-engine.js` → FAIL `buildSyntheticJob is not a function`

- [ ] **Step 3: Implement in `scripts/quote-engine.js`** (append before `module.exports`, then extend exports):

```js
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
```

Extend exports: `module.exports = { loadQuotePolicy, lintQuotePolicy, POLICY_PATH, buildSyntheticJob, withSyntheticParents, quoteRunPlan };`

- [ ] **Step 4: Run** — `node scripts/test-quote-engine.js` → all pass (noisy planner logs are expected; only the ✓/✗ lines matter).

- [ ] **Step 5: Commit** — `git add scripts/quote-engine.js scripts/test-quote-engine.js && git commit -m "feat(quote): synthetic job/parents + savePath-null planner door (TDD)"`

---

### Task 6: Feasibility predicate

**Files:**
- Modify: `scripts/quote-engine.js`
- Modify: `scripts/test-quote-engine.js`

- [ ] **Step 1: Append failing tests** (inside the async IIFE, before the summary):

```js
console.log('Test 9: assessCandidate — feasible when fully placed and no new over-cap');
const { assessCandidate } = require('./quote-engine.js');
const fakeJob = { id: 'QUOTE-1', name: 'QUOTE - x', hours: { eng: 10, panel: 0, bench: 0, prefin: 0, postfin: 0 } };
const baseRep = { placements: [], warnings: [], capacityGrid: { Chris: { '2026-07-06': { avail: 15, committed: 12, over: 0 } } } };
const goodRep = { placements: [{ jobId: 'QUOTE-1', hours: 10 }, { jobId: 'QUOTE-1', hours: 2 }, { jobId: 'QUOTE-1', hours: 2 }],
  warnings: [], capacityGrid: { Chris: { '2026-07-06': { avail: 15, committed: 15, over: 0 } } } };
check('clean fit is feasible', assessCandidate(baseRep, goodRep, fakeJob).feasible === true,
  JSON.stringify(assessCandidate(baseRep, goodRep, fakeJob).reasons));

console.log('Test 10: under-placement is infeasible with a named reason');
const shortRep = { ...goodRep, placements: [{ jobId: 'QUOTE-1', hours: 6 }] };
const shortRes = assessCandidate(baseRep, shortRep, fakeJob);
check('infeasible', shortRes.feasible === false);
check('reason names the shortfall', shortRes.reasons[0].includes('6'), shortRes.reasons[0]);

console.log('Test 11: STRICT over-cap diff — growing an existing overload is infeasible (spec §4.1)');
const baseOver = { placements: [], warnings: [], capacityGrid: { Bob: { '2026-07-06': { avail: 30, committed: 33, over: 3 } } } };
const worseOver = { placements: [{ jobId: 'QUOTE-1', hours: 14 }], warnings: [],
  capacityGrid: { Bob: { '2026-07-06': { avail: 30, committed: 55, over: 25 } } } };
const overRes = assessCandidate(baseOver, worseOver, fakeJob);
check('grown over-cap infeasible', overRes.feasible === false);
check('reason names crew+week+magnitude', /Bob.*2026-07-06/.test(overRes.reasons.join(' ')), overRes.reasons.join(' | '));

console.log('Test 12: pre-existing over-cap that does NOT grow is tolerated');
const sameOver = { placements: [{ jobId: 'QUOTE-1', hours: 14 }], warnings: [],
  capacityGrid: { Bob: { '2026-07-06': { avail: 30, committed: 33, over: 3 } } } };
check('unchanged baseline overload tolerated', assessCandidate(baseOver, sameOver, fakeJob).feasible === true);

console.log('Test 13: a warning naming the quote job is infeasible');
const warnRep = { ...goodRep, warnings: ['Job QUOTE - x: 4h unplaced at Post Fin Cab Assembly'] };
check('quote-named warning rejects', assessCandidate(baseRep, warnRep, fakeJob).feasible === false);
check('unrelated warnings ignored',
  assessCandidate(baseRep, { ...goodRep, warnings: ['Job SciTech has no delivery date — skipping'] }, fakeJob).feasible === true);
```

- [ ] **Step 2: Run to verify failure** — `assessCandidate is not a function`.

- [ ] **Step 3: Implement** (append to `scripts/quote-engine.js`, export it):

```js
// ---------------------------------------------------------------------------
// Feasibility: candidate run vs baseline run (spec §4.1 step 3)
// ---------------------------------------------------------------------------
// Expected placement total = station hours + 4 (the planner places Pack & Ship
// and Delivery as flat 2h each in the delivery week).
function assessCandidate(baseline, candidate, syntheticJob) {
  const reasons = [];
  const expected = Object.values(syntheticJob.hours).reduce((s, h) => s + h, 0) + 4;
  const placed = (candidate.placements || [])
    .filter(p => p.jobId === syntheticJob.id)
    .reduce((s, p) => s + (p.hours || 0), 0);
  if (placed + 0.01 < expected) {
    reasons.push(`only ${Number(placed.toFixed(1))}h of ${Number(expected.toFixed(1))}h placed`);
  }
  for (const w of candidate.warnings || []) {
    if (String(w).includes(syntheticJob.name)) reasons.push(String(w));
  }
  // Strict no-worse-than-baseline (diff key crew × week): a quote must not
  // deepen ANY existing overload. Missing baseline slot ⇒ baseline over = 0.
  for (const [crew, weeksObj] of Object.entries(candidate.capacityGrid || {})) {
    for (const [week, slot] of Object.entries(weeksObj)) {
      const baseOver = baseline.capacityGrid?.[crew]?.[week]?.over || 0;
      if ((slot.over || 0) > baseOver + 0.01) {
        reasons.push(`over-cap: ${crew} w/o ${week} — committed ${slot.committed}/${slot.avail}h (over by ${slot.over}h, baseline ${baseOver}h)`);
      }
    }
  }
  return { feasible: reasons.length === 0, reasons };
}
```

- [ ] **Step 4: Run** — all pass. **Step 5: Commit** — `git add -u scripts/ && git commit -m "feat(quote): strict no-worse-than-baseline feasibility predicate (TDD)"`

---

### Task 7: Candidate walk, target mode, policy floor, result + update body

**Files:**
- Modify: `scripts/quote-engine.js`
- Modify: `scripts/test-quote-engine.js`

- [ ] **Step 1: Append failing tests** (inside the IIFE):

```js
console.log('Test 14: date helpers — Monday snapping (spec §3/§4.1)');
const { mondayOnOrAfter, runQuote, validateQuoteInput, buildQuoteUpdate } = require('./quote-engine.js');
check('Monday maps to itself', mondayOnOrAfter('2026-06-15') === '2026-06-15');     // a Monday
check('Tuesday maps to next Monday', mondayOnOrAfter('2026-06-16') === '2026-06-22');
check('Sunday maps to next Monday', mondayOnOrAfter('2026-06-21') === '2026-06-22');

console.log('Test 15: validateQuoteInput — named reasons (spec §4.4)');
const pol = loadQuotePolicy();
check('missing boxes named', validateQuoteInput({ jobType: 'Commercial', boxes: 0, complexity: 2 }, pol).reason.includes('Boxes'));
check('bad type named + lists valid', validateQuoteInput({ jobType: 'Res FF', boxes: 5, complexity: 2 }, pol).reason.includes('Res - Face Frame'));
check('complexity 7 named', validateQuoteInput({ jobType: 'Commercial', boxes: 5, complexity: 7 }, pol).reason.includes('omplexity'));
check('target inside pre-production named',
  validateQuoteInput({ jobType: 'Commercial', boxes: 5, complexity: 2, targetDate: mondayWeeksFromNow(1) }, pol).reason.includes('pre-production'));
check('empty complexity defaults to 2', validateQuoteInput({ jobType: 'Commercial', boxes: 5, complexity: '' }, pol).ok === true);

console.log('Test 16: earliest mode on an empty shop — capacity = structural chain, floor wins');
(async () => {
  const boards16 = emptyBoards(20);
  const res = await runQuote(
    { rowId: '1', name: 'Empty shop', jobType: 'Res - Face Frame', boxes: 25, complexity: 2 },
    { boards: boards16, policy: pol });
  check('mode earliest', res.mode === 'earliest');
  check('capacityWeek is a Monday ISO', /^\d{4}-\d{2}-\d{2}$/.test(res.capacityWeek), String(res.capacityWeek));
  check('capacityWeek ≥ walk start (pre-production)', res.capacityWeek >= mondayWeeksFromNow(2), res.capacityWeek);
  check('floorWeek ≈ 12 weeks out', res.floorWeek >= mondayWeeksFromNow(12) && res.floorWeek <= mondayWeeksFromNow(13), res.floorWeek);
  check('quotedWeek = max(capacity, floor) = floor on empty shop', res.quotedWeek === res.floorWeek,
    `quoted ${res.quotedWeek} capacity ${res.capacityWeek} floor ${res.floorWeek}`);
  check('verdict EARLIEST', res.verdict === 'EARLIEST', res.verdict);

  console.log('Test 17: capacity crunch pushes capacityWeek past the crunch');
  // Crunch ALL crews for the first 8 weeks (not just the Engineering primary —
  // SECONDARY routing could spill a single-crew crunch to a fallback crew and
  // silently keep early weeks feasible). 1h base < every station's hours.
  const crunch = emptyBoards(20);
  for (const p of crunch.crewParents) {
    if (p.week < mondayWeeksFromNow(8)) p.base = 1;
  }
  const res2 = await runQuote(
    { rowId: '2', name: 'Crunched', jobType: 'Res - Face Frame', boxes: 25, complexity: 2 },
    { boards: crunch, policy: pol });
  check('capacityWeek pushed past the crunch', res2.capacityWeek > res.capacityWeek,
    `crunched ${res2.capacityWeek} vs empty ${res.capacityWeek}`);

  console.log('Test 18: target mode — all three outcomes (spec §4.4 table)');
  const fits = await runQuote(
    { rowId: '3', name: 'T1', jobType: 'Res - Face Frame', boxes: 25, complexity: 2, targetDate: mondayWeeksFromNow(14) },
    { boards: emptyBoards(20), policy: pol });
  check('fits ≥ floor → FITS, quoted = target week', fits.verdict === 'FITS' && fits.quotedWeek === mondayWeeksFromNow(14),
    `${fits.verdict} ${fits.quotedWeek}`);
  const below = await runQuote(
    { rowId: '4', name: 'T2', jobType: 'Res - Face Frame', boxes: 25, complexity: 2, targetDate: mondayWeeksFromNow(8) },
    { boards: emptyBoards(20), policy: pol });
  check('fits below floor → FITS_BELOW_FLOOR, quoted = max(target, floor)',
    below.verdict === 'FITS_BELOW_FLOOR' && below.quotedWeek === below.floorWeek, `${below.verdict} ${below.quotedWeek}`);
  const noFit = await runQuote(
    { rowId: '5', name: 'T3', jobType: 'Res - Face Frame', boxes: 25, complexity: 2, targetDate: mondayWeeksFromNow(3) },
    { boards: (() => { const b = emptyBoards(20); for (const p of b.crewParents) { if (p.week < mondayWeeksFromNow(8)) p.base = 1; } return b; })(), policy: pol });
  check('does not fit → DOES_NOT_FIT with bottleneck', noFit.verdict === 'DOES_NOT_FIT' && !!noFit.bottleneck,
    `${noFit.verdict} ${noFit.bottleneck}`);
  check('doesn\'t-fit still reports earliest-that-fits in capacityWeek', !!noFit.capacityWeek);

  console.log('Test 19: update body carries both numbers + disclaimer + freshness');
  const body = buildQuoteUpdate(res);
  check('headline quoted week', body.includes(res.quotedWeek));
  check('capacity week shown', body.includes(res.capacityWeek));
  check('floor explanation', body.includes('floor'));
  check('PM disclaimer', body.includes('Confirm with PM'));
  check('freshness timestamp', body.includes(res.dataFreshness.slice(0, 10)));
  check('inputs echoed', body.includes('25') && body.includes('Res - Face Frame'));

  console.log(failures.length ? `\n❌ ${failures.length}/${checks} FAILED` : `\n✅ all ${checks} checks passed`);
  process.exit(failures.length ? 1 : 0);
})();
```

(The Test 16+ block becomes the file's final IIFE — fold the previous IIFE's summary lines into this one so the file has exactly one exit point.)

- [ ] **Step 2: Run to verify failure** — `mondayOnOrAfter is not a function`.

- [ ] **Step 3: Implement** (append to `scripts/quote-engine.js`; extend exports with `assessCandidate, mondayOnOrAfter, runQuote, validateQuoteInput, buildQuoteUpdate, WALK_CAP_WEEKS`):

```js
// ---------------------------------------------------------------------------
// Walk + modes + policy floor (spec §3, §4.1 steps 3-6, §4.4 outcome table)
// ---------------------------------------------------------------------------
const WALK_CAP_WEEKS = 26;

function mondayOnOrAfter(dateISO) {
  const monday = toISO(getMondayOfWeek(parseISO(dateISO)));
  return monday === dateISO ? dateISO : toISO(addDays(parseISO(monday), 7));
}

function validateQuoteInput(raw, policy) {
  const boxes = Number(raw.boxes);
  if (!Number.isFinite(boxes) || boxes < 1) {
    return { ok: false, reason: `Boxes must be a number ≥ 1 (got '${raw.boxes ?? ''}')` };
  }
  if (!JOB_TYPES[raw.jobType]) {
    return { ok: false, reason: `Job Type '${raw.jobType ?? ''}' not recognized — valid: ${Object.keys(JOB_TYPES).join(' | ')}` };
  }
  const complexity = (raw.complexity === '' || raw.complexity === null || raw.complexity === undefined) ? 2 : raw.complexity;
  if (normalizeComplexity(complexity) === null) {
    return { ok: false, reason: `Complexity '${raw.complexity}' must round to an integer 1-5` };
  }
  if (raw.targetDate) {
    const walkStart = mondayOnOrAfter(toISO(addDays(new Date(), policy.preProductionWeeks * 7)));
    const targetWeek = toISO(getMondayOfWeek(parseISO(raw.targetDate)));
    if (targetWeek < walkStart) {
      return { ok: false, reason: `Target ${raw.targetDate} is in the past or inside the ${policy.preProductionWeeks}-week pre-production window (earliest quotable week: ${walkStart})` };
    }
  }
  return { ok: true, input: { ...raw, boxes: Math.round(boxes), complexity } };
}

// One quote, end to end. Caller supplies boards (fresh loadAll() in
// production; fixtures in tests). Returns the result object consumed by the
// trigger writeback and the lead-times writer — NEVER mutates anything.
async function runQuote(rawInput, { boards, policy, now = () => new Date(), runPlanFn } = {}) {
  const v = validateQuoteInput(rawInput, policy);
  if (!v.ok) return { ok: false, reason: v.reason };
  const input = v.input;
  const opts = runPlanFn ? { runPlanFn, now } : { now };

  const baseline = await quoteRunPlan(boards, null, opts);
  const walkStart = mondayOnOrAfter(toISO(addDays(now(), policy.preProductionWeeks * 7)));
  const floorWeek = mondayOnOrAfter(toISO(addDays(now(), policy.minLeadWeeks[input.jobType] * 7)));

  const tryWeek = async (week) => {
    const job = buildSyntheticJob(input, policy, week);
    const report = await quoteRunPlan(boards, job, opts);
    return { job, ...assessCandidate(baseline, report, job) };
  };

  // Earliest-feasible walk (linear, capped — feasibility is not assumed
  // monotone, first clean fit wins; spec §4.1 step 3). Also runs in target
  // mode (deliberate cheap extension, spec §4.1 step 4) so capacityWeek means
  // the same thing in both modes.
  let capacityWeek = null;
  let lastFail = null;
  for (let i = 0; i < WALK_CAP_WEEKS; i++) {
    const week = toISO(addDays(parseISO(walkStart), i * 7));
    const t = await tryWeek(week);
    if (t.feasible) { capacityWeek = week; break; }
    lastFail = t;
  }
  if (!capacityWeek) {
    return { ok: false, reason: `does not fit within ${WALK_CAP_WEEKS} weeks — last blocker: ${lastFail?.reasons?.[0] || 'unknown'}` };
  }

  const common = {
    ok: true,
    inputs: { jobType: input.jobType, boxes: input.boxes, complexity: input.complexity,
              complexityUsed: normalizeComplexity(input.complexity), targetDate: input.targetDate || null },
    hours: buildSyntheticJob(input, policy, capacityWeek).hours,
    capacityWeek, floorWeek,
    dataFreshness: now().toISOString(),
    policy: { preProductionWeeks: policy.preProductionWeeks, minLeadWeeks: policy.minLeadWeeks[input.jobType] },
  };

  if (!input.targetDate) {
    return { ...common, mode: 'earliest', verdict: 'EARLIEST',
      quotedWeek: capacityWeek > floorWeek ? capacityWeek : floorWeek, bottleneck: null };
  }

  const targetWeek = toISO(getMondayOfWeek(parseISO(input.targetDate)));
  const t = await tryWeek(targetWeek);
  if (t.feasible) {
    if (targetWeek >= floorWeek) {
      return { ...common, mode: 'target', verdict: 'FITS', quotedWeek: targetWeek, targetWeek, bottleneck: null };
    }
    return { ...common, mode: 'target', verdict: 'FITS_BELOW_FLOOR',
      quotedWeek: targetWeek > floorWeek ? targetWeek : floorWeek, targetWeek, bottleneck: null };
  }
  return { ...common, mode: 'target', verdict: 'DOES_NOT_FIT',
    quotedWeek: capacityWeek > floorWeek ? capacityWeek : floorWeek, targetWeek,
    bottleneck: t.reasons[0] || 'unknown constraint' };
}

function buildQuoteUpdate(res) {
  const lines = [];
  if (res.mode === 'earliest') {
    lines.push(`**Quote: deliver w/o ${res.quotedWeek}**`);
  } else if (res.verdict === 'FITS') {
    lines.push(`**${res.targetWeek} — FITS** ✅`);
  } else if (res.verdict === 'FITS_BELOW_FLOOR') {
    lines.push(`**${res.targetWeek} — fits capacity, but below the policy floor (${res.policy.minLeadWeeks} wks)** — quote w/o ${res.quotedWeek} unless deliberately overriding.`);
  } else {
    lines.push(`**${res.targetWeek} — DOES NOT FIT** ❌`);
    lines.push(`Blocker: ${res.bottleneck}`);
    lines.push(`Earliest that fits: w/o ${res.capacityWeek}`);
  }
  lines.push('');
  lines.push(`Capacity says earliest: **w/o ${res.capacityWeek}** · policy floor: **w/o ${res.floorWeek}** (${res.policy.minLeadWeeks} wks min) → quoted: **w/o ${res.quotedWeek}**`);
  lines.push(`Inputs: ${res.inputs.jobType}, ${res.inputs.boxes} boxes, complexity ${res.inputs.complexityUsed}${res.inputs.complexity !== res.inputs.complexityUsed ? ` (rounded from ${res.inputs.complexity})` : ''}. Defaults: finishing days, no inset/P-Lam/miter-fold/countertop/backsplash.`);
  lines.push(`Station hours: Eng ${res.hours.eng} · Panel ${res.hours.panel} · Bench ${res.hours.bench} · PreFin ${res.hours.prefin} · PostFin ${res.hours.postfin}. Pre-production ${res.policy.preProductionWeeks} wks included.`);
  lines.push(`Board data as of ${res.dataFreshness}.`);
  lines.push('');
  lines.push('_Confirm with PM before communicating to clients._');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run** — `node scripts/test-quote-engine.js` → all pass (walk runs many in-memory plans; expect a noisy minute or so).

- [ ] **Step 5: Run the whole existing suite** — `for f in scripts/test-*.js; do r=$(node "$f" 2>&1 | tail -1); echo "$f → $r"; done` → every file green.

- [ ] **Step 6: Commit** — `git add -u scripts/ && git commit -m "feat(quote): candidate walk, target verdicts, policy floor, update body (TDD)"`

---

### Task 8: planner-trigger — combined tick query

**Files:**
- Modify: `scripts/planner-trigger.js`
- Create: `scripts/test-quote-trigger.js`

- [ ] **Step 1: Write the failing test** (new file, house harness + the `makeFakeFs` stub style copied from `test-planner-trigger.js`):

```js
#!/usr/bin/env node
// test-quote-trigger.js — quote handling in planner-trigger.js. Hermetic.
const {
  readTickState, QUOTE_LABELS, parseQuoteRows, processQuotes,
  QUOTE_LOCK_STALE_MS, DEFAULT_QUOTE_LOCK_FILE,
} = require('./planner-trigger.js');

const failures = [];
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else { failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label} — ${detail}`); }
}

const CONFIG = {
  boardId: '18413101550', groupId: 'group_mm47eq7n', itemId: '12248969189',
  statusColumnId: 'color_trigger',
  quotesGroupId: 'group_quotes',
  quoteColumns: { jobType: 'dropdown_jt', boxes: 'numeric_bx', complexity: 'numeric_cx',
    targetDate: 'date_tg', status: 'color_qs', quotedWeek: 'date_qw', capacityWeek: 'date_cw' },
};

console.log('Test 1: readTickState — ONE request carrying trigger status + quote rows');
(async () => {
  let calls = 0; let lastQuery = '';
  const gqlFn = async (q) => {
    calls++; lastQuery = q;
    return {
      items: [{ column_values: [{ id: 'color_trigger', text: 'Idle' }] }],
      boards: [{ groups: [{ items_page: { items: [
        { id: '501', name: 'Smith kitchen', column_values: [
          { id: 'dropdown_jt', text: 'Res - Face Frame' }, { id: 'numeric_bx', text: '25' },
          { id: 'numeric_cx', text: '2' }, { id: 'date_tg', text: '' },
          { id: 'color_qs', text: 'Quote Requested' }, { id: 'date_qw', text: '' }, { id: 'date_cw', text: '' } ] },
      ] } }] }],
    };
  };
  const state = await readTickState({ config: CONFIG, gqlFn });
  check('one API call', calls === 1, String(calls));
  check('status text extracted', state.statusText === 'Idle', String(state.statusText));
  check('quote rows extracted', state.quoteRows.length === 1);
  check('query carries both root fields', lastQuery.includes('items(ids:') && lastQuery.includes('boards(ids:'));

  console.log('Test 2: readTickState without quotesGroupId falls back to single-item query (pre-setup safety)');
  let fallbackQuery = '';
  const state2 = await readTickState({
    config: { ...CONFIG, quotesGroupId: undefined, quoteColumns: undefined },
    gqlFn: async (q) => { fallbackQuery = q; return { items: [{ column_values: [{ id: 'color_trigger', text: 'Idle' }] }] }; },
  });
  check('no boards field in fallback', !fallbackQuery.includes('boards(ids:'));
  check('quoteRows empty', state2.quoteRows.length === 0);

  console.log('Test 3: parseQuoteRows maps columns by config ids');
  const rows = parseQuoteRows(
    [{ id: '501', name: 'Smith kitchen', column_values: [
      { id: 'dropdown_jt', text: 'Res - Face Frame' }, { id: 'numeric_bx', text: '25' },
      { id: 'numeric_cx', text: '2.4' }, { id: 'date_tg', text: '2026-09-07' },
      { id: 'color_qs', text: 'Quote Requested' } ] }], CONFIG);
  check('row shape', rows[0].rowId === '501' && rows[0].jobType === 'Res - Face Frame'
    && rows[0].boxes === '25' && rows[0].complexity === '2.4'
    && rows[0].targetDate === '2026-09-07' && rows[0].quoteStatus === 'Quote Requested',
    JSON.stringify(rows[0]));

  console.log(failures.length ? `\n❌ ${failures.length}/${checks} FAILED` : `\n✅ all ${checks} checks passed`);
  process.exit(failures.length ? 1 : 0);
})();
```

- [ ] **Step 2: Run to verify failure** — `readTickState is not a function`.

- [ ] **Step 3: Implement in `scripts/planner-trigger.js`** (above `runOnce`):

```js
// ---------------------------------------------------------------------------
// Quote handling (Lead Time Calculator V2 — spec §4.3/§4.4)
// ---------------------------------------------------------------------------
const QUOTE_LABELS = { requested: 'Quote Requested', quoting: 'Quoting', quoted: 'Quoted', error: 'Quote Error' };
// Quotes run 15-45 s; the 45-min planner staleness would wedge crashed quotes
// (spec §4.3). 5 min ≈ 10× worst-case quote duration.
const QUOTE_LOCK_STALE_MS = 5 * 60 * 1000;
const DEFAULT_QUOTE_LOCK_FILE = path.join(__dirname, '..', 'logs', 'quote.lock');

// One request per tick carrying BOTH the trigger status and the Quotes group
// (spec §4.3: "combined single-request query"). Falls back to the original
// single-item read until setup-quotes-group.js has written quotesGroupId.
async function readTickState({ config, gqlFn }) {
  if (!config.quotesGroupId) {
    const readQ = 'query ($item: [ID!]) { items(ids: $item) { column_values { id text } } }';
    const read = await gqlFn(readQ, { item: [String(config.itemId)] });
    const statusText = (read?.items?.[0]?.column_values || []).find(c => c.id === config.statusColumnId)?.text || null;
    return { statusText, quoteRows: [] };
  }
  const q = `query ($item: [ID!], $board: [ID!], $group: [String!]) {
    items(ids: $item) { column_values { id text } }
    boards(ids: $board) { groups(ids: $group) { items_page(limit: 50) { items { id name column_values { id text } } } } }
  }`;
  const read = await gqlFn(q, { item: [String(config.itemId)], board: [String(config.boardId)], group: [String(config.quotesGroupId)] });
  const statusText = (read?.items?.[0]?.column_values || []).find(c => c.id === config.statusColumnId)?.text || null;
  const items = read?.boards?.[0]?.groups?.[0]?.items_page?.items || [];
  return { statusText, quoteRows: parseQuoteRows(items, config) };
}

function parseQuoteRows(items, config) {
  const col = (item, id) => (item.column_values || []).find(c => c.id === id)?.text ?? '';
  const c = config.quoteColumns || {};
  return items.map(item => ({
    rowId: String(item.id),
    name: item.name,
    jobType: col(item, c.jobType),
    boxes: col(item, c.boxes),
    complexity: col(item, c.complexity),
    targetDate: col(item, c.targetDate) || null,
    quoteStatus: col(item, c.status),
  }));
}
```

Add `QUOTE_LABELS, QUOTE_LOCK_STALE_MS, DEFAULT_QUOTE_LOCK_FILE, readTickState, parseQuoteRows` to the module.exports block.

- [ ] **Step 4: Make `runOnce` accept a pre-fetched read** so poll mode doesn't double-query. In `runOnce`, replace the status-read block (the `try { const readQ = ... } catch` at ~line 238) with:

```js
  let statusText = null;
  try {
    if (deps.tickState) {
      statusText = deps.tickState.statusText;
    } else {
      const state = await readTickState({ config, gqlFn: _gqlFn });
      statusText = state.statusText;
    }
  } catch (e) {
```

(keep the existing catch body verbatim — auth-failure detection and mode-specific handling stay exactly as they are).

- [ ] **Step 5: Run both test files** — `node scripts/test-quote-trigger.js` → Tests 1–3 pass (Test on processQuotes comes next task); `node scripts/test-planner-trigger.js` → still fully green (fallback path covers the old query shape; if a stub asserts on the literal old query string, update that stub to stub `readTickState` semantics — i.e., return the same `{ items: [...] }` shape, which the fallback still consumes).

- [ ] **Step 6: Commit** — `git add -u scripts/ && git commit -m "feat(quote): combined tick query + quote row parsing (TDD)"`

---

### Task 9: planner-trigger — processQuotes (locks, lifecycle, self-heal, writebacks, DRY_RUN)

**Files:**
- Modify: `scripts/planner-trigger.js`
- Modify: `scripts/test-quote-trigger.js`

- [ ] **Step 1: Append failing tests** (inside the IIFE; reuse `makeFakeFs` — copy it verbatim from `test-planner-trigger.js` lines 49–80 into this file's stub section):

```js
console.log('Test 4: processQuotes happy path — lifecycle + writebacks + silence');
{
  const { files, fs: fakeFs } = makeFakeFs();
  const mutations = [];
  const gqlFn = async (q, vars) => { mutations.push({ q, vars }); return { change_multiple_column_values: { id: '1' }, create_update: { id: '2' } }; };
  const fakeResult = { ok: true, mode: 'earliest', verdict: 'EARLIEST', quotedWeek: '2026-09-07',
    capacityWeek: '2026-08-03', floorWeek: '2026-09-07', dataFreshness: new Date().toISOString(),
    inputs: { jobType: 'Res - Face Frame', boxes: 25, complexity: 2, complexityUsed: 2, targetDate: null },
    hours: { eng: 15, panel: 13.8, bench: 7.5, prefin: 27.5, postfin: 11.3 },
    policy: { preProductionWeeks: 2, minLeadWeeks: 12 } };
  let loaded = 0;
  const r = await processQuotes({
    rows: [{ rowId: '501', name: 'Smith', jobType: 'Res - Face Frame', boxes: '25', complexity: '2', targetDate: null, quoteStatus: QUOTE_LABELS.requested }],
    deps: { config: CONFIG, gqlFn, fsImpl: fakeFs, now: () => new Date(),
      loadAllFn: async () => { loaded++; return { jobs: [], crewParents: [], timeOff: [], existingSubs: [], overrideRows: [] }; },
      runQuoteFn: async () => fakeResult, logger: { log: () => {} } },
  });
  check('processed 1', r.processed === 1, JSON.stringify(r));
  check('fresh loadAll happened', loaded === 1);
  const labels = mutations.filter(m => m.q.includes('change_multiple_column_values')).map(m => m.vars.cv);
  check('flipped Quoting then Quoted', labels.some(cv => cv.includes('Quoting')) && labels.some(cv => cv.includes('"Quoted"')),
    JSON.stringify(labels));
  check('date columns written', labels.some(cv => cv.includes('2026-09-07') && cv.includes('2026-08-03')));
  check('update posted with both numbers', mutations.some(m => m.q.includes('create_update') && m.vars.body.includes('2026-08-03')));
  check('no notification on clean quote', !mutations.some(m => m.q.includes('create_notification')));
  check('quote lock released', !files.has(String(DEFAULT_QUOTE_LOCK_FILE)) || !files.get(String(DEFAULT_QUOTE_LOCK_FILE)));
}

console.log('Test 5: invalid input → Quote Error + reason, NO notification, engine never ran');
{
  const { fs: fakeFs } = makeFakeFs();
  const mutations = [];
  const gqlFn = async (q, vars) => { mutations.push({ q, vars }); return {}; };
  let engineRan = 0;
  await processQuotes({
    rows: [{ rowId: '502', name: 'Bad', jobType: 'Res FF', boxes: '0', complexity: '2', targetDate: null, quoteStatus: QUOTE_LABELS.requested }],
    deps: { config: CONFIG, gqlFn, fsImpl: fakeFs, now: () => new Date(),
      loadAllFn: async () => ({ jobs: [], crewParents: [], timeOff: [], existingSubs: [], overrideRows: [] }),
      runQuoteFn: async () => { engineRan++; return { ok: false, reason: 'should not reach' }; },
      logger: { log: () => {} } },
  });
  // validation happens BEFORE loadAll/engine — validateQuoteInput is called by processQuotes
  check('Quote Error flipped', mutations.some(m => m.vars?.cv?.includes('Quote Error')));
  check('reason in update', mutations.some(m => m.q.includes('create_update') && /Boxes/.test(m.vars.body)));
  check('no notification', !mutations.some(m => m.q.includes('create_notification')));
}

console.log('Test 6: engine failure → Quote Error + notify Chris');
{
  const { fs: fakeFs } = makeFakeFs();
  const mutations = [];
  const gqlFn = async (q, vars) => { mutations.push({ q, vars }); return {}; };
  await processQuotes({
    rows: [{ rowId: '503', name: 'Boom', jobType: 'Commercial', boxes: '10', complexity: '2', targetDate: null, quoteStatus: QUOTE_LABELS.requested }],
    deps: { config: CONFIG, gqlFn, fsImpl: fakeFs, now: () => new Date(),
      loadAllFn: async () => ({ jobs: [], crewParents: [], timeOff: [], existingSubs: [], overrideRows: [] }),
      runQuoteFn: async () => { throw new Error('planner exploded'); }, logger: { log: () => {} } },
  });
  check('Quote Error flipped', mutations.some(m => m.vars?.cv?.includes('Quote Error')));
  check('Chris notified', mutations.some(m => m.q.includes('create_notification') && /planner exploded/.test(m.vars.text)));
}

console.log('Test 7: planner.lock held → defer, row untouched');
{
  const { acquireLock } = require('./planner-trigger.js');
  const { files, fs: fakeFs } = makeFakeFs();
  // Seed a FRESH planner lock via acquireLock itself — guarantees the file
  // shape matches whatever readLockState parses (never hand-roll lock JSON).
  const plannerLockPath = require('path').join(__dirname, '..', 'logs', 'planner.lock');
  acquireLock({ fsImpl: fakeFs, lockFile: plannerLockPath, now: () => new Date() });
  const mutations = [];
  const r = await processQuotes({
    rows: [{ rowId: '504', name: 'Wait', jobType: 'Commercial', boxes: '10', complexity: '2', targetDate: null, quoteStatus: QUOTE_LABELS.requested }],
    deps: { config: CONFIG, gqlFn: async (q, vars) => { mutations.push({ q, vars }); return {}; }, fsImpl: fakeFs,
      now: () => new Date(), loadAllFn: async () => ({}), runQuoteFn: async () => ({}), logger: { log: () => {} } },
  });
  check('deferred', r.deferred === 1, JSON.stringify(r));
  check('zero mutations', mutations.length === 0, String(mutations.length));
}

console.log('Test 8: 3-per-tick cap');
{
  const { fs: fakeFs } = makeFakeFs();
  const rows = ['1', '2', '3', '4', '5'].map(id => ({ rowId: id, name: `Q${id}`, jobType: 'Commercial', boxes: '5', complexity: '2', targetDate: null, quoteStatus: QUOTE_LABELS.requested }));
  const fakeResult = { ok: true, mode: 'earliest', verdict: 'EARLIEST', quotedWeek: '2026-09-07', capacityWeek: '2026-08-03',
    floorWeek: '2026-09-07', dataFreshness: new Date().toISOString(),
    inputs: { jobType: 'Commercial', boxes: 5, complexity: 2, complexityUsed: 2, targetDate: null },
    hours: { eng: 2, panel: 2.8, bench: 0.8, prefin: 0, postfin: 3.3 }, policy: { preProductionWeeks: 2, minLeadWeeks: 10 } };
  const r = await processQuotes({
    rows,
    deps: { config: CONFIG, gqlFn: async () => ({}), fsImpl: fakeFs, now: () => new Date(),
      loadAllFn: async () => ({ jobs: [], crewParents: [], timeOff: [], existingSubs: [], overrideRows: [] }),
      runQuoteFn: async () => fakeResult, logger: { log: () => {} } },
  });
  check('processed exactly 3', r.processed === 3, JSON.stringify(r));
  check('2 left for next tick', r.remaining === 2);
}

console.log('Test 9: stuck-Quoting self-heal — Quoting + absent quote.lock ⇒ Quote Error');
{
  const { fs: fakeFs } = makeFakeFs(); // no lock file at all
  const mutations = [];
  await processQuotes({
    rows: [{ rowId: '505', name: 'Stuck', jobType: 'Commercial', boxes: '5', complexity: '2', targetDate: null, quoteStatus: QUOTE_LABELS.quoting }],
    deps: { config: CONFIG, gqlFn: async (q, vars) => { mutations.push({ q, vars }); return {}; }, fsImpl: fakeFs,
      now: () => new Date(), loadAllFn: async () => ({}), runQuoteFn: async () => ({}), logger: { log: () => {} } },
  });
  check('healed to Quote Error', mutations.some(m => m.vars?.cv?.includes('Quote Error')));
  check('explanation update posted', mutations.some(m => m.q.includes('create_update') && /died|crash|mid-flight/i.test(m.vars.body)));
}

console.log('Test 10: DRY_RUN prints, mutates nothing');
{
  process.env.DRY_RUN = '1';
  const { fs: fakeFs } = makeFakeFs();
  const mutations = [];
  const logged = [];
  await processQuotes({
    rows: [{ rowId: '506', name: 'Dry', jobType: 'Commercial', boxes: '5', complexity: '2', targetDate: null, quoteStatus: QUOTE_LABELS.requested }],
    deps: { config: CONFIG, gqlFn: async (q, vars) => { mutations.push({ q, vars }); return {}; }, fsImpl: fakeFs,
      now: () => new Date(), loadAllFn: async () => ({ jobs: [], crewParents: [], timeOff: [], existingSubs: [], overrideRows: [] }),
      runQuoteFn: async () => ({ ok: true, mode: 'earliest', verdict: 'EARLIEST', quotedWeek: '2026-09-07',
        capacityWeek: '2026-08-03', floorWeek: '2026-09-07', dataFreshness: new Date().toISOString(),
        inputs: { jobType: 'Commercial', boxes: 5, complexity: 2, complexityUsed: 2, targetDate: null },
        hours: { eng: 2, panel: 2.8, bench: 0.8, prefin: 0, postfin: 3.3 }, policy: { preProductionWeeks: 2, minLeadWeeks: 10 } }),
      logger: { log: (m) => logged.push(m) } },
  });
  delete process.env.DRY_RUN;
  check('zero monday mutations under DRY_RUN', mutations.length === 0, String(mutations.length));
  check('intended writebacks printed', logged.some(l => /DRY RUN.*Quoted/i.test(l)), logged.join(' | ').slice(0, 200));
}
```

- [ ] **Step 2: Run to verify failure** — `processQuotes is not a function`.

- [ ] **Step 3: Implement `processQuotes`** in `scripts/planner-trigger.js` (after `parseQuoteRows`). All I/O injected, mirroring `runOnce`:

```js
async function setQuoteStatus(config, rowId, label, { gqlFn }) {
  await gqlFn(
    'mutation ($item: ID!, $board: ID!, $cv: JSON!) { change_multiple_column_values(item_id: $item, board_id: $board, column_values: $cv, create_labels_if_missing: true) { id } }',
    { item: String(rowId), board: String(config.boardId),
      cv: JSON.stringify({ [config.quoteColumns.status]: { label } }) });
}

async function writeQuoteResult(config, rowId, result, { gqlFn }) {
  const cv = {
    [config.quoteColumns.status]: { label: QUOTE_LABELS.quoted },
    [config.quoteColumns.quotedWeek]: { date: result.quotedWeek },
    [config.quoteColumns.capacityWeek]: { date: result.capacityWeek },
  };
  await gqlFn(
    'mutation ($item: ID!, $board: ID!, $cv: JSON!) { change_multiple_column_values(item_id: $item, board_id: $board, column_values: $cv, create_labels_if_missing: true) { id } }',
    { item: String(rowId), board: String(config.boardId), cv: JSON.stringify(cv) });
  const { buildQuoteUpdate } = require('./quote-engine.js');
  await gqlFn('mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }',
    { item: String(rowId), body: buildQuoteUpdate(result) });
}

async function postQuoteError(config, rowId, reason, { gqlFn }) {
  try { await setQuoteStatus(config, rowId, QUOTE_LABELS.error, { gqlFn }); } catch (e) { /* self-heal corrects later */ }
  try {
    await gqlFn('mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }',
      { item: String(rowId), body: `Quote failed: ${reason}` });
  } catch (e) { /* best-effort */ }
}

// Quote tick (spec §4.3): own lock (never planner.lock), 3-per-tick cap,
// self-heal for stuck Quoting rows, defer entirely while a planner run/deploy
// holds planner.lock, DRY_RUN prints instead of writing.
const MAX_QUOTES_PER_TICK = 3;
async function processQuotes({ rows = [], deps = {} } = {}) {
  const _gqlFn = deps.gqlFn;
  const _fsImpl = deps.fsImpl || fs;
  const _now = deps.now || (() => new Date());
  const _logger = deps.logger || console;
  const _loadAll = deps.loadAllFn || (() => require('./rebalance-schedule.js').loadAll({}));
  const _runQuote = deps.runQuoteFn || require('./quote-engine.js').runQuote;
  const _userId = deps.notifyUserId || CHRIS_USER_ID;
  const _plannerLock = deps.lockFile || DEFAULT_LOCK_FILE;
  const _quoteLock = deps.quoteLockFile || DEFAULT_QUOTE_LOCK_FILE;
  const _dryRun = process.env.DRY_RUN === '1';
  const config = deps.config;
  if (!config?.quotesGroupId || !config?.quoteColumns) return { processed: 0, skipped: 'quotes not set up' };

  const out = { processed: 0, healed: 0, deferred: 0, errors: 0, remaining: 0 };

  // Self-heal: Quoting + no live quote lock ⇒ that quote died mid-flight.
  const lockState = readLockState({ fsImpl: _fsImpl, lockFile: _quoteLock, now: _now, staleMs: QUOTE_LOCK_STALE_MS });
  for (const row of rows.filter(r => r.quoteStatus === QUOTE_LABELS.quoting)) {
    if (lockState.state !== 'fresh') {
      if (_dryRun) { _logger.log(`  [DRY RUN] would heal stuck-Quoting row ${row.rowId} → Quote Error`); continue; }
      try { await setQuoteStatus(config, row.rowId, QUOTE_LABELS.error, { gqlFn: _gqlFn }); } catch (e) { _logger.log(`quote self-heal flip failed: ${e.message}`); }
      try {
        await _gqlFn('mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }',
          { item: String(row.rowId), body: 'This quote died mid-flight (machine sleep, crash, or kill while Quoting). Flip Quote Status back to Quote Requested to retry.' });
      } catch (e) { /* best-effort */ }
      out.healed++;
    }
  }

  const requested = rows.filter(r => r.quoteStatus === QUOTE_LABELS.requested)
    .sort((a, b) => a.rowId.localeCompare(b.rowId, undefined, { numeric: true }));
  if (requested.length === 0) return out;

  // Quotes against mid-rewrite boards lie — defer the whole batch one tick.
  const plannerState = readLockState({ fsImpl: _fsImpl, lockFile: _plannerLock, now: _now });
  if (plannerState.state === 'fresh') {
    out.deferred = requested.length;
    _logger.log(`planner-trigger: ${requested.length} quote(s) deferred — planner run/deploy in flight`);
    return out;
  }

  const lock = acquireLock({ fsImpl: _fsImpl, lockFile: _quoteLock, now: _now, staleMs: QUOTE_LOCK_STALE_MS });
  if (!lock.ok) {
    out.deferred = requested.length;
    _logger.log(`planner-trigger: quotes deferred — ${lock.reason}`);
    return out;
  }
  try {
    const batch = requested.slice(0, MAX_QUOTES_PER_TICK);
    out.remaining = requested.length - batch.length;
    const { loadQuotePolicy } = require('./quote-engine.js');
    const { validateQuoteInput } = require('./quote-engine.js');

    let policy;
    try {
      policy = deps.policy || loadQuotePolicy();
    } catch (e) {
      // config lint failure: loud + notify, rows untouched (retry next tick after fix)
      _logger.log(`quote-policy lint FAILED: ${e.message}`);
      if (!_dryRun) {
        try { await notifyChris(config, `HTW Quotes: quote-policy.json failed lint — ${e.message}`, { gqlFn: _gqlFn, userId: _userId }); } catch (e2) { /* */ }
      }
      out.errors = requested.length;
      return out;
    }

    for (const row of batch) {
      const v = validateQuoteInput(row, policy);
      if (!v.ok) {
        if (_dryRun) { _logger.log(`  [DRY RUN] would flip row ${row.rowId} → Quote Error (${v.reason})`); }
        else { await postQuoteError(config, row.rowId, v.reason, { gqlFn: _gqlFn }); }
        out.processed++;
        continue;
      }
      try {
        if (_dryRun) { _logger.log(`  [DRY RUN] would flip row ${row.rowId} → Quoting`); }
        else { try { await setQuoteStatus(config, row.rowId, QUOTE_LABELS.quoting, { gqlFn: _gqlFn }); } catch (e) { _logger.log(`Quoting claim failed (${e.message}) — proceeding under lock`); } }

        const boards = await _loadAll();

        // Torn-read guard (spec §4.3): a run/deploy that started mid-fetch may
        // have half-rewritten the boards we just read.
        const recheck = readLockState({ fsImpl: _fsImpl, lockFile: _plannerLock, now: _now });
        if (recheck.state === 'fresh') {
          if (_dryRun) { _logger.log(`  [DRY RUN] torn-read defer for row ${row.rowId}`); }
          else { try { await setQuoteStatus(config, row.rowId, QUOTE_LABELS.requested, { gqlFn: _gqlFn }); } catch (e) { /* */ } }
          out.deferred++;
          continue;
        }

        const result = await _runQuote(row, { boards, policy, now: _now });
        if (!result.ok) {
          if (_dryRun) { _logger.log(`  [DRY RUN] would flip row ${row.rowId} → Quote Error (${result.reason})`); }
          else { await postQuoteError(config, row.rowId, result.reason, { gqlFn: _gqlFn }); }
          out.processed++;
          continue;
        }
        if (_dryRun) {
          _logger.log(`  [DRY RUN] would write row ${row.rowId} → Quoted (quoted ${result.quotedWeek}, capacity ${result.capacityWeek})`);
        } else {
          await writeQuoteResult(config, row.rowId, result, { gqlFn: _gqlFn });
        }
        out.processed++;
      } catch (e) {
        out.errors++;
        out.processed++;
        const msg = e.message || String(e);
        if (_dryRun) { _logger.log(`  [DRY RUN] would flip row ${row.rowId} → Quote Error + notify (${msg})`); }
        else {
          await postQuoteError(config, row.rowId, msg, { gqlFn: _gqlFn });
          try { await notifyChris(config, `HTW Quotes: quote on row ${row.rowId} failed — ${msg}`, { gqlFn: _gqlFn, userId: _userId }); } catch (e2) { _logger.log(`quote failure notification failed: ${e2.message}`); }
        }
      }
    }
    return out;
  } finally {
    releaseLock({ fsImpl: _fsImpl, lockFile: _quoteLock, token: lock.token });
  }
}
```

Export `processQuotes` (and `MAX_QUOTES_PER_TICK`).

- [ ] **Step 4: Wire the poll CLI entry.** In the `--poll` branch of the CLI entry at the bottom of `planner-trigger.js`, replace the existing single `runOnce` invocation with a tick that shares one read (find the existing block; it calls `runOnce({ mode: 'poll', deps: {...} })`):

```js
    const config = loadTriggerConfig({});
    const state = config ? await readTickState({ config, gqlFn: deps.gqlFn }) : null;
    const result = await runOnce({ mode: 'poll', deps: { ...deps, ...(state ? { tickState: state, config } : {}) } });
    if (state && config?.quotesGroupId) {
      const qr = await processQuotes({ rows: state.quoteRows, deps: { ...deps, config } });
      if (qr.processed || qr.healed || qr.deferred) {
        console.log(`quotes: ${qr.processed} processed, ${qr.healed} healed, ${qr.deferred} deferred, ${qr.remaining} remaining`);
      }
    }
```

(Match the surrounding code's actual variable names — the CLI entry already builds a `deps` object with the real `gqlFn` and `runPlannerFn`; insert into that flow, preserving idle-tick silence: quote logging only when something happened. If `readTickState` itself throws, let the existing poll error handling treat it exactly like the old status-read failure.)

- [ ] **Step 5: Run** — `node scripts/test-quote-trigger.js` → all pass; `node scripts/test-planner-trigger.js` → green.

- [ ] **Step 6: Commit** — `git add -u scripts/ && git commit -m "feat(quote): processQuotes — locks, lifecycle, self-heal, DRY_RUN (TDD)"`

---

### Task 10: setup-quotes-group.js

**Files:**
- Create: `scripts/setup-quotes-group.js`
- Modify: `scripts/test-quote-trigger.js` (append)

- [ ] **Step 1: Append failing tests:**

```js
console.log('Test 11: setup — creates group + columns + persists config when absent');
const { setupQuotesGroup } = require('./setup-quotes-group.js');
{
  const calls = [];
  const gqlFn = async (q, vars) => {
    calls.push({ q, vars });
    if (q.includes('groups {')) return { boards: [{ groups: [{ id: 'group_mm47eq7n', title: '⚙️ Control' }] }] }; // no Quotes group yet
    if (q.includes('create_group')) return { create_group: { id: 'group_q1' } };
    if (q.includes('create_column')) return { create_column: { id: `col_${calls.length}` } };
    return {};
  };
  const writes = [];
  const fsImpl = { readFileSync: () => JSON.stringify({ boardId: '18413101550', groupId: 'g', itemId: 'i', statusColumnId: 's' }),
    writeFileSync: (p, c) => writes.push({ p, c }), existsSync: () => true };
  const res = await setupQuotesGroup({ gqlFn, fsImpl });
  check('group created', res.created === true && res.quotesGroupId === 'group_q1', JSON.stringify(res));
  check('7 columns created', calls.filter(c => c.q.includes('create_column')).length === 7);
  check('config written with quotesGroupId + quoteColumns', writes.length === 1
    && writes[0].c.includes('quotesGroupId') && writes[0].c.includes('quoteColumns'));
}

console.log('Test 12: setup — idempotent when group already exists (duplicate guard)');
{
  const calls = [];
  const gqlFn = async (q) => {
    calls.push(q);
    if (q.includes('groups {')) return { boards: [{ groups: [{ id: 'group_q1', title: '💬 Quotes' }] }] };
    return {};
  };
  const fsImpl = { readFileSync: () => JSON.stringify({ boardId: '18413101550', groupId: 'g', itemId: 'i', statusColumnId: 's', quotesGroupId: 'group_q1', quoteColumns: { jobType: 'x' } }),
    writeFileSync: () => { throw new Error('must not rewrite config'); }, existsSync: () => true };
  const res = await setupQuotesGroup({ gqlFn, fsImpl });
  check('no creation', res.created === false && !calls.some(q => q.includes('create_group')));
}

console.log('Test 13: setup — transient query failure does NOT create (briefing-doc bug family)');
{
  let threw = false;
  try {
    await setupQuotesGroup({ gqlFn: async () => { throw new Error('502'); },
      fsImpl: { readFileSync: () => JSON.stringify({ boardId: 'b' }), writeFileSync: () => {}, existsSync: () => true } });
  } catch (e) { threw = true; }
  check('throws instead of creating on read failure', threw);
}
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement `scripts/setup-quotes-group.js`:**

```js
#!/usr/bin/env node
/**
 * One-time, idempotent: create the 💬 Quotes group + columns on the Manual
 * Overrides board (18413101550) and persist ids into config/planner-trigger.json.
 * Duplicate guard: only a SUCCESSFUL zero-result group query triggers creation
 * (a transient failure throws — the briefing-doc duplicate bug family).
 * After running: COMMIT config/planner-trigger.json immediately, then do the
 * one manual step — create a "Quotes" board view showing these columns and
 * hide them in the Main view (monday UI). Also verify no board automation
 * touches the Quotes group (spec §4.4).
 */
const fs = require('fs');
const path = require('path');
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'planner-trigger.json');
const GROUP_TITLE = '💬 Quotes';

const COLUMNS = [
  { key: 'jobType',      title: 'Job Type',      type: 'dropdown',
    defaults: { settings_str: JSON.stringify({ labels: [ { id: 1, name: 'Res - Face Frame' }, { id: 2, name: 'Res - Frameless' }, { id: 3, name: 'Commercial' } ] }) } },
  { key: 'boxes',        title: 'Boxes',         type: 'numbers' },
  { key: 'complexity',   title: 'Complexity',    type: 'numbers' },
  { key: 'targetDate',   title: 'Target Date',   type: 'date' },
  { key: 'status',       title: 'Quote Status',  type: 'status',
    defaults: { settings_str: JSON.stringify({ labels: { 1: 'Quote Requested', 2: 'Quoting', 3: 'Quoted', 4: 'Quote Error' } }) } },
  { key: 'quotedWeek',   title: 'Quoted Week',   type: 'date' },
  { key: 'capacityWeek', title: 'Capacity Week', type: 'date' },
];

async function setupQuotesGroup({ gqlFn, fsImpl = fs, configPath = CONFIG_PATH } = {}) {
  const config = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
  const boardId = String(config.boardId);

  const read = await gqlFn(`query ($board: [ID!]) { boards(ids: $board) { groups { id title } } }`, { board: [boardId] });
  if (!read?.boards?.[0]) throw new Error('setup-quotes-group: board groups query returned nothing — aborting (no blind create)');
  const existing = (read.boards[0].groups || []).find(g => g.title === GROUP_TITLE);

  if (existing && config.quotesGroupId === existing.id && config.quoteColumns) {
    console.log(`✓ Quotes group already set up (${existing.id}) — nothing to do`);
    return { created: false, quotesGroupId: existing.id };
  }

  let groupId = existing?.id;
  if (!groupId) {
    const g = await gqlFn(`mutation ($board: ID!, $name: String!) { create_group(board_id: $board, group_name: $name) { id } }`,
      { board: boardId, name: GROUP_TITLE });
    groupId = g?.create_group?.id;
    if (!groupId) throw new Error('setup-quotes-group: create_group returned no id');
    console.log(`✓ created group ${groupId}`);
  }

  const quoteColumns = config.quoteColumns || {};
  for (const col of COLUMNS) {
    if (quoteColumns[col.key]) continue;
    const c = await gqlFn(
      `mutation ($board: ID!, $title: String!, $type: ColumnType!${col.defaults ? ', $defaults: JSON' : ''}) {
        create_column(board_id: $board, title: $title, column_type: $type${col.defaults ? ', defaults: $defaults' : ''}) { id }
      }`,
      { board: boardId, title: col.title, type: col.type, ...(col.defaults ? { defaults: col.defaults.settings_str } : {}) });
    quoteColumns[col.key] = c?.create_column?.id;
    if (!quoteColumns[col.key]) throw new Error(`setup-quotes-group: create_column '${col.title}' returned no id`);
    console.log(`✓ created column ${col.title} → ${quoteColumns[col.key]}`);
  }

  const next = { ...config, quotesGroupId: groupId, quoteColumns };
  fsImpl.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
  console.log(`✓ config persisted → ${configPath} — COMMIT THIS NOW (parallel-session rule)`);
  console.log(`→ manual step: create the 'Quotes' board view + hide quote columns in Main view`);
  console.log(`→ manual step: verify board automations (cross-training doc §automations) don't touch ${GROUP_TITLE}`);
  return { created: true, quotesGroupId: groupId, quoteColumns };
}

module.exports = { setupQuotesGroup, COLUMNS, GROUP_TITLE };

if (require.main === module) {
  const TOKEN = process.env.MONDAY_API_TOKEN || (fs.existsSync(path.join(__dirname, '..', '.token'))
    ? fs.readFileSync(path.join(__dirname, '..', '.token'), 'utf8').trim() : null);
  if (!TOKEN) { console.error('ERROR: MONDAY_API_TOKEN or .token required'); process.exit(1); }
  const gqlFn = async (query, variables) => {
    const r = await fetch('https://api.monday.com/v2', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: TOKEN, 'API-Version': 'next' },
      body: JSON.stringify({ query, variables }) });
    const j = await r.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    return j.data;
  };
  setupQuotesGroup({ gqlFn }).catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run** — `node scripts/test-quote-trigger.js` → all pass. (Do NOT run the live CLI yet — that's Task 14.)

> Live-API caveat for Task 14: monday's `create_column` defaults JSON shapes for dropdown vs status columns are finicky and version-sensitive. The stubbed tests don't validate them. If the live run rejects a defaults payload, check `get_column_type_info` for the current shape and adjust `COLUMNS[*].defaults` — the column ids land in config either way, and `create_labels_if_missing: true` on the writeback mutations means even label-less status/dropdown columns heal on first write.

- [ ] **Step 5: Commit** — `git add scripts/setup-quotes-group.js scripts/test-quote-trigger.js && git commit -m "feat(quote): idempotent quotes-group setup script (TDD)"`

---

### Task 11: write-lead-times.js + runPlanner hook + BOTH wirings

**Files:**
- Modify: `scripts/quote-engine.js` (add `leadTimesForBasket`)
- Create: `scripts/write-lead-times.js`
- Create: `scripts/test-write-lead-times.js`
- Modify: `scripts/run-planner.js` (outputs stage + CLI wiring)
- Modify: `scripts/planner-trigger.js` (runPlannerFn wiring)
- Modify: `scripts/test-run-planner-orchestrator.js` (writer hook coverage)

- [ ] **Step 1: Write the failing test** (`scripts/test-write-lead-times.js`):

```js
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildLeadTimesArtifacts, writeLeadTimes } = require('./write-lead-times.js');
const { CREW_BASE_HOURS } = require('./rebalance-schedule.js');

const failures = [];
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else { failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label} — ${detail}`); }
}

const fakeBasketResults = [
  { label: 'Typical residential FF', jobType: 'Res - Face Frame', display: 'Face frame', quotedWeek: '2026-09-07', weeks: 12 },
  { label: 'Typical residential FL', jobType: 'Res - Frameless', display: 'Frameless', quotedWeek: '2026-09-07', weeks: 12 },
  { label: 'Typical commercial', jobType: 'Commercial', display: 'Commercial', quotedWeek: '2026-08-24', weeks: 10 },
];

console.log('Test 1: artifact shape + no-leak (spec §4.5)');
const arts = buildLeadTimesArtifacts(fakeBasketResults, { now: () => new Date('2026-06-12T12:00:00Z') });
const json = JSON.parse(arts.json);
check('json has generatedAt + leadTimes', !!json.generatedAt && json.leadTimes.length === 3);
check('json entries carry display label + weeks + quotedWeek only',
  Object.keys(json.leadTimes[0]).sort().join(',') === 'label,quotedWeek,weeks',
  JSON.stringify(json.leadTimes[0]));
const allText = arts.json + arts.html;
check('NO capacityWeek anywhere', !allText.includes('capacityWeek') && !allText.includes('apacity'));
for (const crew of Object.keys(CREW_BASE_HOURS)) {
  check(`no crew name '${crew}' leaks`, !allText.includes(crew), 'shop internals in a public artifact');
}
check('html mentions all three types', arts.html.includes('Face frame') && arts.html.includes('Frameless') && arts.html.includes('Commercial'));
check('html carries as-of date', arts.html.includes('2026-06-12'));

console.log('Test 2: writeLeadTimes writes dated + stable + snippet files');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leadtimes-'));
(async () => {
  await writeLeadTimes(fakeBasketResults, { logsDir: tmp, now: () => new Date('2026-06-12T12:00:00Z') });
  check('dated json', fs.existsSync(path.join(tmp, 'lead-times-2026-06-12.json')));
  check('stable json', fs.existsSync(path.join(tmp, 'lead-times.json')));
  check('snippet html', fs.existsSync(path.join(tmp, 'lead-times-snippet.html')));

  console.log(failures.length ? `\n❌ ${failures.length}/${checks} FAILED` : `\n✅ all ${checks} checks passed`);
  process.exit(failures.length ? 1 : 0);
})();
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement.**

Append to `scripts/quote-engine.js` (and export):

```js
// Reference-basket quotes for the dealer artifact (spec §4.5). Shares ONE
// baseline across the basket; returns ONLY what the public artifact may carry.
async function leadTimesForBasket(boards, policy, { now = () => new Date(), runPlanFn } = {}) {
  const results = [];
  for (const b of policy.referenceBasket) {
    const res = await runQuote(
      { rowId: `basket-${results.length}`, name: b.label, jobType: b.jobType, boxes: b.boxes, complexity: b.complexity },
      { boards, policy, now, runPlanFn });
    if (!res.ok) throw new Error(`lead-times basket '${b.label}' failed: ${res.reason}`);
    const weeks = Math.round((parseISO(res.quotedWeek) - getMondayOfWeek(now())) / (7 * 24 * 3600 * 1000));
    results.push({ label: b.label, jobType: b.jobType, display: JOB_TYPES[b.jobType].display,
      quotedWeek: res.quotedWeek, weeks });
  }
  return results;
}
```

Create `scripts/write-lead-times.js`:

```js
#!/usr/bin/env node
/**
 * Dealer-portal lead-times artifacts (spec §4.5). HEADLINE NUMBERS ONLY —
 * quotedWeek (post-policy-floor), never capacityWeek, never crew/job/load
 * detail: the transport may end up public. test-write-lead-times.js enforces.
 * Runs as the third independent writer in run-planner's outputs stage
 * (per-writer failure policy) and standalone: `node scripts/write-lead-times.js`.
 */
const fs = require('fs');
const path = require('path');
const DEFAULT_LOGS_DIR = path.join(__dirname, '..', 'logs');

function localDateISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildLeadTimesArtifacts(basketResults, { now = () => new Date() } = {}) {
  const asOf = localDateISO(now());
  const json = JSON.stringify({
    generatedAt: now().toISOString(),
    leadTimes: basketResults.map(r => ({ label: r.display, weeks: r.weeks, quotedWeek: r.quotedWeek })),
  }, null, 2);
  const parts = basketResults.map(r => `${r.display} ~${r.weeks} wks`);
  const html = `<div class="htw-lead-times">Current lead times: ${parts.join(' · ')} <span class="asof">· as of ${asOf}</span></div>\n`;
  return { json, html, asOf };
}

async function writeLeadTimes(basketResults, { logsDir = DEFAULT_LOGS_DIR, now = () => new Date(), dryRun = false } = {}) {
  const { json, html, asOf } = buildLeadTimesArtifacts(basketResults, { now });
  const files = [
    [path.join(logsDir, `lead-times-${asOf}.json`), json],
    [path.join(logsDir, 'lead-times.json'), json],
    [path.join(logsDir, 'lead-times-snippet.html'), html],
  ];
  if (dryRun) { console.log(`  [DRY RUN] would write: ${files.map(f => path.basename(f[0])).join(', ')}`); return { dryRun: true, files: files.map(f => f[0]) }; }
  fs.mkdirSync(logsDir, { recursive: true });
  for (const [p, content] of files) fs.writeFileSync(p, content);
  return { files: files.map(f => f[0]) };
}

module.exports = { buildLeadTimesArtifacts, writeLeadTimes };

if (require.main === module) {
  (async () => {
    const { loadAll } = require('./rebalance-schedule.js');
    const { loadQuotePolicy, leadTimesForBasket } = require('./quote-engine.js');
    const policy = loadQuotePolicy();
    const boards = await loadAll({});
    const basket = await leadTimesForBasket(boards, policy);
    const r = await writeLeadTimes(basket, { dryRun: process.env.DRY_RUN === '1' });
    console.log(`✓ lead-times artifacts: ${r.files.join(', ')}`);
  })().catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Hook into `runPlanner`'s outputs stage** (`scripts/run-planner.js`, after the Weekly Briefing block, inside the same outputs `if/else` — and ALSO change the outputs-stage gate so a wired lead-times writer alone triggers the stage: the condition `if (!_writeCapacityView && !_writeWeeklyBriefing)` becomes `if (!_writeCapacityView && !_writeWeeklyBriefing && !_writeLeadTimes)`; declare `const _writeLeadTimes = deps.writeLeadTimes;` alongside the other two):

```js
    if (_writeLeadTimes) {
      try {
        const { loadQuotePolicy, leadTimesForBasket } = require('./quote-engine.js');
        const policy = loadQuotePolicy();
        const basket = await leadTimesForBasket(boards, policy, { now: () => generatedAt });
        const r = await _writeLeadTimes(basket, { dryRun: _dryRun, now: () => generatedAt });
        outputs.leadTimes = { ok: true, dryRun: !!r.dryRun, files: r.files };
        console.log(`  ✓ Lead-times artifacts ${r.dryRun ? '(dry-run)' : 'written'}`);
      } catch (e) {
        outputs.leadTimes = { ok: false, error: e.message || String(e) };
        console.log(`  ✗ Lead-times artifacts FAILED: ${e.message || e}`);
        console.log('    Re-run standalone: `node scripts/write-lead-times.js`. Other outputs unaffected.');
      }
    } else {
      console.log('  Lead-times writer not wired — skipped.');
    }
```

Also add `leadTimes: null` to the `outputs` initializer object.

- [ ] **Step 5: Wire BOTH CLI entries** (spec §4.5 — missing the second one means scheduled runs never emit artifacts):

In `scripts/run-planner.js` CLI entry, alongside the other two writers:
```js
  const { writeLeadTimes } = require('./write-lead-times.js');
  // ... inside deps:
      writeLeadTimes,
```

In `scripts/planner-trigger.js`, find the CLI entry's `runPlannerFn` wiring (it requires `./run-planner.js` and passes `deps: { writeCapacityView..., writeWeeklyBriefing... }`) and add `writeLeadTimes: require('./write-lead-times.js').writeLeadTimes` to that same deps object.

- [ ] **Step 6: Cover the hook in `scripts/test-run-planner-orchestrator.js`** — append one test in that file's style: invoke `runPlanner` with a stubbed `deps.writeLeadTimes` (and stub gql/loadAll deps exactly as neighboring tests do) and `check('lead-times writer invoked with basket + opts', ...)` that the stub was called once and `outputs.leadTimes.ok === true`; plus a second check that a THROWING `writeLeadTimes` stub yields `outputs.leadTimes.ok === false` while capacity-view/briefing results are unaffected (writer independence).

- [ ] **Step 7: Run** — `node scripts/test-write-lead-times.js`, `node scripts/test-run-planner-orchestrator.js`, then the full suite loop. All green.

- [ ] **Step 8: Commit** — `git add -u scripts/ && git add scripts/write-lead-times.js scripts/test-write-lead-times.js && git commit -m "feat(quote): lead-times artifacts + runPlanner hook wired in both entries (TDD)"`

---

### Task 12: V1 deprecation banner

**Files:**
- Modify: `lead-time-calculator.html`

- [ ] **Step 1: Add the banner** — in `lead-time-calculator.html`, immediately after `<div class="header">`'s closing `</div>` (after line ~403), insert:

```html
  <div style="background:#C0392B;color:#fff;padding:18px 22px;border-radius:10px;margin:0 0 24px;font-size:15px;line-height:1.5;">
    <strong>⚠ This calculator was retired in April 2026.</strong><br>
    The dates below are computed from the old production model and do <em>not</em> reflect current shop load.
    Quote lead times via the <strong>💬 Quotes</strong> group on the monday.com Manual Overrides board
    (see the Operations Manual, “Get a lead-time quote”).
  </div>
```

- [ ] **Step 2: Disable the inputs** — at the very end of the existing `<script>` block (after the `calc();` line at ~677), append:

```js
  // Retired 2026-06: V2 lives on the monday Manual Overrides board (Quotes group).
  document.querySelectorAll('input, select, .seg-btn').forEach(el => {
    el.disabled = true;
    el.style.opacity = '0.5';
    el.style.pointerEvents = 'none';
  });
```

- [ ] **Step 3: Eyeball it** — open the file in a browser: banner visible, controls greyed out, stale result card still renders beneath the warning.

- [ ] **Step 4: Commit** — `git add lead-time-calculator.html && git commit -m "docs: V1 lead time calculator retired — banner + disabled inputs"`
(Push happens with the Task 14 merge — GitHub Pages serves from main.)

---

### Task 13: Operations manual update

**Files:**
- Modify: `docs/operations-manual.md`

- [ ] **Step 1: §1 automation table** — add two rows to the "What the system does on its own" table:

```markdown
| Every minute | The same poll also answers 💬 Quote rows: any quote at **Quote Requested** is computed against live shop load and answered on the row (~1–2 min; up to 3 per minute). |
| On every planning run | Current dealer lead-times artifacts regenerate (`logs/lead-times.json` + HTML snippet) from the reference basket in `config/quote-policy.json`. |
```

- [ ] **Step 2: New §2.9 procedure** (after §2.8):

```markdown
### 2.9 Get a lead-time quote (anyone, ~1 minute + ~2 minutes wait)

1. Open the **🛠️ HTW Manual Overrides** board → **💬 Quotes** group → new item (name it after the prospect).
2. Fill: **Job Type** (Res - Face Frame / Res - Frameless / Commercial), **Boxes**, **Complexity** (1–5; blank = 2). Optional: **Target Date** — fill it to ask "can we hit this date?", leave empty to ask "when's the earliest?"
3. Set **Quote Status = Quote Requested**. Within a minute it flips to Quoting, then **Quoted** (~1–2 min).

Read the result: **Quoted Week** is the number to give the client (policy floor applied). **Capacity Week** is what raw shop capacity says — when these differ, the floor in `config/quote-policy.json` is the reason. The item's update has the full breakdown (verdict, bottleneck if any, inputs, assumptions). **Confirm with the PM before communicating dates to clients.**

**Quote Error?** The reason is on the item's update (bad input, or an engine failure — Chris is notified for the latter). Fix the row, set Quote Status back to **Quote Requested**. Re-quoting an old row works the same way — columns show the latest answer, updates keep the history.

Quote rows are an audit trail — leave them; they never touch the schedule or the planner. (Never fill **To Week** or the overrides **Status** column on a quote row — those belong to override rows and their auto-stale automations.)
```

- [ ] **Step 3: §4 Chris-only — policy tuning** (new §4.5):

```markdown
### 4.5 Quote policy (`config/quote-policy.json`) — commit immediately after every edit

- `minLeadWeeks` per job type — the quoting floor. The engine always reports the honest capacity answer next to it; tighten/loosen the floor as the boards start carrying real pipeline.
- `preProductionWeeks` — signing → engineering start (design/approval/deposit lag). Inside every quote.
- `defaultFinishingDays`, `referenceBasket` — quote defaults + what the dealer artifact quotes.
- Linted on every quote and planner run; lint failures notify you and quotes wait until fixed.
```

- [ ] **Step 4: §5 troubleshooting table** — add:

```markdown
| Quote row stuck **Quoting** >5 min | The quote died mid-flight (sleep/crash); self-heal flips it to Quote Error within ~5 min | Set back to **Quote Requested** to retry. |
| Quote Error on every row + notification about quote-policy | `config/quote-policy.json` failed lint | Chris: fix the config, commit, rows retry on the next request. |
```

- [ ] **Step 5: Quick-reference table** — add `| 💬 Quotes group / quote columns | Manual Overrides board 18413101550 (ids in config/planner-trigger.json) |` and `| Dealer lead-times artifacts | logs/lead-times.json + lead-times-snippet.html |`.

- [ ] **Step 6: Commit** — `git add docs/operations-manual.md && git commit -m "docs(ops): lead-time quote procedures (§1, §2.9, §4.5, §5)"`
(Republish of the monday copy happens at Task 14 Step 6.)

---

### Task 14: Merge, live setup, verification

**Files:** none new — this is the rollout choreography.

- [ ] **Step 1: Full suite in the worktree** — `for f in scripts/test-*.js; do r=$(node "$f" 2>&1 | tail -1); echo "$f → $r"; done` → all 32 files green (28 existing + 4 new).

- [ ] **Step 2: Merge to main** (fast-forward; main is production — the poll picks the new code up on its next tick, where it is INERT until config gains `quotesGroupId`):

```bash
cd /c/Users/chris/Harris-Tools && git merge --ff-only <worktree-branch> && git push
```

Re-run the full suite once on main. Watch one poll tick log (`logs/planner-YYYY-MM-DD.log`) — idle ticks stay silent.

- [ ] **Step 3: Live setup** — `node scripts/setup-quotes-group.js` → group + 7 columns created, config written. **Immediately:** `git add config/planner-trigger.json && git commit -m "config: quotes group + column ids (setup-quotes-group)" && git push`.

- [ ] **Step 4: Manual monday steps (Chris or Claude-with-Chris):** create the "Quotes" board view; hide the 7 quote columns in the Main view; open board automations and confirm the auto-stale recipes are conditioned on To Week/overrides-Status (they are — quote rows never set either) and nothing targets the Quotes group.

- [ ] **Step 5: Positive-path live verification (Claude):**
  1. `DRY_RUN=1 node scripts/planner-trigger.js --poll` with a real test quote row at Quote Requested → log shows `[DRY RUN] would write row … → Quoted (…)`, zero board changes.
  2. Real run: create quote row "TEST — delete me" (Res - Face Frame, 25 boxes, complexity 2, no target) → next tick → Quoted; verify Quoted Week ≥ Capacity Week, update body complete.
  3. Target-mode row with target 3 weeks out → expect FITS_BELOW_FLOOR or DOES_NOT_FIT with named bottleneck.
  4. Invalid row (boxes 0) → Quote Error with named reason, no notification.
  5. Run `node scripts/run-planner.js --plan` (or request a Run via the trigger) → `logs/lead-times.json` + snippet exist; open and confirm headline-only content.
  6. Launch acceptance (spec §5): for 2–3 real in-flight jobs, compare the engine's capacityWeek for an equivalent synthetic job against their planned delivery — within 2 weeks.
  7. Delete the test quote rows (monday trash = rollback safety).

- [ ] **Step 6: Republish the ops manual monday copy** (update_doc on doc 18417585088 from the repo markdown — same procedure as the 2026-06-12 publish).

- [ ] **Step 7: Verification report for Chris** — suite results, live-run evidence, and the two Chris-triggered destructive procedures, verbatim:
  - **Self-heal:** create a quote row → Quote Requested; within the first seconds of a tick (status shows Quoting), kill the node poll process (Task Manager). Expected: row sits at Quoting; within ~5 minutes a later tick flips it to Quote Error with the died-mid-flight update. Recovery: flip back to Quote Requested.
  - **Config-lint notify:** temporarily set `"preProductionWeeks": "two"` in `config/quote-policy.json` (do NOT commit); create a quote row → Quote Requested. Expected: row stays Requested, Chris gets the lint notification each tick. Restore the file (`git checkout -- config/quote-policy.json`), row then quotes normally.

- [ ] **Step 8: Final commit of the verification report** to `docs/superpowers/specs/2026-06-12-lead-time-calculator-verification.md`.

---

## Self-review checklist (run before declaring the plan done)

- Spec §2 vocabulary → Tasks 2, 10 (dropdown labels = ROUTING keys; test-enforced Task 2 Step 1).
- Spec §3 formulas → Task 7 (`mondayOnOrAfter`, walk start, floor; Tests 14/16).
- Spec §4.1 synthetic job/parents/savePath/horizon → Task 5; strict diff → Task 6; walk/target/bottleneck → Task 7.
- Spec §4.2 policy + lint → Task 4; lint-notify path → Task 9 (processQuotes policy catch).
- Spec §4.3 combined query, locks, staleMs, torn-read, 3-cap, self-heal, notifications, DRY_RUN → Tasks 8–9.
- Spec §4.4 columns/lifecycle/re-quote/validation → Tasks 9–10 + ops manual Task 13.
- Spec §4.5 artifacts, no-leak, both wirings → Task 11. Spec §4.6 banner → Task 12.
- Spec §5 tests → Tasks 1–11; launch acceptance → Task 14 Step 5.6. Spec §6 docs → Task 13.
- Spec §8 checklist items 1–11 → Tasks 2,5–7 / 1 / 4 / 8–9 / 10 / 11 / 12 / 13 / 14.
