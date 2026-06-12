# 📖 HTW Production System — Operations Manual

**Audience:** anyone operating the schedule — Chris, Bob, Jonathan.
**Source of truth:** `docs/operations-manual.md` in the Harris-Tools repo (version-controlled). The monday copy ("📖 HTW Production System — Operations Manual") is republished from it; if they differ, the repo wins.
**Last updated:** 2026-06-12.

---

## 1. What the system does on its own

You mostly *feed it facts*; it does the rest.

| When | What happens automatically |
|---|---|
| Every minute | The planner checks the ▶️ Planner Trigger item. If someone requested a run or deploy, it executes it (~2–4 min). Otherwise: nothing, silently. |
| Every Saturday 6:00 PM | Full planning run — fresh plan, fresh 📊 Capacity View, fresh 📋 Weekly Briefing for Monday morning. Boards are NOT rewritten (plan-only). |
| Daily 6:00 AM | Rollups: Time Off hours, Command Center non-production hours, cross-training audit. |
| Daily 8:15 AM | Manual Overrides board housekeeping: override rows whose week has passed are moved to the Stale group (never-run Pending rows are auto-Cleared). |
| On every planning run | Override rows are validated and stamped Applied/Conflict; jobs with all stations done flip to **Ready to Ship**; new **Ready to Schedule** jobs that got planned flip to **Scheduled**; both output docs regenerate; the trigger item gets a run-summary update. |
| When something needs a human | Chris gets a monday notification: override conflicts, planner errors, doc-write failures, config errors, a skipped Saturday run, or any deploy. Clean runs are silent. |

**Requires:** Chris's machine on and awake. If it's asleep, requests wait at "Run Requested" until it wakes.

---

## 2. Everyday procedures

### 2.1 Mark production progress (anyone, ~10 seconds)

When a station's work on a job is **fully done**:

1. Open the **Production Load Board** → find the job.
2. In **✅ Stations Complete**, tick the station (Eng / Panel / Bench / PreFin / PostFin).

The next planning run zeroes that station's remaining hours. When every station with work is ticked, the job flips itself to **Ready to Ship** (delivery work keeps planning until the truck leaves).

> Partially done ("27 of 55 boxes") is NOT a tick — that goes through Chris (§4.2).

### 2.2 Get a fresh plan + fresh docs (anyone)

1. Open the **🛠️ HTW Manual Overrides** board → **⚙️ Control** group.
2. Set **▶️ Planner Trigger** Status to **Run Requested**.
3. Within a minute it flips to **Running**, then back to **Idle** (~2–4 min total).

Result: validated override rows (Applied/Conflict), regenerated 📊 Capacity View + 📋 Weekly Briefing, and a summary update on the trigger item. **The Crew Allocation board is NOT touched** — this is a preview.

### 2.3 Deploy the schedule to the boards (anyone, but it's the big red button)

Same as 2.2 but set Status to **Deploy Requested**.

The planner runs a fresh plan AND applies it: Crew Allocation subitems are rewritten for every re-planned job, and Finish Drop/Return dates land on the Production Load Board. Chris is notified on every deploy. Safeties that run automatically: invalid finishing cycles block the deploy; jobs the plan didn't re-place keep their existing rows.

