# Partial-Station Progress Entry — Design Spec

**Date:** 2026-06-12
**Status:** Approved by Chris 2026-06-12 (decisions D1–D5 below). Build not started.
**Owner system:** HTW production scheduling (Phases 1–3 LIVE on `main` — this is additive; nothing retired gets rebuilt).

## Problem

The Production Load Board's **✅ Stations Complete** column (`dropdown_mm48p4zs`) handles binary station done-ness. Partial progress ("24 of 40 bench hours done", "27 of 55 boxes") still requires Chris hand-editing `jobOverrides[id].remainingHours` in `config/rebalance-overrides.json`. On 2026-06-12 the first real operator override rows were progress reports in disguise ("Bob's BCH bench didn't get done", "16h of Spencer's bench needs to move"); the correct fixes were a `customWindow` change plus a remainingHours decrement (R5-P2 bench 126→102), not override pins. The shop floor (Bob) should report partial progress directly on the board with zero Chris/config involvement.

## Decisions (settled with Chris, 2026-06-12)

| # | Question | Decision |
|---|---|---|
| D1 | Input unit | **Hrs Left** — Bob enters the remaining estimated hours per station directly. Not %-done (mishandles change-order scope growth), not units-done (stations are multi-term formulas; R5-P2 bench is pure CU hours with no units at all), not hours-done (can't express overruns). |
| D2 | Board surface | **Five plain `numbers` columns** on the PLB (one per station), following the board's existing per-station-quintet pattern, plus a dedicated **🔧 Shop Floor** table view for the phone gesture. Not a structured text column (typo-prone, bad phone UX), not subitems (heavy query + 5×27 row maintenance). |
| D3 | Precedence | **board tick → 0** > **board Hrs Left (non-empty) → value verbatim** > **config remainingHours (whole-object, legacy)** > **formula**. Per-station shadowing; config becomes legacy/escape-hatch, still honored where board cells are blank. |
| D4 | Stations Complete interplay | **No auto-tick.** The tick stays a human sign-off (estimates can be wrong in both directions; Hrs Left keeps the schedule realistic in the moment). Hrs Left = 0 without a tick triggers a run-summary nudge. Ready-to-Ship still flips on ticks only — with one safety extension: a station with board Hrs Left > 0 counts as *required* even if its formula is 0, so board-added work can't be skipped by the RTS derivation (prevents premature flips; never causes one). |
| D5 | Lifecycle | Numbers are point-in-time assessments, updated by the shop floor as work progresses (weekly review acceptable to Chris); no automated resets, nothing to do at job completion. One supervised backfill at launch. |

## Semantics

**Hrs Left = the shop floor's current estimate of remaining work at that station, in estimated-work hours.** It is a fresh assessment each time it's edited, not a ledger. Key properties:

- **Empty cell ≠ 0.** Empty (monday `text === ''`) means "no board information" → precedence falls through to config/formula. Explicit `0` means "nothing left" → station contributes 0 hours and the tick-nudge fires.
- **May exceed the formula.** A job running over its estimate is reported by *raising* Hrs Left above the formula's remaining value. Never clamped. Surfaced as an informational line in the run summary (scope-drift visibility for Chris), not an error.
- **Tick wins over Hrs Left.** A ticked station is 0 regardless of the number. Tick + Hrs Left > 0 is a contradiction → warning in the run summary (tick still wins).
- **Stale-high is the safe direction.** If Bob does work but doesn't update the cell, the planner over-schedules that station (conservative). This is why no automated decay/reset exists.
- **Invalid values** (negative; non-numeric is near-impossible on a `numbers` column but guarded anyway) → ignored with a run-summary warning, fall through to the next precedence tier.

## Board changes (Production Load Board, 18407601557)

1. **Five `numbers` columns** — titles `⏳ Eng Hrs Left`, `⏳ Panel Hrs Left`, `⏳ Bench Hrs Left`, `⏳ PreFin Hrs Left`, `⏳ PostFin Hrs Left`. Each description documents: "Shop-floor estimate of remaining hours at this station. Empty = planner uses config/formula. 0 = nothing left (also tick ✅ Stations Complete if truly done). May exceed the formula if the job is running over. Planner reads on every run."
2. **🔧 Shop Floor view** — table view filtered to Production Status ∈ {Not Started, Ready to Schedule, Scheduled, Finishing}; visible columns: Name, ✅ Stations Complete, the five ⏳ Hrs Left columns. This is the 10-second phone surface.
3. Column ids get recorded in `COL_PL` and in the build record when created.

## Code changes

All in the existing files; no new modules.

1. **`scripts/rebalance-schedule.js`**
   - `COL_PL` gains five ids (`hrsLeftEng` … `hrsLeftPostfin`).
   - `loadJobs` parses the five cells: `text === ''` → `null`, else `parseFloat`; emits `hrsLeft: { eng, panel, bench, prefin, postfin }` (values `null` or number) on the job object.
   - `computeRemainingHours(formulaHours, overrideRemaining, stationsComplete, hrsLeft)` — new fourth parameter, default `{}`/null for back-compat. Per station: tick → 0; `hrsLeft[k]` is a valid number ≥ 0 → that value; else existing base logic (config whole-object else formula) unchanged.
2. **`scripts/run-planner.js`** — run-summary warnings (non-blocking, summary-only; no monday notification — consistent with "clean runs are silent", these don't block anything):
   - tick-nudge: `Hrs Left 0 but station not ticked` (per job × station);
   - contradiction: `station ticked but Hrs Left > 0` ;
   - overrun info: `Hrs Left exceeds formula remaining` (informational);
   - invalid value ignored.
3. **`isReadyToShip` required-set extension:** required stations become those with formula > 0 **or** board Hrs Left > 0 (closes the hole where board-added work on a formula-0 station could flip a job Ready-to-Ship while unticked). Ticks remain the only completion signal.
4. **Pin-vs-remaining edge (required test):** a `forceAssignments` pin whose hours exceed the (newly shrunk) station remaining must clamp or surface as a loud conflict — never throw mid-pass-2 (the Phase-2 smoke test showed planner throws are the worst failure mode; the pass-2 guard catches them, but we should not rely on it). First step of the build: investigate what the planner does today in this case; then anchor the chosen behavior (clamp vs conflict) with a test.

## Testing (strict TDD, existing 28-file suite conventions)

- Extend `scripts/test-stations-complete.js` (or sibling new file if cleaner): precedence matrix covering — tick beats Hrs Left beats config beats formula; empty vs 0; overrun (Hrs Left > formula) passes through unclamped; negative/invalid ignored; back-compat (no 4th arg ≡ today's behavior, all existing tests untouched and green).
- `loadJobs` parsing: empty string → null, "0" → 0, decimals, missing column.
- Orchestrator-level (`test-run-planner-orchestrator.js` pattern): warnings appear in summary; Ready-to-Ship never flips from Hrs Left values alone; required-set extension (formula-0 station with Hrs Left > 0 blocks RTS until ticked).
- Pin-vs-remaining test per §Code 3.
- Full suite green before any live run; `DRY_RUN=1 node scripts/run-planner.js --plan` against live boards before any non-dry run. Destructive/negative-path live verification (if any) is Chris-triggered per standing practice.

## Backfill (one-time, supervised)

Copy config per-station remaining values into the new board columns for **active** jobs only (status not Complete). Direct copy — no formula reconciliation needed because Hrs Left *is* remaining. **Config `remainingHours` objects stay in place untouched** (shadowed by the board, harmless): the planner consumes them whole-object (`base[k] || 0`), so deleting individual station keys would silently turn that station's fallback into 0 instead of formula. A job's `remainingHours` is only ever deleted wholesale, at job completion or by Chris's choice — never key-by-key. Current reality to encode: **R5-P2 bench → 102** (of 126; the rest of R5-P2's entries per config), plus the other active jobs' config values (Westridge, McMorris, SciTech, BCH, Atom — exact set confirmed against live statuses at build time, presented as a per-job table for Chris's approval before any board write). BCH's bench **window** pin (6/15–6/19 customWindow) is untouched — windows are out of scope (below). Config edits committed immediately per standing rule.

## Documentation

- `docs/operations-manual.md`: §2.1 gains the partial-progress procedure (the "Partially done is NOT a tick — goes through Chris" note is replaced by the Shop Floor view gesture); §4.2 marks `remainingHours` as legacy/escape-hatch; quick-reference unchanged. Republish the monday copy (doc 18417585088).
- Build record appended to this spec when the feature lands.

## Out of scope

- **Station window slips** (the BCH "bench didn't get done" half of the 6/12 incident) — timing problems stay Chris/override-row territory; the `computeWindows` past-window clamp remains a backlog item. This feature only absorbs the remaining-hours half.
- Units→hours derivation columns, auto-ticking, the intake→Scheduled derivation, override-row schema, Crew Allocation writes. (Ready-to-Ship gets exactly one change — the required-set extension in §Code 3 — nothing else.)
- monday-side automation/validation on the new columns (revisit only if bad entries actually happen).
