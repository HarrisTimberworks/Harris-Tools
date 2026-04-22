# Harris Timberworks — Production Scheduling System

**Last updated:** 2026-04-22
**Owner:** Chris Harris (chris@harristimberworks.com)
**Purpose:** Single-file handoff doc. Paste this into any new Claude chat to restore full context on the HTW production scheduling system.

---

## 0. How to Use This Doc

**Starting a new session:**
1. Open a new Claude chat
2. Paste this entire doc
3. State what you want to do (e.g. "Bob starts Monday, need to activate him in the system" or "schedule a new job called X")

**When this doc needs updating:**
- After ANY change to the cross-training matrix, routing matrix, or formulas
- After hiring/firing a crew member
- After adding/removing a monday.com board or major column
- After changing automation cadences
- When moving to a new computer

---

## 1. Business Context

- **Company:** Harris Timberworks (HTW)
- **Location:** Loveland, Colorado
- **What they do:** Custom cabinetry and millwork (NOT timber framing). Serves residential + commercial contractors, designers, and design+build firms.
- **Size:** ~$1M revenue, 8 employees
- **Owner:** Chris Harris (works 15 hrs/wk on production, rest on owner/operator tasks)

## 2. Crew Roster

| Name | Monday User ID | Email / Account name | Role | Base Hrs/wk |
|---|---|---|---|---|
| Chris Harris | 77398023 | chris@harristimberworks.com | Owner, Engineering FF | 15 |
| Jonathan Korban | 78941017 | Jonathan Korban | PM, Engineering Commercial/FL | 40 |
| Paisios | 77398083 | paisios@harristimberworks.com | Multi-station, Shop lead | 40 |
| Rob | 102500064 | robert@harristimberworks.com (display: "rob tomb") | Remote PT engineering | as-needed |
| Ian | 99508397 | ian ratcliffe | Shop floor, assembly | 40 |
| Spencer | 97341714 | Vladimir Almgren | Shop floor, FF benchwork | 40 |
| Ken | — (NO monday account) | — | Panel Processing | 40 |
| Bob | 100329892 | Robert Brening | Shop Foreman (starts 2026-05-18) | 40 |

**Display name mapping (used in scripts):**
```
Chris Harris → Chris
Jonathan Korban → Jonathan
paisios@harristimberworks.com → Paisios
rob tomb → Rob
ian ratcliffe → Ian
Vladimir Almgren → Spencer
Robert Brening → Bob
Ken → Ken (no monday account, use text column only)
```

## 3. Cross-Training Matrix

Authoritative. When this changes, update both `validate-cross-training.js` MATRIX object AND `schedule-production-jobs.js` ROUTING object.

| Station | Chris | Jonathan | Paisios | Rob | Ian | Spencer | Ken | Bob |
|---|---|---|---|---|---|---|---|---|
| Engineering | P (FF) | P (FL/Commercial) | S (training) | F | — | — | — | — |
| Panel Processing | — | — | — | — | S | — | **P** | S |
| Benchwork | — | — | S | — | See below | See below | ❌ never | See below |
| Pre Fin Cab Assembly | — | S | S | — | See below | See below | S | See below |
| Post Fin Cab Assembly | — | S | S | — | **P** | See below | S (comm only) | **P** |
| Pack & Ship | — | — | **P** | — | S | — | S | S |
| Delivery | — | S | **P** | — | S | — | S | — |

**Benchwork / Pre Fin Assembly — varies by job subtype:**
- Res - Face Frame: Spencer P, Ian S, Bob S
- Res - Frameless: Ian P, Spencer S, Bob S
- Commercial: Ian P, Spencer S, Bob S
- Countertop/Surface: Ian P, Bob S
- Mixed: Spencer P, Ian S, Bob S

**Legend:** P = Primary (default auto-route), S = Secondary, T = Tertiary, F = Fill (only when Primary out)

**Special rules:**
- **Ken never does Benchwork.** Hard rule.
- **Ken on Post Fin is commercial jobs only.** Not residential.
- **Rob is remote PT, engineering only.** Never schedule for shop-floor stations.
- **Bob is skipped by the scheduler before 2026-05-18.** Set in `BOB_START_DATE` constant.
- **Res-Frameless Engineering has a hierarchy:** Chris P, Paisios S, Jonathan T, Rob F (used only if Chris overloaded)

