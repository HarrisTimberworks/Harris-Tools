# Lead Time Calculator V2 — Design

**Date:** 2026-06-12
**Status:** Approved design, pending implementation plan
**Replaces:** `lead-time-calculator.html` (V1 static GitHub Pages tool, built on the retired CNC/Asm1/Asm2 production model — dates and load bars no longer reflect the shop)

## 1. Purpose

A quoting tool for Chris and Jonathan at bid time: given a rough job description, answer either
(a) **earliest feasible delivery week** ("if we signed today, when could this deliver?"), or
(b) **fits / doesn't fit** for a client's target date, with the blocking constraint named.

The answer must be **live-load-aware** — computed against the real schedule (committed crew hours, time off, hard rules, overrides), not standard durations. A secondary per-run artifact publishes headline "current lead times" numbers as the future dealer-portal feed.

## 2. Decisions locked with the owner

| Decision | Choice |
|---|---|
| Primary user / moment | Chris/Jonathan, quoting at bid time |
| Load model | Live shop load (full planner fidelity) + config policy floor |
| Form factor | monday-native: quote rows on the Manual Overrides board, handled by the existing minute poll |
| Answer modes | Both: earliest-feasible AND target-date verdict |
| Inputs | Pure minimal: Job Type, Boxes, Complexity (1–5). Everything else defaulted |
| Accuracy target | Within a ~2-week window |
| Dealer portal | Out of scope; this design emits its data feed (JSON + HTML snippet) only |

**Job-type vocabulary (canonical, used everywhere except the public snippet):** the board dropdown labels are the planner's exact ROUTING keys, verbatim — `Res - Face Frame`, `Res - Frameless`, `Commercial` (`scripts/rebalance-schedule.js` ROUTING/SECONDARY maps). `config/quote-policy.json` keys use the same strings. Only the dealer snippet maps to friendly labels (Face frame / Frameless / Commercial). A test asserts every configured job type is a key of the exported ROUTING object — no second vocabulary exists to drift.

## 3. The demand-visibility finding (why the policy floor exists)

