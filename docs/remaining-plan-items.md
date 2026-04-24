# Remaining Plan Items — Planner Improvements TODO

Open items for the rebalance-schedule planner. Add to this list when a behavior gap or improvement surfaces during a plan run.

---

## Open

### Silent skip of out-of-window forceAssignments

**Where:** `scripts/rebalance-schedule.js` ~line 703 (`getForceAssignments`) / ~line 717 (`applyForceAssignments`)

**Problem:** When a `forceAssignments` entry in `config/rebalance-overrides.json` targets a week that falls outside the job's computed station window, the force is silently skipped — no warning, no output. The operator has no signal that their override didn't land.

**Fix:** Emit a warning from `applyForceAssignments` (or a pre-pass over `OVERRIDES.forceAssignments`) that logs `SKIPPED: force {crew} → {jobName} / {station} at {week} is outside window {start}-{end}`. Preferably surfaced in the same `WARNINGS` block as unplaced-hour warnings.

**Why it matters:** Caught during v11 planning (2026-04-24) — three pull-forward forces (Jonathan R5-P1 Eng 5/04, Spencer Liz Stapp Bench + PreFin 5/18) silently no-op'd because the target weeks were outside the planner-derived windows. Only noticed by diffing placements against intent.

**Workaround in the meantime:** Pair any week-pull force with a matching `customWindow` entry on the same job to widen the window.
