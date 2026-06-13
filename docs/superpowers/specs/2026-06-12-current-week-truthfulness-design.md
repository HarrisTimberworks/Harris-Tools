# Current-Week Truthfulness — Design Spec

**Date:** 2026-06-12
**Status:** LIVE on main 2026-06-12 (build record below). D5 cleanup pending the first weekend rollover run.
**Owner system:** HTW production scheduling (Phases 1–3 LIVE on `main` — this is additive; nothing retired gets rebuilt).
**Sibling:** partial-station progress / Hrs Left (spec'd + planned, not built). Independent build order; merge point is the run-summary sections both features add.

## Problem

The planner treats the current week as a full nominal week no matter what day it is. Four distinct failures, all live:

1. **Nominal current week.** The grid starts at `getMondayOfWeek(today)` with full base hours per crew. On Friday 2026-06-12 this placed 40h of BCH Benchwork and then 34h of R5-P2 Bench (on Bob, at 3:40 PM) onto a week that was hours from over. Each fix was Chris hand-editing a `customWindow` — the ritual this feature kills. PATCH A compounds it: active jobs' existing subitems are excluded from the grid, so mid-week the current week looks even emptier than reality.
2. **Silent past windows.** `computeWindows` walks backwards from delivery and never looks at today's date — in-flight jobs get station windows partially or entirely in the past (SciTech, BCH cases). Past weeks have no grid slots, so those hours go unplaced; the warning lands in `plan.warnings`, which `buildRunSummary` **never includes** — log-file-only. Operators see nothing.
3. **Saturday run plans a dead week.** Sat 18:00 MDT = Sun 00:00 UTC; `getMondayOfWeek` (UTC) lands on the Monday of the week that just ended either way. The Saturday auto-run treats the finished week as placeable while the briefing (Sat/Sun → next Monday) briefs the next one.
4. **Deploys destroy history.** `loadSubitems` is board-wide (all weeks); `computeSubitemDeletes` filters by job only. The first deploy after a week rolls over deletes an in-flight job's past-week rows — the plan can never re-place them (no grid slots), so the Crew Allocation history §2.7 promises to preserve silently vanishes.

## Decisions (settled with Chris, 2026-06-12)

| # | Question | Decision |
|---|---|---|
| D1 | Current-week capacity | **Day-weighted remaining capacity with a noon rule** — not a hard mid-week cutoff (wrong Thursday mornings), not full freeze (wrong Monday mornings). |
| D2 | Past windows | **Clamp auto-computed windows forward to the effective week; report loudly** — customWindows exempt (operator intent) but lint-flagged when entirely past. Never throw; compression surfaces as invalid FCV rows. |
| D3 | Deployed rows | **Preserve past weeks (immutable history) and the current week (committed reality)** on deploys; future weeks rewritten. Exception: an accepted override row touching (job × current week) opts that job's current week back into rewrite. |
| D4 | Week rollover | **Sat/Sun runs treat next Monday as the current week** — matches the briefing's existing week rule; computed in LOCAL time (the UTC math is bug #3). |
| D5 | Stop-gap cleanup | **Remove the 2026-06-12 stop-gap customWindows (BCH, R5-P2) after the feature is verified**, with a back-to-back DRY_RUN plan diff proving the plan is unchanged. |

## D1 — Day-weighted current-week capacity

**Effective context.** A single exported helper `nowContext(clock?)` (injectable for tests, local time) returns `{ currentWeekMonday, effectiveWeek, remainingWorkdays }`:

- Mon–Fri: `effectiveWeek` = this week's Monday. `remainingWorkdays` = count of Mon–Fri days ≥ today, where **today counts only if the run starts before 12:00 local** (the noon rule). Friday 3:40 PM → 0; Monday 9 AM → 5; Wednesday 2 PM → 2.
- Sat/Sun: see D4 — `effectiveWeek` = next Monday, `remainingWorkdays` = 5.

**Placeable capacity.** Current-week grid slots gain `placeable = min(available, (base / 5) × remainingWorkdays)`. Auto-placement room for the current week becomes `max(0, min(available × SOFT_CAP_MULTIPLIER, placeable) − committed)` — the day-weighted bound is physical, so it gets no 1.05 grace. All other weeks unchanged.

**Exemptions (operator intent wins, verbatim):**
- `crewCapacityOverrides[currentWeek][crew].available` sets `placeable` directly (no day-weighting); `weekendHours` boosts add to it.
- Subcontractor pools are never day-weighted.
- `forceAssignments` and accepted override-row pins still place past the cap with the existing loud warning — the escape hatch is unchanged, but the warning text cites the day-weighted number for the current week.

**Display and validation.** Plan-JSON `capacityGrid` current-week cells gain `placeableAvail`; the nominal `avail` stays for display and over-cap flags (no false 🔴 from preserved rows). The Capacity View current-week header is annotated (e.g. "(in progress — 2 of 5 workdays remain)"). The override validator's capacity check uses `placeableAvail` when present, so a Friday-afternoon row targeting the dying week comes back **Conflict** unless Allow Over-Cap is ticked — the system now says out loud that the week is over.

**Documented limitation:** PTO/holiday *position within* the week is not modeled (consistent with the rest of the system); `min(available, …)` keeps the bound conservative-ish, and `crewCapacityOverrides` remains the precision tool.

## D2 — Window clamping with loud reporting

**Mechanics.** `computeWindows(job, { effectiveWeek })` gains an optional second parameter. **Absent → behavior is bit-for-bit today's** (back-compat for all existing tests and the Lead Time Calculator V2 wrapper). When present, per station, **auto-computed windows only** (stations with a `customWindow` are exempt):

- `start < effectiveWeek` → `start = effectiveWeek` (end unchanged).
- Entirely past (computed `end < effectiveWeek`) → one-week window at `effectiveWeek` ("this work is late; the only honest schedule is now").
- `packShip` clamps the same way when the delivery week itself is past (overdue job) — clamp entry recorded.
- `finishDrop` / `finishReturn` are never altered (reality anchors); a clamped PreFin/PostFin colliding with them is exactly the loud signal we want.

**Never throw.** Today `assertFinishingCycleValid` throws inside `computeWindows`; a clamp-induced invalid cycle would kill the whole run via the pass-2 guard. Rule: when ≥1 clamp occurred for a job, skip the assert — the A3 finishing-cycle row carries `valid:false` + errors + a clamp note instead (renders in the Capacity View, **blocks deploys** via the existing execute gate). Unclamped jobs keep today's throw semantics (config-error defense unchanged).

**Reporting.** Plan JSON gains `windowClamps[]`: `{ jobId, jobName, station, computedStart, computedEnd, clampedStart, clampedEnd, entirelyPast }`. Surfaces:

1. **Trigger run summary** gains two sections: "⏰ Window clamps" (per-line detail) and "⚠️ Plan warnings" — `buildRunSummary` today omits `plan.warnings` entirely; fixed here, capped at ~15 lines with "+K more in logs/planner-<date>.log".
2. **Capacity View** gains a clamp block adjacent to the finishing-cycle section.
3. **Notifications** (`shouldNotify`): unplaced hours > 0 OR clamp-induced invalid FCV rows ⇒ notify Chris. A mere clamp with feasible placement is summary-only ("clean runs are silent" preserved).

**Config lint:** a `customWindow` whose end is entirely before `effectiveWeek` ⇒ lint warning "stale customWindow (entirely in the past)" — would have flagged this week's stop-gaps a month from now.

## D3 — Deploy preservation (past + current weeks)

- **History guard:** subitems with `parentWeek < effectiveWeek` are **never deleted**, regardless of job. Fixes problem #4. Subitems with missing/unparseable `parentWeek` are treated as protected, with a warning (safety default).
- **Current-week preservation** (mid-week runs, where `effectiveWeek == currentWeekMonday`): active jobs' current-week subitems are not deleted and not recreated. They load into the grid as `preExisting` committed (a scoped carve-out to PATCH A), so they consume current-week headroom and render normally.
- **Double-count prevention:** for each (job × station), hours held by preserved current-week rows are subtracted from the station's planable remaining before placement: `planable = max(0, remaining − preservedCurrentWeekHours)`. "Committed reality" means the planner assumes this week's plan happens; real-world divergence flows back through Hrs Left / config updates on the next run. (Stale-high stays the safe direction, matching the sibling spec's philosophy.)
- **Override opt-out:** a job with an accepted override row whose From Week or To Week equals the current week gets its current-week rows **rewritten** (delete + recreate for that job only, no subtraction) — explicit mid-week moves keep working exactly as today.
- **New current-week placements** for preserved jobs (into remaining `placeable` headroom) create rows *additively*; no duplication because of the subtraction above.
- `computeSubitemDeletes(existingSubs, placements, { effectiveWeek, currentWeekMonday, rewriteJobIds })`: delete iff job is replanned AND `parentWeek ≥ effectiveWeek` AND NOT (`parentWeek == currentWeekMonday` AND mid-week AND job ∉ rewriteJobIds). On weekend runs `effectiveWeek` = next Monday, so the just-ended week falls under the history guard automatically. `scripts/test-execute-delete-guard.js` extends accordingly.

## D4 — Week rollover

- `nowContext()` (D1) is the single source of truth: Sat/Sun (LOCAL) → `effectiveWeek` = next Monday with full capacity; Mon–Fri → this Monday with the noon rule.
- Grid `startWeek = effectiveWeek` — weekend runs no longer even contain the dead week.
- The briefing's week rule (UTC Sat/Sun → next Monday, decision §H.5 of the Phase-2 plan) is **intentionally unchanged**: it agrees with `effectiveWeek` on weekends; the Friday-evening divergence (briefing previews next week while the plan still treats Friday as current) is benign and matches the Friday-shutdown usage.
- Only "what is today / what weekday / before noon" uses the local clock; all existing Monday/ISO week-string arithmetic (UTC) is untouched.

## D5 — Stop-gap cleanup

After the feature is live-verified:

- **Remove** from `config/rebalance-overrides.json`: BCH (11693166564) `customWindow` (panel 6/08–6/19, bench 6/15–6/19) and R5-P2 (11835189937) `customWindow` (panel 6/15–6/19, bench 6/15–6/26).
- **Keep:** the Spencer 31.5h bench `forceAssignment` @ 6/15 (capacity pacing, not a timing stop-gap); all `remainingHours` entries (sibling feature's territory); all other config entries.
- **Verification:** back-to-back `DRY_RUN=1 node scripts/run-planner.js --plan` runs in the same effective week — baseline (stop-gaps present) vs candidate (removed) — and diff the placements. Expected: identical, because the clamped auto-windows reproduce the stop-gaps (BCH bench → 6/15–6/19; BCH panel → clamped to 6/15; R5-P2 bench → 6/15–6/26 via 102h/3-week count against delivery 7/02; R5-P2 panel → 6/15). Chris approves the diff before the config edit; commit immediately (shared-working-tree rule).

## Code changes

All in existing files; one new test-support concept (injectable clock).

1. **`scripts/rebalance-schedule.js`** — `nowContext()` helper (exported); grid `startWeek = effectiveWeek`; current-week `placeable` on slots + room formula in `allocateStationWeek` / primaries filter / force warning; `computeWindows` optional `{ effectiveWeek }` + clamp logic + no-throw-on-clamp; PATCH A carve-out (preserved current-week rows as preExisting); per-station planable subtraction; `windowClamps` + `placeableAvail` in the report; week-aware `computeSubitemDeletes`.
2. **`scripts/run-planner.js`** — thread `nowContext` through plan + validation; pass `rewriteJobIds` (accepted rows touching current week) into the delete computation; carry `windowClamps`/warnings/unplaced totals in the result for the trigger.
3. **`scripts/planner-trigger.js`** — `buildRunSummary` gains clamp + plan-warnings sections; `shouldNotify` gains unplaced-hours / clamp-invalid-FCV reasons.
4. **`scripts/validate-overrides.js`** — capacity check uses `placeableAvail` when present on the destination cell.
5. **`scripts/capacity-view-generator.js`** — current-week header annotation; clamp block.
6. **Config lint** (the existing lint pass in `scripts/run-planner.js`) — stale-customWindow warning.

## Testing (strict TDD, existing suite conventions)

- `nowContext` matrix: every weekday × before/after noon, Sat, Sun, plus a DST-week sanity case; injectable clock so all tests are hermetic.
- Clamp matrix: partial-past, entirely-past, customWindow exemption, packShip/overdue, no-throw-on-clamp (invalid FCV row instead), **no-second-arg ≡ today's behavior bit-for-bit** (existing tests stay green untouched).
- Day-weighting: Friday-PM zero, Monday-AM full, Wednesday-PM partial; crewCapacityOverride exemption; weekendHours boost; subcontractor exemption; force bypass warning text.
- Delete guard: history protection (past weeks, any job), current-week preservation, override opt-out, missing-parentWeek safety, weekend rollover protection.
- Double-count subtraction: preserved rows shrink planable hours; opt-out jobs don't subtract; remaining < preserved floors at 0.
- Summary/notify: clamp + warnings sections render; 15-line cap; shouldNotify on unplaced hours and clamp-invalid FCV; silent on clean clamp-free runs.
- Validator: current-week destination uses `placeableAvail` (Conflict at 3:40 PM Friday without Allow Over-Cap).
- Config lint: stale customWindow flagged; current stop-gaps NOT flagged while still current.
- Full `scripts/test-*.js` suite green (one needs `MONDAY_API_TOKEN` from `.token`); `DRY_RUN=1 --plan` against live boards; live exercise via ▶️ Planner Trigger **Run Requested**. Deploy-side destructive verification is Chris-triggered per standing practice (unit tests + clean-state runs from this side; exact procedures listed at handoff).

## Documentation

`docs/operations-manual.md`: §1 (Saturday row → "plans the upcoming week"), §2.3 (deploy preserves past + current weeks; override exception), §2.5 (replace "that currently needs Chris (config window override)" with the automatic clamp + loud report), §4.2 (customWindow stale-lint note), §5 (what ⏰ clamp lines and unplaced-hours notifications mean). Republish the monday copy (doc 18417585088).

## Out of scope

- Holiday-aware day-weighting (needs Chris's shop-holiday list — existing backlog item; `crewCapacityOverrides` remains the tool).
- The Hrs Left build (separate approved plan), intra-week day sequencing (planner stays week-granular), the briefing week rule, PLB window-column ownership, shared-constants module.
- monday-side automation changes; the Manual Overrides board schema.

Build record appended to this spec when the feature lands.

## Build record — 2026-06-12 (evening session)

Built in worktree `feat/current-week-truthfulness` via subagent-driven development (5 implementer batches, Sonnet; main-session diff review + independent suite run after each batch), merged to main same evening with Chris's approval. Suite: 32 test files at baseline → **37 files, 0 failures** at merge (~+120 checks across 6 new/extended test files). The Hrs Left sibling and Lead Time Calculator V2 landed on main in parallel sessions during this build; final merge was conflict-free.

**Commits (plan Tasks 2–11):** `510f900` nowContext · `0df6c84` computeWindows clamping · `a61dc33` runPlan effectiveWeek/windowClamps/unplacedTotal · `b4cc9c0` day-weighted placeable · `8a87a41` current-week preservation + subtraction · `7719350` week-aware delete guard + rewrite opt-out · `ef706ad` validator placeableAvail + consistency fix · `8ba56da` trigger summary/notify · `c6ec65e` capacity view annotation + clamp block · `cefb2df` stale-customWindow lint · `867e457` merge main.

**Decisions settled during the build:**
1. **Clamped chains recompute downstream (incl. finish drop/return).** Clamping a station forward moves the anchors later stations (and the finishing cycle) compute from — the cycle is re-checked against reality and goes to an invalid FCV row if broken. "Never altered" in D2 means the clamp function doesn't touch drop/return directly.
2. **Validator consistency fix (not in the plan, caught in batch-C review):** `checkConsistency` only summed baseline *placements*; preserved current-week hours are `preExisting`, so a From=current-week move row would always false-Conflict. Fix: `validateAll` gains an optional `existingSubs` param (run-planner passes `boards.existingSubs`); when `row.fromWeek === baselinePlan.nowContext.currentWeekMonday && isMidWeek`, matching board subitems count toward the From-side hours. Disjoint sources — never double-counts.
3. **runPlan no longer dies on a computeWindows throw** (bad customWindow config): per-job try/catch degrades to a loud warning + job skip; the job's existing rows are protected by the delete guard. Better than the old whole-run abort.
4. **`buildCapacityGrid` exported**; signature `(crewParents, timeOffList, weeks, existingSubs, activeJobMasterPmIds, ctx = null, preserveOpts = null)` — both new params optional, legacy callers unchanged.

**Live verification (Friday evening 2026-06-12, DRY_RUN in worktree):** `nowContext { currentWeekMonday: 2026-06-08, effectiveWeek: 2026-06-08, remainingWorkdays: 0, isMidWeek: true }`; `placeableAvail: 0` on every crew's current-week cell; **0 new placements in the dying week**; Ken's deployed 2h BCH Panel row loaded as preExisting. Diff vs the production plan generated 11 min earlier by old code: **exactly 1 difference** — old code re-placed that 2h into 6/08 and queued its subitem (id 12267927924) for deletion (33 deletes); new code preserves it (32 deletes). Bonus: the stale-window lint flagged 15 customWindows on already-delivered jobs (Edge Optics, Cator Ruma, R5-P1, Gilbert, Liz Stapp, SHI, Quince) — cleanup candidates beyond D5's scope.

**Post-merge:** suite green on main; live exercise via ▶️ Planner Trigger Run Requested (summary sections verified). **Pending:** Saturday 18:00 auto-run = first natural weekend rollover (expect effectiveWeek 2026-06-15, dead week absent from grid); D5 stop-gap removal after that run (clamps reproduce the stop-gap windows only once effectiveWeek = 6/15); Chris-triggered mid-week-deploy preservation check (plan Task 13 procedure).
