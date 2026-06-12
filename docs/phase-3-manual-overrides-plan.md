# Phase 3 — Manual Overrides System — Build Plan

**Created:** 2026-06-10 (same-day follow-on from Phase 2 completion; branch `claude/beautiful-villani-8d84a8` at `b0cdaa2`)
**Status:** In execution. Operator directive: build + test everything first, register the Task Scheduler tasks ("automations") LAST.
**Spec source:** design spec `18410674711` "Phase 3 — Run automation" + "Run mechanics / Phase 1 — local Task Scheduler"; plan-doc cross-refs `docs/phase-2-manual-overrides-plan.md` §E.

**End-state (spec):** Bob can run the system without Chris. Local Task Scheduler. The delegation goal is met for the first time.

---

## Design decisions (P3-D1…D7)

### P3-D1. Trigger surface → single trigger item on the Manual Overrides board

Spec open question #3 leaned "trigger item for Phase 1 [3], button column when we move to webhooks in Phase 4." Decision: a **⚙️ Control group** on board `18413101550` holding one item, **"▶️ Planner Trigger"**. Bob's entire UX: flip its Status to **Run Requested**. The poller does the rest and flips it back.

- Status column reused (`color_mm3aqx5g`) with four new labels: `Idle` / `Run Requested` / `Running` / `Error` (created via `create_labels_if_missing`). One board for Bob, no new columns polluting override rows.
- Safe by construction: B4's read pipeline only reads the Active group (`topics`), so Control-group items never enter validation.
- IDs persisted to `config/planner-trigger.json` by an idempotent setup script.

### P3-D2. Runner → in-process, not child-process

The poll/scheduled entry point `require`s `run-planner.js`'s `runPlanner` directly with the real writers wired (same wiring as run-planner's own CLI block). Gets the structured result (validation counts, outputs, planError) for summaries/notifications instead of scraping stdout. Console output still lands in the day's log via the .bat redirect.

### P3-D3. Concurrency → lockfile + Task Scheduler policy

`logs/planner.lock` (`{ pid, startedAt }`), acquired by both entry modes; stale after 45 min (a planner run takes ~2-4 min; the CV block-delete pass dominates). Belt-and-suspenders with the task XML's `MultipleInstancesPolicy=IgnoreNew` (rollup precedent). If the lock is held, a poll tick exits quietly WITHOUT claiming the trigger — the request survives for the next tick.

### P3-D4. Notifications → monday `create_notification`, no SMTP

Spec open question #4 defaulted to email "until a real preference shows up." Zero-infra choice: `create_notification(user_id: 77398023, target_id: <trigger item>, target_type: Project, text)` — monday relays to email per Chris's notification prefs. Fires on: `planError`, any Conflict rows, or an output-writer failure. **Silent on clean success** (spec: no spam). Additionally, EVERY run posts an update on the trigger item with the run summary — the board carries its own audit trail.

### P3-D5. Logging → existing rollup .bat convention

`logs/planner-YYYY-MM-DD.log`, append, `>> %LOG% 2>&1`, token loaded from `.token` via the same `for /f` pattern as `run-daily-rollups.bat`.

### P3-D6. Schedule → Saturday 18:00 local + every-1-minute poll

Task Scheduler's floor is 1 minute ≈ spec's 60s. Two tasks: `HTW Planner — Saturday` (weekly Sat 18:00, runs `--scheduled` mode: ignores trigger status, still locks) and `HTW Planner — Poll` (every 1 min, `--poll` mode: gated on Run Requested).

### P3-D7. Deployment home → merge to main BEFORE registering tasks

The Phase 1+2 code lives only on `claude/beautiful-villani-8d84a8`. Production automation must NOT point into a `.claude/worktrees/` path (session-scoped, cleanable). Order of operations honors "automations last": build + test on the branch → merge to `main` → .bats point at `C:\Users\chris\Harris-Tools` → register tasks → final end-to-end trigger test. Main's dirty working files (5/1-era config/script edits, superseded by branch commit `1a49c78`) get stashed with a labeled message, not discarded.