**Deploy when:** you changed something that crews need to see on their boards (override applied, station marked done changing this week's work, date moved). **Just Run when:** you only want to preview or refresh the docs.

### 2.4 Move work between crews/weeks — override rows (anyone)

One row = "move N hours of (job × station) from (crew × week) to (crew × week)."

1. **🛠️ HTW Manual Overrides** board → **Active** group → new item.
2. Fill: **Job** (link), **Station**, **Hours**, **To Crew** + **To Week** (destination). For a *move*, also fill **From Crew** + **From Week**; leave From empty for a *pure assign*; leave To empty to *clear* work off a crew.
3. Leave Status = **Pending**. Add a one-line **Reason**.
4. Request a run (2.2) or deploy (2.3).

> ⚠️ **The #1 trap:** "Run Requested" / "Deploy Requested" go on the **▶️ Planner Trigger item only**. Those labels appear as options on override rows too (shared column) — but a row set to anything other than **Pending** is *invisible to the planner*. Row statuses are only ever: Pending (yours) → Applied / Conflict (the planner's).

The run flips the row to **Applied** (it's in the plan — look for 🔧 on the Capacity View) or **Conflict** (reason written into the Conflict Reason column).

**To retry a Conflict:** fix the row, set Status back to **Pending**, request a run.
**Editing an Applied row** flips it back to Pending automatically — re-run to apply the edit.
**Rules the validator enforces:** can't pin past the delivery date, can't exceed capacity without ticking **Allow Over-Cap**, can't move hours that don't exist, can't assign to departed crew, weeks are always Mondays.

### 2.5 Change a delivery date (Chris or Jonathan)

1. Edit **Delivery Date on the Master PM Board** — the ONLY place delivery dates live. (The Production Load Board's delivery column is a mirror; don't fight it.)
2. Request a run/deploy. The planner recomputes all station windows from the new date.

> If production is already in flight and windows land in the past, the run's warnings will say so — that currently needs Chris (config window override).

### 2.6 New job intake (Chris or Jonathan)

1. Create the job on Master PM + Production Load Board as usual (formulas need the box counts / SF / LF inputs; link PLB → Master PM; set delivery date on Master PM).
2. Set PLB **Production Status = Ready to Schedule**.
3. Request a run (preview) then deploy. The planner schedules it and flips it to **Scheduled** automatically.

### 2.7 Job completion

- All production stations ticked → the system flips it to **Ready to Ship** by itself. Leave it there until delivered.
- After the truck delivers: set Production Status = **Complete**. Its Crew Allocation history is preserved; a later cleanup (`clean-stale-subitems`) archives the rows.
- **Don't mark Complete early** — Complete jobs are invisible to the planner, so undelivered work would vanish from planning (this is exactly what Ready to Ship exists to prevent).

### 2.8 Crew time off

Personal PTO → enter on the **Time Off Board** as usual (the 6 AM rollup feeds it to the planner). Shop-wide events (holidays, short weeks) → tell Chris; that's currently a config entry (§4.3).

---

## 3. Reading the outputs

- **📊 HTW Live Capacity View** — rolling 8 weeks. Per week: key dates (📌 finish drop, 🎯 finish return, 🚚 delivery), the crew table (Load = committed/available; 🔴 over cap, 🟡 ≥95%), and the auto-scaffolded priority order. Cell markers: **🔧** = driven by an override row; ***(pinned)*** = config-pinned; ***(sub)*** = subcontractor. The doc is regenerated on every run — **never edit it by hand; your edits will be overwritten.**
- **📋 HTW Weekly Briefing** — single-week printable for the Monday meeting; same shape as one Capacity View week. Renames itself to the briefed week.
- **▶️ Planner Trigger updates** — every run posts a summary (override counts, placements, doc status, deploy counts). This is the run history; scroll it when you wonder "what happened Saturday?"
- **Jobs beyond the 8-week window** (far-future deliveries) exist in the plan but not in the Capacity View — they roll in as their weeks approach.

---

## 4. Chris-only operations

### 4.1 Command line (repo `C:\Users\chris\Harris-Tools`, token auto-loaded by .bats)

```
node scripts/run-planner.js --plan        # what the trigger's Run does
node scripts/run-planner.js --execute     # apply latest plan (refuses plans >24h old; --force overrides)
DRY_RUN=1 node scripts/run-planner.js --plan   # zero mutations anywhere — full preview
node scripts/clean-stale-subitems.js      # archive Complete-job rows (prompts; DRY_RUN=1 to preview)
node scripts/setup-trigger-item.js        # recreate the trigger item if ever lost
```

### 4.2 Config (`config/rebalance-overrides.json`) — commit immediately after every edit

- `jobOverrides[id].remainingHours` — partial-station progress (the "27 of 55 boxes" cases). Board ticks beat config; config beats formulas.
- `jobOverrides[id].customWindow` — force a station's week range (starts must be Mondays).
- `forceAssignments` — pin crew/job/**stations (array!)**/week/hours.
- `crewCapacityOverrides[week][crew]` — reduced hours, holidays, weekend boosts.
- `subcontractors[week]` — virtual-crew pools.
- Every `--plan` lints this file and reports typos/no-op shapes loudly (and notifies on errors).

### 4.3 People changes

Routing chains, start dates (`BOB_START_DATE`), departures (`CREW_END_DATES`) live in `scripts/rebalance-schedule.js` + the cross-training matrix doc — update doc first, then code (or have Claude do both). Departures also get a hard rule.

### 4.4 Infrastructure

- **Token:** `.token` at repo root. If monday revokes it, every poll tick logs `TOKEN AUTH FAILURE` and Task Scheduler history goes red — replace the file's contents, nothing else.
- **Task Scheduler:** `HTW Planner - Poll` (every minute) + `HTW Planner - Saturday` (Sat 6 PM), both S4U. XML exports + rebuild instructions in `task-scheduler/README.md`. **HTW Production Scheduler is retired — do not re-enable.**
- **Logs:** `logs\planner-YYYY-MM-DD.log`; recovery artifacts `logs\capacity-view-*.md` / `weekly-briefing-*.md` (the writers save these before touching any doc).

---

## 5. When something goes wrong

| Symptom | Meaning | Do |
|---|---|---|
| Trigger stuck **Run/Deploy Requested** >5 min | Machine off/asleep | It runs when the machine wakes; or wake it. |
| Trigger shows **Error** | Run failed; previous docs/boards intact | Read the trigger item's latest update + Chris's notification; fix the cause; set **Run Requested** to retry. |
| Status was Running, then Error appeared "by itself" | A run died mid-flight (reboot, crash); the system self-healed the status within a minute | Re-request when ready. |
| Override row Conflict | The validator rejected it; reason is in the Conflict Reason column | Fix the row → Status Pending → re-run. |
| A doc looks half-empty | A doc-write failed mid-replace | The full markdown is saved in `logs\` — re-run, or paste the artifact via monday UI. |
| Numbers look wrong everywhere | Check the trigger updates for config-lint errors; check Stations Complete ticks vs reality | Chris. |

**Never:** hand-edit Crew Allocation subitems for active jobs (a deploy overwrites them — use override rows instead); edit the generated docs; edit PLB window columns (display-only); set non-Monday weeks anywhere; put "Run/Deploy Requested" on an override **row** (trigger item only — a non-Pending row is skipped silently).

---

## 6. Quick reference

| Thing | Where |
|---|---|
| Master PM Board (delivery dates — source of truth) | 9820786641 |
| Production Load Board (job status, formulas, ✅ Stations Complete) | 18407601557 |
| Weekly Crew Allocation (the live schedule) | 18409529791 |
| 🛠️ Manual Overrides (override rows + ▶️ Planner Trigger) | 18413101550 |
| 📊 Live Capacity View | doc 18410103423 |
| 📋 Weekly Briefing | doc 18417309174 |
| Repo / scripts / config / this manual | `C:\Users\chris\Harris-Tools` |