## 4. Routing Matrix (Scheduler)

The scheduler uses this to auto-assign subitems. Keyed by [Job Subtype][Station] → array of Primary crew names. When multiple Primaries, hours split evenly. Bob filters out pre-5/18.

| Station | Res - Face Frame | Res - Frameless | Commercial | Countertop/Surface | Mixed (→FF) |
|---|---|---|---|---|---|
| Engineering | [Chris] | [Chris] | [Jonathan] | [Jonathan] | [Chris] |
| Panel Processing | [Ken] | [Ken] | [Ken] | [Ken] | [Ken] |
| Benchwork | [Spencer] | [Ian] | [Ian] | [Ian] | [Spencer] |
| Pre Fin Cab Assembly | [Spencer] | [Ian] | [Ian] | [Ian] | [Spencer] |
| Post Fin Cab Assembly | [Ian, Bob] | [Ian, Bob] | [Ian, Bob] | [Ian, Bob] | [Ian, Bob] |
| Pack & Ship | [Paisios] | [Paisios] | [Paisios] | [Paisios] | [Paisios] |
| Delivery | [Paisios] | [Paisios] | [Paisios] | [Paisios] | [Paisios] |

## 5. Monday.com Boards

### Primary Boards

| Board | ID | Purpose |
|---|---|---|
| **Master PM Board** | 9820786641 | Canonical job record. Single source of truth for Delivery Date. |
| **Production Load Board** | 18407601557 | Per-job station hours (via formulas) + scheduling windows |
| **Weekly Crew Allocation** | 18409529791 | 292 parent items (7 crew × ~42 weeks). Parent = person/week. Subitems = scheduled station work. |
| Weekly Crew Allocation SUBITEM board | 18409530171 | Subitem companion to above |
| **Time Off Board** | 18409530322 | Time off requests, rolled up daily |
| **Station Weekly Capacity** | 18407613763 | (Reference, not actively written) |
| **Billing Board** | 18406671577 | AR / invoicing |
| **Shop Floor Tracker** | 18408736759 | (Reference) |

### Command Centers (individual)

| Board | ID | Owner | Purpose |
|---|---|---|---|
| Chris Command Center | 18407211932 | Chris (private) | Non-production work, personal scheduling |
| Jonathan Command Center | 18409239682 | Jonathan (private) | PM work, site measures, estimates |
| Bob Command Center | — (not yet created) | Bob (5/18+) | Shop foreman work |

### Workspace

| | |
|---|---|
| Project Management Workspace | 11761515 |
| Project Management folder | 18016694 |
| Production Load folder | 20101231 |
| CRM Workspace | 11376478 |

## 6. Production Load Board — Column IDs

**Core columns:**
- Production Status: `color_mm26404x` — 6 labels: Not Started, On Hold, Ready to Schedule, Scheduled, Finishing, Complete
- Job Subtype: `color_mm26yes1` — 5 labels: Res - Face Frame, Res - Frameless, Commercial, Countertop/Surface, Mixed
- Master PM Link: `board_relation_mm26mhea` → Master PM Board (9820786641)
- PM: `multiple_person_mm26ryyk`
- Production Notes: `long_text_mm26686j`
- Delivery Date (mirrored from Master PM): `lookup_mm2n4nf4` (pulls from Master PM column `date_mky9t1jb`)
- Promised Delivery Date: `date_mm2eke7c`

**Scope inputs:**
- FF Box Count: `numeric_mm2dxcak`
- FL Box Count: `numeric_mm2dp21z`
- Complexity Score: `color_mm26aj5p` (1-Standard, 2, 3, 4, 5)
- Complexity Multiplier: `numeric_mm26mc7v` (auto from score)
- Inset Doors: `boolean_mm26pg23`
- Inset Multiplier: `numeric_mm26snxn`
- P-Lam: `boolean_mm2f3589`
- Benchwork Multiplier: `numeric_mm2f46zw` (0 if P-Lam, else 1.0)
- Miter Fold LF: `numeric_mm28ab0p`
- Countertop SF: `numeric_mm26vgv8`
- Backsplash LF: `numeric_mm2fynj1`
- PP Override: `numeric_mm26pq37`
- Overhead/Setup: `numeric_mm2dsg3e` (default 3.5)
- Finishing Days: `numeric_mm2hdd1z`

