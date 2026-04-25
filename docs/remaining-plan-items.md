# Remaining Plan Items — Planner Improvements TODO

Open items for the rebalance-schedule planner. Add to this list when a behavior gap or improvement surfaces during a plan run.

---

## Closed

### Over-placement when force exceeds even per-week split (PATCH 5)

**Found:** 2026-04-25
**Where:** `scripts/rebalance-schedule.js::scheduleStation`
**Symptom:** Force assignments whose hours exceeded the evenly-split per-week budget (`hours / weeks.length`) caused over-placement of station hours across the rest of the window. Each later week kept a fresh `perWeek` allowance regardless of the prior force overflow, so a job's total placed hours exceeded its `remainingHours` budget.

**Concrete trigger:** Edge Optics Bench 49.9h with two 24.95h forces (Spencer 4/27 + Spencer 5/04) over a 3-week window placed 66.53h instead of 49.9h — Ian 5/11 still got 16.63h auto-placed because that week's `perWeek` was never decremented.

**Fix:** Replace static `const perWeek = hours / weeks.length` with cumulative-budget tracking — recompute `perWeek = remainingBudget / weeksRemaining` each iteration; deduct both forced and auto-placed hours from `remainingBudget`; clamp force consumption to remaining budget with a warning if exceeded.

**Test case:** Edge Optics Bench 49.9h with two 24.95h forces should place exactly 49.9h, not 66.53h or 58.21h. Ian 5/11 Edge Optics Bench should be 0h after the fix.

---

## Open

### Quince customWindow.bench cascade keeps Ken 5/04 at 42h 🟡

Same shape as the Edge Optics cascade we fixed 2026-04-25, but affecting Quince Panel landing on Ken 5/04. Quince's `customWindow.bench` pins Bench to week 5/11; Panel computes one week earlier (5/04), which lands 6.8h on Ken on top of BCH Panel 15h + R5-P2 CU Panel 20.2h = 42h. Fix would be an explicit `customWindow.panel` for Quince Ave pinning Panel to a single week (5/11 or 5/04, whichever Chris prefers). Defer until next Friday meeting unless Ken 5/04 becomes critical.

### Silent skip of out-of-window forceAssignments

**Where:** `scripts/rebalance-schedule.js` ~line 703 (`getForceAssignments`) / ~line 717 (`applyForceAssignments`)

**Problem:** When a `forceAssignments` entry in `config/rebalance-overrides.json` targets a week that falls outside the job's computed station window, the force is silently skipped — no warning, no output. The operator has no signal that their override didn't land.

**Fix:** Emit a warning from `applyForceAssignments` (or a pre-pass over `OVERRIDES.forceAssignments`) that logs `SKIPPED: force {crew} → {jobName} / {station} at {week} is outside window {start}-{end}`. Preferably surfaced in the same `WARNINGS` block as unplaced-hour warnings.

**Why it matters:** Caught during v11 planning (2026-04-24) — three pull-forward forces (Jonathan R5-P1 Eng 5/04, Spencer Liz Stapp Bench + PreFin 5/18) silently no-op'd because the target weeks were outside the planner-derived windows. Only noticed by diffing placements against intent.

**Workaround in the meantime:** Pair any week-pull force with a matching `customWindow` entry on the same job to widen the window.