Verified against `logs/rebalance-plan-2026-06-12.json`: the schedule holds ~300–350 committed hours across 6 active jobs (~1.6 weeks of the shop's ~215 h/wk), essentially free from 2026-07-06 onward; max delivery on the board is 2026-08-17. An honest capacity engine therefore answers ~6–9 weeks for a typical job while the shop quotes 12–14. The gap is demand the boards cannot see: sold-but-unloaded pipeline (the planner skips jobs without delivery dates), pre-production lag (design/approval/deposit before Engineering starts), and door procurement.

**Resolution — defined once, used verbatim everywhere:**

- `capacityWeek` = the candidate-walk result. The walk starts at `today + preProductionWeeks`, so pre-production lead is already inside `capacityWeek`.
- `floorWeek` = the Monday **following** `today + minLeadWeeks[type] × 7 days` (conservative snap). `minLeadWeeks` counts from today/signing — pre-production is inside it, never added again.
- `quotedWeek = max(capacityWeek, floorWeek)`.
- **Both numbers are always reported.** Chris tunes the floor; as the boards start carrying real pipeline, the floor can shrink toward zero.

## 4. Architecture

Four **runtime** components (two new scripts + shared hours module, one extended script), plus supporting changes: a setup script, a `run-planner.js` writer hook, ~6 export lines in `rebalance-schedule.js`, the V1 deprecation banner, and an ops-manual update (full checklist in §8).

```
quote row (monday)                puzzle run (existing planner run)
      │ minute poll                       │ outputs stage
      ▼                                   ▼
scripts/planner-trigger.js        scripts/write-lead-times.js
  (detect, lock, writeback)          (reference basket → artifacts)
      │ calls                             │ calls
      ▼                                   ▼
        scripts/quote-engine.js  (reads boards; computes; never writes)
              │ fresh loadAll() + in-memory quoteRunPlan (savePath:null, structural)
              ▼
   result object → trigger writes row/update;  basket → logs/lead-times*.json + snippet
```

**Mutation boundary:** `quote-engine.js` performs **reads only** (board fetch + pure compute). All monday mutations — status flips, column writes, updates, notifications — live in the `planner-trigger.js` quote handler (and the artifact files in `write-lead-times.js`). `DRY_RUN=1` therefore gates the trigger/writer layer (prints intended writebacks/files, mutates nothing); the engine needs no DRY_RUN awareness.

### 4.1 `scripts/quote-engine.js` + `scripts/quote-hours-model.js` (new)

- **Hours model** (`quote-hours-model.js`, the single update point): Job Type maps to box-type — `Res - Face Frame` → FF boxes; `Res - Frameless` and `Commercial` → FL boxes (commercial casework is frameless construction). Station hours = (factor × boxes) × complexity multiplier (1=0.8, 2=1.0, 3=1.15, 4=1.4, 5=1.75 — the live board applies complexity to **all five stations**):

  | Station | FF factor | FL factor |
  |---|---|---|
  | Engineering | 0.6 | 0.4 |
  | Panel Processing | **0.55** | 0.55 |
  | Benchwork | 0.3 | 0.15 |
  | Pre Fin Cab Assembly | 1.10 | 0 |
  | Post Fin Cab Assembly | 0.45 | 0.65 |

  ⚠ The Panel FF factor is **0.55 per the live board formula** (`formula_mm2dxy2k`); `docs/htw-production-system-handoff.md` said 0.38 and was stale (corrected 2026-06-12). **The drift-test fixture must be captured from the live board column `settings_str`, never from docs.** Additional live-formula inputs defaulted to zero for quotes: miter fold LF, countertop SF (and PP override), backsplash LF, CU per-station overrides, Slab Veneer Door Count (×0.05 Panel, ×0.167 Bench), Countertop SW Nosing LF (×0.25 Bench). Inset and P-Lam multipliers default to 1.0 / off. **Build-time calibration step:** verify module output against the live PLB formula columns for 2–3 real jobs before launch.

- **Synthetic job** (every field load-bearing):

  ```js
  {
    id: 'QUOTE-<rowId>',            // sentinel; consumed by skipJobs check + placements.jobId
    name: 'QUOTE - <item name>',
    status: 'Scheduled',            // REQUIRED: runPlan filters activeJobs by status allowlist;
                                    // a status-less job is silently dropped → every candidate "fits"
    subtype: '<exact ROUTING key>', // see §2 vocabulary
    delivery: '<candidate Monday>',
    hours: { eng, panel, bench, prefin, postfin },
    finishingDays: <policy default>,
    pLam: false,
    masterPmId: null,
    customWindow: null,
  }
  ```

  A dedicated test asserts the synthetic job **actually produces placements** in a candidate run (guards the silent-drop failure), and another asserts the mapped subtype is a key of the real exported ROUTING object.

- **Engine flow per quote:**
  1. Fresh `loadAll()` — live jobs, Stations Complete ticks, Time Off, config overrides. Never reads a persisted plan file. The 15–45 s quote budget is almost entirely this serial API fetch; plan compute is milliseconds per candidate — do not "optimize" the fetch away.
  2. **Baseline** `quoteRunPlan` in-memory (no synthetic job).
  3. **Earliest mode:** for candidate delivery Mondays from `today + preProductionWeeks` forward, inject the synthetic job and re-run; accept the first candidate where the job **fully places** (no unplaced hours) and the run is **no worse than baseline**. "No worse" is defined on the diff key `station × week × crew`: a warning/over-cap counts as *new* if its key is absent from baseline **or** its over-cap magnitude grew at all (strict — a quote must not deepen an existing overload). Feasibility is not assumed monotone; the walk is linear and capped at 26 weeks (exhaustion → Quote Error "does not fit within 26 weeks").
  4. **Target mode:** target date snaps to the Monday of its week (planner convention). Single run at that week → verdict. The earliest-mode walk also runs (deliberate cheap extension of the locked modes — data already loaded, and "doesn't fit, but w/o 9/14 does" is the quoting conversation) so `capacityWeek` has a consistent meaning in both modes.
  5. Policy layer per §3: `quotedWeek = max(capacityWeek, floorWeek)`; both reported.
  6. **Bottleneck naming:** from the failing candidates' diff vs baseline — which station × week × crew produced the unplaced hours or new over-cap — phrased in the override validator's named-reason style.

- **Plan-file safety (5/25 incident class):** the engine calls the planner only via an internal `quoteRunPlan(boards, job)` wrapper that hard-codes the no-persist option. Raw `runPlan` is not reachable from quote code paths; a test asserts no quote code path can write `logs/rebalance-plan-*.json`.

- **Horizon (day-one requirement, not a someday edge):** the planner `process.exit(1)`s when Crew Allocation parent rows are missing for grid weeks; rows are pre-generated only through **2026-12-28**, and the 26-week exhaustion walk crosses that **from day one** (2026-06-12 + 26 wk + the planner's +28-day horizon ≈ 2027-01-11). Even the base planner's 84-day floor breaches it ~Oct 5. `--auto-create-parents` is read from `process.argv` at module load, so it is unreachable as an in-memory option — synthetic parents are the right call: before each run, inject in-memory parent rows `{parentId:'synthetic-<n>', week, crew, base, timeOff:0, nonProd:0}` for every beyond-coverage week, built from the planner's own crew constants. **`CREW_BASE_HOURS`, `BOB_START_DATE`, `CREW_END_DATES` get exported from `rebalance-schedule.js` (~6 lines)** — no duplication (drift class this repo was burned by; aligns with the shared-constants backlog item).

### 4.2 `config/quote-policy.json` (new)

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

Initial values above are launch settings, tunable without code changes. Linted on every quote and every planner run, same loud-failure + notification pattern as the overrides config lint. Committed immediately after every edit (parallel-session rule).

### 4.3 `scripts/planner-trigger.js` (extended)

- New **💬 Quotes** group on the Manual Overrides board (18413101550). The per-tick status read is **extended into a combined single-request query** (trigger item + Quotes group `items_page` as two root fields in one GraphQL document) — still one API call per idle tick. `runOnce`'s parse path and the `test-planner-trigger.js` gql stubs change shape with it.
- Status lifecycle: **Quote Requested → Quoting → Quoted / Quote Error.** **Re-quote rule:** flipping a row's status back to Quote Requested re-processes it in place — result columns are overwritten (columns show latest), but every result posts a **new** update (updates preserve history, so the audit trail survives re-quotes).
- **Locking:** quotes take `logs/quote.lock` (exported parameterized `acquireLock`/`releaseLock`) with a **quote-specific `staleMs` of 5 minutes** (the inherited 45-min default is sized for planner runs; quotes run 15–45 s). Never `planner.lock`. If `planner.lock` is held (run/deploy in flight), the quote defers one tick. **Torn-read guard:** the planner side does not check `quote.lock` (quotes are read-only, nothing to protect from them); instead, after its `loadAll()` completes, the quote handler re-checks `planner.lock` — if a run/deploy started mid-fetch, the fetched state may be torn, so discard and defer to the next tick.
- Up to 3 quotes processed per tick (sequential); ticks overrun the minute at worst — the poll task already runs under Task Scheduler `IgnoreNew`, and `quote.lock` serializes any overlap.
- **Self-heal:** the existing stuck-Running sweep extends to quotes — Quoting + absent/stale `quote.lock` ⇒ flip to Quote Error with an explanation update. Heals within a minute when the lock file is absent (clean-throw path); within ~5 minutes after a hard kill (lock present until staleMs).
- **Notifications:** input errors → none (reason lands on the row; requester is watching it). Engine/API failures → notify Chris, same as planner errors. Clean quotes are silent.

### 4.4 Board schema (new columns, hidden in the main view, shown in a "Quotes" view)

| Column | Type | Notes |
|---|---|---|
| Job Type | dropdown | `Res - Face Frame` / `Res - Frameless` / `Commercial` (= ROUTING keys verbatim) |
| Boxes | number | required ≥ 1 |
| Complexity | number | 1–5; empty → 2; non-integers round to nearest before validation |
| Target Date | date | optional; empty = earliest-feasible mode |
| Quote Status | status | Quote Requested / Quoting / Quoted / Quote Error |
| Quoted Week | date | `quotedWeek` (policy headline, sortable) |
| Capacity Week | date | `capacityWeek` (honest engine answer; same meaning in both modes) |

**Target-mode outcomes** (Quote Error is reserved for validation/engine failures — a computed verdict is always Quoted):

| Outcome | Quote Status | Quoted Week | Capacity Week | Update says |
|---|---|---|---|---|
| Fits, ≥ floor | Quoted | target week | earliest-that-fits | "FITS" |
| Fits, below floor | Quoted | `max(target, floorWeek)` | earliest-that-fits | "fits capacity, but below policy floor (X wks) — quote w/o Y unless overriding" |
| Doesn't fit | Quoted | `max(earliest-that-fits, floorWeek)` | earliest-that-fits | "DOES NOT FIT: <named bottleneck>. Earliest that fits: w/o Z" |

Result detail is posted as an **update on the quote item**: headline quote, capacity date + floor explanation, verdict, echo of inputs and defaults used (including any complexity rounding), data-freshness timestamp, "confirm with PM before client commitment" disclaimer.

**Audit-trail safety (corrected mechanism):** the 8:15 AM "housekeeping" is **monday-native automations on the board** (documented in `docs/htw-cross-training-matrix.md` §automations), triggered on the **To Week** date column arriving with conditions on the **overrides Status** column. Quote rows are safe because they never populate either column — this is a standing constraint: **quote rows must never set To Week or the overrides Status column.** Build-time task: open the board's automations, confirm none touch the Quotes group, and note in `setup-quotes-group.js` docs that future automations on board 18413101550 must be checked against the Quotes group.

Input validation (fail to Quote Error with named reason): missing/zero boxes, job type not in the dropdown set, complexity outside 1–5 after rounding, target date in the past or inside `today + preProductionWeeks`.

An idempotent `scripts/setup-quotes-group.js` (clone of the setup-trigger-item pattern, duplicate-guarded) creates the group/columns and persists ids into `config/planner-trigger.json` — committed immediately. **One-time manual setup step** (monday UI, listed in the implementation plan): create the "Quotes" board view showing quote columns; hide quote columns in the Main view.

### 4.5 `scripts/write-lead-times.js` (new)

- Runs in `run-planner.js`'s outputs stage with the same per-writer failure policy (loud log + recovery note, never blocks other writers). **Interface change, named:** the two existing writers receive only pre-built markdown; this one needs board data — `runPlanner` gains a `deps.writeLeadTimes` hook whose stage receives `boards` (in scope in the orchestrator) + the final plan. **Wired in BOTH entry points:** the `run-planner.js` CLI entry *and* `planner-trigger.js`'s `runPlannerFn` — miss the second and trigger-driven runs (i.e. all scheduled ones) would never emit artifacts. `test-run-planner-orchestrator.js` updates accordingly. Standalone CLI mode fetches fresh.
- Quotes the `referenceBasket` in-memory and writes:
  - `logs/lead-times-YYYY-MM-DD.json` (dated, local-date convention) and stable `logs/lead-times.json`
  - `logs/lead-times-snippet.html` — embeddable block ("Current lead times: Face frame ~12 wks · Frameless ~12 wks · Commercial ~10 wks · as of <date>")
- **The artifact carries `quotedWeek` (post-policy-floor) only — `capacityWeek` never leaves the quote row/update.** Publishing the honest 6–9-week number to dealers is exactly the failure the floor exists to prevent. Enforced by the no-leak test.
- **No-leak rule:** artifacts contain job-type headline weeks and a date only — no crew names, no hours, no load detail, no job names, no capacity weeks (transport may end up public). A test asserts this.
- Publishing/transport (WordPress, GitHub Pages, anything) is explicitly out of scope.

### 4.6 V1 deprecation banner (named deliverable)

Edit `lead-time-calculator.html`: a prominent banner — "⚠ Retired April 2026: these dates are computed from the old production model and do not reflect current shop load. Quote via the 💬 Quotes group on the Manual Overrides board." Inputs disabled. Commit + push to main so GitHub Pages serves it. Silently-wrong calculators are how we got here.

## 5. Testing

Four hermetic test files, house style (plain Node `check()` harness, zero API, runnable via existing `node scripts/test-*` allowlist):

1. **`test-quote-hours-model.js`** — factors × type × complexity fixtures (incl. complexity rounding); drift fixture **captured from live board `settings_str`**; job-type-map-keys ∈ ROUTING assertion.
2. **`test-quote-engine.js`** — synthetic board snapshots: walk lands the right week; synthetic job produces placements (silent-drop guard); over-cap blocks; strict no-worse-than-baseline diff (incl. pre-existing-warning growth); bottleneck named; policy floor + Monday snapping; all three target-mode outcomes; beyond-coverage synthetic parents; capped-walk exhaustion; no quote code path writes `rebalance-plan-*.json`.
3. **`test-quote-trigger.js`** — stubbed deps: lifecycle incl. re-quote-in-place; quote.lock staleMs=5 min; planner.lock deferral + post-fetch torn-read re-check; 3-per-tick cap; stuck-Quoting self-heal; combined poll query parse; writeback shapes; notification policy; DRY_RUN prints-not-writes.
4. **`test-write-lead-times.js`** — artifact shape, dated+stable file pair, quotedWeek-only + no-leak assertions, writer-failure independence, both-entry-point wiring (orchestrator test).

**Launch acceptance (accuracy):** `capacityWeek` computed for 2–3 real in-flight jobs lands within 2 weeks of their actual planned delivery. Persisted quote rows enable periodic quoted-vs-actual review later (no tooling now).

**Live verification split (house rule):** Claude runs the suite + positive-path live quotes (real rows on the Quotes group, clean-state, test rows deleted after). Destructive/negative paths — kill mid-Quoting to prove self-heal (expect ~5-min heal), malformed policy config notify — are Chris-triggered, with exact procedures written into the verification report.

## 6. Documentation deliverable

Update `docs/operations-manual.md` (repo = source of truth; republish the monday copy): new §2 procedure "Get a lead-time quote" (how to fill a row, what the four statuses mean, Quoted Week vs Capacity Week, re-quote rule), a Quote Error row in the §5 troubleshooting table, policy-floor tuning in §4 (Chris-only: edit `config/quote-policy.json` + commit immediately), and new §1 automation-table rows (minute poll also processes quotes; lead-times artifact per run).

## 7. Out of scope

- The WordPress dealer portal itself (artifact is the contract; portal is a future session).
- Auto-publishing artifacts anywhere.
- Quote → job conversion automation (intake flow unchanged, ops manual §2.6).
- Holiday/PTO capacity UX beyond what the planner already models (existing backlog item).

## 8. Deliverables checklist (for the implementation plan — nothing off this list)

1. `scripts/quote-hours-model.js` + calibration vs live PLB formulas
2. `scripts/quote-engine.js` (incl. `quoteRunPlan` wrapper, synthetic parents, walk, policy layer)
3. `rebalance-schedule.js` exports: `CREW_BASE_HOURS`, `BOB_START_DATE`, `CREW_END_DATES`
4. `config/quote-policy.json` + lint wiring
5. `planner-trigger.js` quote handling (combined query, locks, lifecycle, self-heal, writebacks, notifications)
6. `scripts/setup-quotes-group.js` + config ids + **manual step:** Quotes view / hide columns in Main + **verify board automations don't touch the Quotes group**
7. `scripts/write-lead-times.js` + `deps.writeLeadTimes` hook wired in **both** entry points
8. Four test files (§5) — all green alongside the existing 28-file suite
9. V1 deprecation banner committed + pushed (§4.6)
10. Ops manual update + monday republish (§6)
11. Live verification report with Chris-triggered destructive procedures (§5)

## 9. Risks & mitigations (from the 9-agent research pass + 3-lens adversarial spec review)

| Risk | Mitigation |
|---|---|
| Phantom quote job poisons the deploy plan file (5/25 class) | `quoteRunPlan` wrapper hard-codes no-persist; test-enforced |
| Synthetic job silently dropped by status filter → every quote "fits" | `status: 'Scheduled'` in the shape; placements-exist test |
| Wrong routing keys → zero eligible crews → confident wrong verdicts | Dropdown labels = ROUTING keys verbatim; keys-∈-ROUTING test |
| Hours-factor drift (handoff doc was already stale on Panel FF) | Single shared module; drift fixture from live board `settings_str`; build-time calibration |
| `process.exit(1)` on missing crew parents past 2026-12-28 coverage — reachable from day one via the 26-week walk | Synthetic in-memory parent injection from exported crew constants, day one |
| Quote reads boards mid-deploy (torn read) | Pre-fetch `planner.lock` check + post-fetch re-check → defer one tick |
| Honest answer contradicts quoting practice; honest number leaks to dealers | Policy floor, both numbers on the row; artifact carries `quotedWeek` only, test-enforced |
| Walk runtime starving the poll | Compute ≈ ms/candidate (budget is the API fetch); 26-week cap; 3 quotes/tick; own lock; `IgnoreNew` |
| Crashed quote wedges rows for 45 min | quote.lock staleMs = 5 min; self-heal claim restated against it |
| Worst-case latency when a planner run holds the machine | Accepted: ~5–6 min, rare; matches existing system behavior |