**Calibrated formulas (station hours):**
- Eng Hrs: `formula_mm2dpf4n` — (FF × 0.6) + (FL × 0.4) + (backsplash × 0.005)
- Panel Processing Hrs: `formula_mm2dxy2k` — (FF × 0.38) + (FL × 0.55) + (miter fold × 0.0167)
- Pre Fin Cab Assembly Hrs: `formula_mm2df4w1` — (FF × 1.10 × inset mult) + miter fold only
- Post Fin Cab Assembly Hrs: `formula_mm2d5fmw` — ((FF × 0.45) + (FL × 0.65)) × inset mult
- Benchwork Hrs: `formula_mm2d25dk` — ((FF × 0.3) + (FL × 0.15)) × benchwork mult + (backsplash × 0.05)
- Total Production Hrs: `formula_mm2dpy4v`

**Cabinet unit overrides (if formula wrong):**
- CU Eng Hrs: `numeric_mm2dv9g7`
- CU Panel Hrs: `numeric_mm2dgnx`
- CU Pre Fin Hrs: `numeric_mm2dakxm`
- CU Post Fin Hrs: `numeric_mm2ds37c`
- CU Benchwork Hrs: `numeric_mm2d6da3`

**Complexity multipliers:** 1=0.8, 2=1.0, 3=1.15, 4=1.4, 5=1.75
**Inset multiplier:** checked=1.3, unchecked=1.0
**Benchwork multiplier:** P-Lam checked=0, unchecked=1.0

**Station windows (week-type columns):**
- Design: `week_mm26vytw`
- Engineering: `week_mm26ywqt`
- Panel Processing: `week_mm26h520`
- Benchwork: `week_mm26v34w`
- Pre Fin Cab Assembly: `week_mm26nywp`
- Post Fin Cab Assembly: `week_mm26z8fz`
- Pack & Ship: `week_mm26ykzx` (shared with Delivery — no separate Delivery window)
- Door Order By: `date_mm26f19z`

**Key dates:**
- Finish Drop Date: `date_mm26qqv3`
- Finish Return Date: `date_mm2k17ef`

**Views:**
- Build Vibe: id 250571534
- Job Entry View: id 250596019
- Schedule View: id 252009800 (sorted Delivery Date ASC)

## 7. Weekly Crew Allocation Board — Column IDs

**Parent board (18409529791):**
- Name (e.g., "Chris — Week of 04/27")
- Subitems: `subtasks_mm2kcekz` → subitem board 18409530171
- Person: `multiple_person_mm2kr7ky`
- Week (Monday date): `date_mm2kjth4`
- Base Hours: `numeric_mm2kbvse`
- Overtime Hours: `numeric_mm2knqem`
- Time Off Hours: `numeric_mm2k57x0` ← rollup-time-off.js writes
- Non-Production Hours: `numeric_mm2knj6j` ← rollup-cc-non-production.js writes
- Available Hours formula: `formula_mm2kgmth` = `{Base} + {OT} - {TimeOff} - {NonProd}`
- Allocated Hours: `numeric_mm2k2vfh` (auto-rolled from subitem Hours column)
- Capacity Remaining formula: `formula_mm2kvcfe` = `{Available} - {Allocated}`
- Notes: `long_text_mm2kyf0h`
- Crew Member (Text): `text_mm2mhm0y` ← used for filtering by crew name (all 292 populated)

**Subitem board (18409530171):**
- Name (e.g., "F&B - Westridge Office — Post Fin Cab Assembly")
- Owner (Person): `person`
- Status: `status` (default labels: Working on it / Done / Stuck / Upcoming)
- Date: `date0`
- Station: `dropdown_mm2kex19` — 7 labels (1=Engineering, 2=Panel Processing, 3=Benchwork, 4=Pre Fin Cab Assembly, 5=Post Fin Cab Assembly, 6=Pack & Ship, 7=Delivery)
- Related Job: `board_relation_mm2kchhq` → Master PM Board (NOT Production Load!)
- Hours: `numeric_mm2kv7rq`
- Assigned To (Text): `text_mm2mpjcn` (used for Ken who has no monday account)
- Cross-Train Flag: `color_mm2m34ta` (0=Secondary, 1=Primary, 2=Not Trained, 3=Override OK)