---

## Deliverables

| # | Deliverable | File(s) | Notes |
|---|---|---|---|
| P3.1 | Poll/run/notify logic | `scripts/planner-trigger.js` + `scripts/test-planner-trigger.js` | decideAction, lock acquire/release, buildRunSummary, shouldNotify, runOnce orchestrator — all dep-injected, TDD |
| P3.2 | Trigger surface | `scripts/setup-trigger-item.js`, `config/planner-trigger.json` | Idempotent find-or-create; live |
| P3.3 | .bat wrappers | `run-planner-poll.bat`, `run-planner-saturday.bat` (repo root, rollup convention) | Manual live poll test before registration |
| P3.4 | Merge + registration | `task-scheduler/*.xml` or `schtasks` | LAST. Merge → register → end-to-end test → docs/handoff updates |

## Out of scope (unchanged)

Webhooks + button column (Phase 4), cloud VPS (Phase 4), SMTP email (monday relay suffices), future-week briefings (Phase 5).

**F.5a board automations — DONE (2026-06-11).** 8 edit-detection automations live on board 18413101550 via the monday MCP `create_automation`: "when <input column> changes AND Status is Applied → set Status to Pending", one each for Hours, Job, Station, From Crew, From Week, To Crew, To Week, Allow Over-Cap (Reason deliberately unwatched — commentary, not plan input). Verified live: an Applied row's Hours edit flipped it to Pending within seconds. They coexist with the 3 pre-existing auto-stale automations (To-Week-passed → Stale group). **One cleanup needs the monday UI:** the first From Crew attempt (workflow id 7919565988, created ~09:5x 2026-06-11) came out with an inverted condition ("status is NOT Applied") and the API exposes no workflow delete — remove it in board → Automations (it's the OLDER of the two From Crew entries). Until deleted, its only effect: editing From Crew on a non-Applied row flips it to Pending (harmless on Pending, mildly annoying on Cleared rows).

---

## Operator runbook (Bob / anyone)

**To mark production progress (added 2026-06-11):**

When a station's work on a job is fully done, open the **Production Load Board** and tick that station in the job's **✅ Stations Complete** column (Eng / Panel / Bench / PreFin / PostFin). The next planner run zeroes that station's remaining hours — no config edits, no Chris. When every station with work is ticked, the planner flips the job to **Ready to Ship** automatically (delivery work keeps planning until the delivery date). Partially-done stations stay unticked — Chris handles those via config.

**To request a schedule re-plan:**

1. Open the **🛠️ HTW Manual Overrides** board. Enter/edit override rows in the **Active** group as usual (or change nothing, if you just want fresh docs).
2. In the **⚙️ Control** group, set **▶️ Planner Trigger**'s Status to **Run Requested**.
3. Within ~1 minute the status flips to **Running** (planner working, ~2 min), then back to **Idle**.
4. Read the result: each override row's Status is now **Applied** or **Conflict** (reason in the Conflict Reason column), the **📊 HTW Live Capacity View** and **📋 HTW Weekly Briefing** docs are freshly regenerated, and the trigger item carries an update with the run summary.

**To deploy the schedule to the boards (added 2026-06-12, per Chris):** set the trigger's Status to **Deploy Requested** instead. The planner runs a fresh plan AND applies it — Crew Allocation subitems are rewritten and finish dates land on the Production Load Board. Safeties: the finishing-cycle gate blocks invalid cycles, deletion only touches jobs the new plan re-places, and Chris gets a notification on every deploy.

**Status meanings on the trigger item:** `Idle` ready • `Run Requested` plan + fresh docs only (boards untouched) • `Deploy Requested` plan + APPLY to the boards • `Running` in progress, don't re-request • `Error` the run failed — Chris gets a monday notification automatically; the previous docs/plan stay intact.

**To retry a Conflict row:** fix the row, then flip its Status back to **Pending** and request a run.

**Saturday 6:00 PM:** the planner runs by itself and posts fresh docs for Monday morning. No action needed.