**Views:**
- Current Week: id 252203600 — filter Week=THIS_WEEK, sort Crew Member ASC
- By Person: id 252203608 — sort Crew Member ASC
- By Week: id 252203621 — group by Week, sort Crew Member ASC
- Calendar: id 252274785

## 8. Time Off Board — Column IDs

**Board 18409530322:**
- Person: `multiple_person_mm2kkp12`
- Dates (timeline): `timerange_mm2k10v8`
- Hours Off: `numeric_mm2kkfcj` (used for Partial Day only; full days = 8 hrs/weekday auto)
- Type: `color_mm2kfmtt` — Vacation/Sick/Personal/Holiday/Partial Day
- Status: `color_mm2kt4fv` — Pending/Approved/Denied (rollup only counts Approved)
- Notes: `long_text_mm2kh79g`

## 9. Command Center Column IDs

Both Chris's (18407211932) and Jonathan's (18409239682) CCs share the same schema:

- Hours: `numeric_mm2gr3mc`
- Activity Type: `color_mm2gxkcy` — labels: Production (id 0) / Non-Production (id 1)
- Related Job: `board_relation_mm2gg556` → Master PM Board
- Scheduled Day: `date_mm233znr`
- Role/Hat: `dropdown_mm23rqtk` (Chris's only; different groups/labels)

**Chris's Role/Hat groups:**
- 📥 Inbox
- 🔥 This Week Active
- 📋 Admin & Finance
- 📐 Site & Field Work
- 💼 Business Development
- 🔒 Job Closeout
- 🪵 Engineering

## 10. Automation Scripts

All live at `C:\Users\chris\Harris-Tools\scripts\`. Runtime: Node.js 18+ (currently v24.15.0).

### `rollup-time-off.js` — Daily 6 AM
Reads Time Off entries (Status=Approved), distributes hours across weeks, writes `Time Off Hours` per (crew, week) on Crew Allocation. Full-day types = 8 hrs/weekday. Partial Day uses Hours Off value.

### `rollup-cc-non-production.js` — Daily 6 AM
Reads both Command Centers, sums Hours where Activity Type=Non-Production, writes `Non-Production Hours` per (crew, week) on Crew Allocation.

### `validate-cross-training.js` — Daily 6 AM
Reads every subitem on Crew Allocation, validates (Person + Station) against MATRIX object, sets Cross-Train Flag (Primary/Secondary/Not Trained).

### `schedule-production-jobs.js` — Every 15 min
The big one. For each Production Load job with Status=Ready to Schedule:
1. Calculates all station windows backwards from Delivery Date (via mirror column)
2. Hour-based window scaling: ≤40 hrs = 1 wk, 41-80 = 2 wk, 81-120 = 3 wk, 121+ = 4 wk
3. Writes windows + Finish Drop + Finish Return to Production Load Board
4. Deletes existing subitems tagged to this job's Master PM ID (idempotent)
5. Creates subitems on Crew Allocation, routed via ROUTING matrix by Job Subtype
6. Splits hours: evenly across weeks, then evenly across multi-Primaries
7. Bob filtered out pre-5/18
8. Flips status to Scheduled

**Idempotent:** Safe to re-run. Re-running deletes old subitems and creates fresh.

### `generate-crew-allocation-items.js` — Yearly rollover (NOT automated)
Generates next N weeks of parent items on Crew Allocation board. Update `START_DATE` and `END_DATE` before re-running. **NOT idempotent** — don't run over overlapping ranges.

### Token & API conventions (critical)

Scripts read `MONDAY_API_TOKEN` from env. Batch files load from `.token` file at project root.

**monday.com GraphQL quirks discovered:**
- Formula columns return `text: ""` and `value: null`. **Must use `... on FormulaValue { display_value }`**
- Board relation columns same quirk. **Must use `... on BoardRelationValue { linked_item_ids }`**
- Mirror columns same quirk. **Must use `... on MirrorValue { display_value }`**
- Date EXACT filter in raw GraphQL: `compare_value: ["EXACT", "2026-05-04"]` — note order is EXACT first (opposite of MCP tool docs)
- Status column: you can't modify "default colors" (done_green reserved for is_done=true labels). Adding/deleting labels requires all current labels present in mutation.
- Dropdown column: can only rename ONE label per mutation (multi-label changes error out).

## 11. Task Scheduler Setup

Two Windows Task Scheduler entries:

### `HTW Daily Rollups`
- Trigger: Daily 6:00 AM
- Action: `C:\Users\chris\Harris-Tools\run-daily-rollups.bat`
- Runs 3 rollup scripts sequentially
- Log: `logs/rollup-YYYY-MM-DD.log`

### `HTW Production Scheduler`
- Trigger: Daily 6:00 AM, repeat every 15 min for 1 day
- Action: `C:\Users\chris\Harris-Tools\run-scheduler.bat`
- Runs `schedule-production-jobs.js` once per trigger
- Log: `logs/scheduler-YYYY-MM-DD.log`
- Restart on failure: 5 min / 3 attempts

Both XML exports at `task-scheduler/` in the repo. Re-import: `schtasks /create /xml <file> /tn <task-name>`.

## 12. Repository Structure

```
C:\Users\chris\Harris-Tools\
├── .token (gitignored; monday.com API token, single line, UTF-8 no BOM)
├── .gitignore
├── run-daily-rollups.bat
├── run-scheduler.bat
├── docs/
│   └── cross-training-matrix.md  (authoritative matrix, portable)
├── scripts/
│   ├── generate-crew-allocation-items.js (yearly rollover, NOT idempotent)
│   ├── rollup-time-off.js
│   ├── rollup-cc-non-production.js
│   ├── schedule-production-jobs.js
│   └── validate-cross-training.js
├── task-scheduler/
│   ├── HTW-Daily-Rollups.xml
│   ├── HTW-Production-Scheduler.xml
│   └── README.md
├── lead-time-calculator.html (standalone tool, separate concern)
├── skills/
│   └── chris-friday-shutdown/SKILL.md
└── logs/ (gitignored; Task Scheduler output)
```

**GitHub:** https://github.com/HarrisTimberworks/Harris-Tools

**Migration to new computer:**
1. Install Node.js, Git
2. `git clone https://github.com/HarrisTimberworks/Harris-Tools.git C:\Users\chris\Harris-Tools`
3. Generate fresh monday.com API token, create `.token` file
4. Create empty `logs/` folder
5. Import both Task Scheduler XMLs (adjust path if user dir differs)
6. Test manual run of each batch file

## 13. Key Architectural Decisions (Locked In)

1. **One-pool capacity model.** CC Production hours do NOT reduce Available Hours. Only CC Non-Production does. CC Production flows as Phase 5 subitem allocations.
2. **Master PM Board is the source of truth** for Delivery Date. Production Load Board mirrors it via `lookup_mm2n4nf4`.
3. **Station windows use week-level precision** (Monday-anchored). Not timeline columns.
4. **Panel Processing + Benchwork run concurrently**, both end same week with 1-day cushion.
5. **Finish Drop = business-days-back from Finish Return**, which = Friday of Post Fin first week.
6. **Scheduler is 15-min cadence**, idempotent, runs silently via Task Scheduler.
7. **Ken has no monday.com account.** Assigned To (Text) column on subitems handles him. All other crew use Person column + text column.
8. **P-Lam handling:** Benchwork Multiplier=0 zeros out Benchwork for P-Lam. Finishing Days should be 0 (no finish cycle).
9. **Backsplash scoping:** 0.05 hrs/LF Benchwork + 0.005 hrs/LF Engineering.
10. **Every new job gets scheduled before production starts.** In-flight jobs at system rollout were handled one-time manually (see section 14).
11. **`Ready to Schedule` triggers everything.** Scheduler picks up, calculates windows, creates subitems, flips to `Scheduled`.

## 14. Current System State (snapshot 2026-04-22)

**Production Load Board status distribution:**
- Scheduled: 2 (F&B - Westridge Office, SH-McMorris — both have subitems built)
- Not Started: 11 (9 re-scoped in-flight jobs + 2 scope-blocked: MAG-BCH, MAG-Roster 5)
- Complete: 13 (archived)

**Pending session (tomorrow with Jonathan):** Re-scope the 9 in-flight jobs (MAP - Edge Optics, NC - Cator Ruma, MAG - SciTech, Gilbert, Liz Stapp, SHI - Huntington Hills, F&B - Quince Ave, MAG - Atom Computing, VV - Wrangler Way) to establish remaining work, then build subitems per job.

**Scheduler is live.** Next Ready to Schedule flip triggers full automation.

## 15. Future Priorities

- **Bob onboarding (5/18):** Command Center board + Friday Shutdown skill
- **MAG-BCH and MAG-Roster 5 scope entry**
- **MAP-Edge Optics benchwork verification** (49.9 hrs flagged suspicious for P-Lam job)
- **Native monday.com automations:** Time Off notifications, over-allocation pings, weekly auto-create
- **Phase 6: Manus AI Monday briefing integration** (pulls from Crew Allocation + Master PM for Monday 8am production meeting)
- **Enterprise plan upgrade** (mid-May) for team-shared skills
- **Yearly rollover** (Jan 2027) — run generate-crew-allocation-items.js with new date range

## 16. Troubleshooting

**Scheduler logs "Got 0 jobs ready to schedule. Nothing to do."**
- Normal idle state. Means no jobs currently tagged Ready to Schedule.

**Scheduler warns "no crew allocation row found"**
- The parent item for (crew, week) doesn't exist. Either crew name is mis-mapped, or the week is before 2026-04-20 (earliest generated) or after end of 2026.
- Check: run name mapping against `PERSON_TO_NAME` in scripts.

**Scheduler warns "no Master PM Board link populated"**
- Production Load job has empty `board_relation_mm26mhea`. Fix: populate the Master PM Link column on the Production Load Board item.

**Subitem creation fails with `itemsNotInConnectedBoards`**
- Related Job column on subitem board is connected to Master PM Board only. Must pass Master PM item ID, not Production Load item ID. v2.2+ handles this correctly.

**Formula column shows right value on board but script reads 0**
- Known quirk. Must use `... on FormulaValue { display_value }` fragment in GraphQL query.

**Date filter returns 0 items even though match exists**
- In raw GraphQL, order is `compare_value: ["EXACT", "YYYY-MM-DD"]`. NOT `["YYYY-MM-DD", "EXACT"]`. MCP docs are wrong about this.

**Token exposed in a chat**
- Rotate IMMEDIATELY. monday.com → Developers → My Access Tokens → Regenerate. Edit `.token` file manually (not in chat). Test batch files.

## 17. Delivered Docs (in monday.com Drive folder 18016694)

Created during initial build, for reference:
- Runbook: https://harristimberworks.monday.com/docs/18409641530
- rollup-time-off.js source: https://harristimberworks.monday.com/docs/18409641812
- rollup-cc-non-production.js source: https://harristimberworks.monday.com/docs/18409642834
- validate-cross-training.js source: https://harristimberworks.monday.com/docs/18409643095
- Task Scheduler setup: https://harristimberworks.monday.com/docs/18409643444
- schedule-production-jobs.js v2 (initial): https://harristimberworks.monday.com/docs/18409707300
- schedule-production-jobs.js v2.1 patch (formula display_value): https://harristimberworks.monday.com/docs/18409712003
- schedule-production-jobs.js v2.2 patch (Master PM link): https://harristimberworks.monday.com/docs/18409714261
- schedule-production-jobs.js v2.3 patch (board_relation read): https://harristimberworks.monday.com/docs/18409883641
- schedule-production-jobs.js v2.4 patch (mirror Delivery Date): https://harristimberworks.monday.com/docs/18409896431
- Production Input Reference Guide: https://harristimberworks.monday.com/docs/18407641644
- Lead Time Calculator doc: https://harristimberworks.monday.com/docs/18407644395
- Adjustment & Maintenance Guide: https://harristimberworks.monday.com/docs/18407653609

## 18. Related External Resources

- Lead Time Calculator (live): https://harristimberworks.github.io/Harris-Tools/lead-time-calculator.html
- GitHub repo: https://github.com/HarrisTimberworks/Harris-Tools
- Local repo path: `C:\Users\chris\Harris-Tools\`

---

## 19. Change Log

- **2026-04-22** — System built. Phase 5 (subitem scheduling) shipped and live-tested on F&B - Westridge Office and SH-McMorris (manual backfill).
- Future entries below.