**Limits (Phase 3):** runs happen on Chris's machine while he's logged in (Phase 4 moves this to the cloud). If the trigger sits at Run Requested for more than a few minutes, the machine is off/asleep — it will run when it wakes.

---

## Build record — 2026-06-10/11 (overnight session)

All deliverables landed same-session, registration last per operator directive:

- **P3.1** `planner-trigger.js` (TDD, 56 checks): poll + scheduled modes, status lifecycle, lockfile with stale-steal, run-summary updates, conflict/failure notifications via `create_notification` (silent on clean success).
- **P3.2** trigger surface live: ⚙️ Control group `group_mm47eq7n`, item `12248969189` on board 18413101550; `config/planner-trigger.json` persisted. Idempotent setup script (TDD, 15 checks).
- **P3.3** `.bat` wrappers + `.vbs` hidden-window wrappers, rollup logging convention.
- **Merge:** `claude/beautiful-villani-8d84a8` fast-forwarded into `main` (the production home; Task Scheduler must never point into a `.claude/worktrees/` path). Main's stale 5/1-era local edits preserved in `git stash` ("pre-Phase-2-merge"). Full suite green on main (22 files).
- **Registration:** `HTW Planner - Poll` (every 1 min) + `HTW Planner - Saturday` (Sat 18:00), interactive token (S4U denied without elevation — upgrade path in task-scheduler/README.md), hidden via VBS, XMLs exported to task-scheduler/.
- **Verification:** manual poll no-op (Idle) ✓; manual poll full run ✓ (83s, docs regenerated, summary update posted, Idle restored); **unattended scheduled-task pickup PROVEN** — Run Requested 05:00:36Z → task picked it up 05:01:13Z → Idle 05:02:35Z, 90s run, no human in the loop.

### Adversarial review (2026-06-11, 43-agent, skeptic-verified) — 12 confirmed, 8 refuted, all fixed

1. **Atomic lock (HIGH ×3 lenses).** acquireLock was check-then-write (TOCTOU) — and the poll + Saturday tasks are *separate* tasks (`IgnoreNew` doesn't cross-serialize), so at Sat 18:00 both could double-run the planner, interleaving Capacity View delete/add passes. Now `{ flag: 'wx' }` exclusive create; stale-steal via unlink + single retry; read-based lock-state checks.
2. **Lock ownership (HIGH).** releaseLock unconditionally unlinked — a resumed-from-sleep run could delete a stealer's live lock. Acquire now returns a token; release only removes its own lock.
3. **Stuck-Running self-heal (MEDIUM ×2).** A killed run (logoff/reboot/battery-stop) stranded the trigger at Running forever; poll only acts on Run Requested. Now: Running + absent/stale lock ⇒ flip to Error, post explanation update, notify Chris — heals within a minute.
4. **Failure-path hardening (HIGH+MEDIUM).** The post-run status flip was the only unguarded monday write (failure swallowed the summary AND the notification); the Saturday run could die on a transient status-read or Running-claim failure it doesn't gate on; a lock-skipped Saturday run exited silently. All wrapped: scheduled mode tolerates incidental gql failures, skipped Saturday runs notify Chris, post-run flip failure no longer suppresses the update/notification (and self-heal #3 corrects the status).
5. **setup-trigger-item duplicate guard (MEDIUM).** Transient verify failure no longer recreates the Control group/item — only a successful zero-item query does (briefing-doc bug family).
6. **Summary honesty (LOW).** Unexpected-throw runs no longer claim "previous good state preserved" — that wording is reserved for run-planner's verified pass-2 guard path.
7. **.bat locale fix (MEDIUM).** Log filename now uses `Get-Date -Format yyyy-MM-dd` instead of `%date%` substring parsing (which silently breaks both tasks if Windows regional short-date format changes). Note: the same latent pattern exists in `run-daily-rollups.bat`/`run-scheduler.bat` (pre-existing, out of scope here).

Plus an operational polish from overnight observation: idle poll ticks are fully silent (no log line per minute; `VERBOSE=1` restores), and network-outage ticks log one line instead of a stack trace per minute.
