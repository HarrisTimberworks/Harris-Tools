# Harris Timberworks Production Scheduling System Architecture

## 1. Overview

The Harris Timberworks production scheduling system is a monday.com-based platform that turns raw job data (delivery dates, station hours, crew availability) into a coordinated weekly production plan. It answers one question every week: **who is doing what, on which job, at which station, for how many hours?**

**The problem it solves:**
- Jobs arrive with delivery dates and complexity estimates, but no one view shows whether the shop can actually hit them.
- Crew members each have a different cross-training profile — a plan that ignores who can run which station produces impossible schedules.
- Chris, Jonathan, and (starting 5/18) Bob each plan their own week, but those plans must reconcile into a single production schedule without a 2-hour Monday meeting.
- Station load vs. capacity is invisible until something slips. The system surfaces over-capacity stations before the week starts.

The output is a fully loaded weekly plan — every hour of every crew member accounted for — available before Monday's 8:00 AM production meeting, already aligned across the three planners.

## 2. Cross-Training Matrix

| Team Member | Primary Stations | Secondary Stations | Restrictions | Default Hrs/Wk |
|---|---|---|---|---|
| **Chris** | Engineering | — | Owner — limited capacity by design | 15 |
| **Jonathan** | Engineering | Pre Fin Assembly, Post Fin Assembly, Delivery | — | 35 |
| **Paisios** | Engineering, Post Fin Assembly, Pack & Ship, Delivery | Benchwork, Pre Fin Assembly | — | 40 |
| **Rob** | — | Engineering (remote only) | Part-time; called in when Engineering capacity is overloaded | as-needed |
| **Ian** | Benchwork, Pre Fin Assembly, Post Fin Assembly | Pack & Ship, Delivery | — | 40 |
| **Spencer** | Benchwork, Pre Fin Assembly | Post Fin Assembly | — | 40 |
| **Ken** | Panel Processing | Pre Fin Assembly, Post Fin Assembly, Pack & Ship, Delivery | Post Fin Assembly **commercial only**; NOT trained on Benchwork | 40 |
| **Bob** *(starts 5/18)* | Benchwork, Pre Fin Assembly, Post Fin Assembly | Panel Processing, Pack & Ship | — | 40 |

**Priority rules when scheduling:**
- Prefer a person's **primary** station before assigning a **secondary**.
- Rob is only available for remote Engineering work, as-needed when Engineering is overloaded.
- Ken cannot be assigned to Benchwork under any circumstance.
- Ken on Post Fin Assembly requires the job subtype = Commercial.

## 3. Board Architecture

Eight boards in total — four exist today, four are new builds.

| # | Board | Status | Purpose |
|---|---|---|---|
| 1 | Production Load Board | Existing | Job inputs and per-station hour calculations |
| 2 | Station Weekly Capacity Board | Existing | Capacity vs. load by station, by week |
| 3 | Master PM Board | Existing | Job ownership (PM), delivery dates, job locations |
| 4 | Chris's Command Center | Existing (being enhanced) | Chris's personal weekly plan |
| 5 | Jonathan Command Center | **New** | Jonathan's personal weekly plan |
| 6 | Bob Command Center | **New** (activate 5/18) | Bob's personal weekly plan |
| 7 | Weekly Crew Allocation Board | **New** | Central hub — who's on which job/station each week |
| 8 | Time Off Board | **New** | Full and partial day time off, feeds crew allocation |
| 9 | Weekly Production Snapshot Dashboard | **New** | Visual summary of the week |

**Data flow:**

```
Production Load Board ──┐
Master PM Board ────────┼──► Weekly Crew Allocation Board ──► Station Weekly Capacity Board
Time Off Board ─────────┤              ▲
Command Centers ────────┘              │
        (Chris, Jonathan, Bob)         │
                                       └──► Weekly Production Snapshot Dashboard
```

The Weekly Crew Allocation Board is the integration point. Every other board either feeds it (load, PM, time off, command centers) or reads from it (capacity, snapshot).

## 4. The Friday Planning Workflow

| Time | Activity | Who | Where |
|---|---|---|---|
| 2:00 – 4:00 PM | Individual planning sessions | Chris, Jonathan, Bob (each separately) | Their own Command Center — Claude skill or manual |
| 4:00 – 4:30 PM | Auto-suggest runs | System | Weekly Crew Allocation Board |
| 4:30 – 5:00 PM | In-person alignment meeting | Chris + Jonathan + Bob | Conference room — resolve conflicts |
| Sunday evening | Monday briefing doc generated | Manus AI | Email / Drive |
| Monday 8:00 AM | Production meeting | Full crew | Pre-aligned plan, not fresh planning |

The key architectural decision: **individual planning happens in parallel, then auto-suggest proposes a reconciliation, then humans resolve the remaining conflicts.** This is faster than any sequential workflow and produces better plans than pure automation.

## 5. Auto-Suggest Scheduling Logic

The auto-suggest engine runs between individual planning and the alignment meeting. It takes all three planners' intents plus job load and produces a proposed crew allocation.

**Priority order:**

1. **Same-job continuity** — If Ian did Benchwork on Job A last week, keep him on Job A for Pre Fin this week. Context ownership compounds — the person who milled the parts knows the quirks.
2. **Primary station first** — Assign primary-station people before falling back to secondary.
3. **Fewest context switches** — Minimize the number of distinct jobs per person per week. Three 13-hr blocks on three jobs beats six 6-hr blocks on six jobs.
4. **Commercial-only restriction for Ken on Post Fin Assembly** — Enforced as a hard constraint.
5. **Respect time off and non-production hours** — Subtract Time Off Board entries and Non-Production blocks from Command Centers before allocating.
6. **Flag stations over 100% capacity** — Don't silently over-allocate. Surface the overflow so the alignment meeting can decide (overtime, delivery slip, or subcontract).

Output is a proposed allocation with explanations — not a final assignment. The 4:30 meeting ratifies or edits.

## 6. Concurrent Station Handling

Some stations run in parallel on the same job. Most notably: **Panel Processing** and **Benchwork** can both happen at the same time on the same job because they operate on different material streams (sheet goods vs. solid stock).

**Rules:**
- A job that has both panel hours and benchwork hours posts those hours to **both** station load calculations for the week — not split, not sequenced.
- Both people can be active simultaneously on the same job ID in the Weekly Crew Allocation Board.
- The Station Weekly Capacity Board receives the hours independently per station.

```
Job A (delivery 5/30):
  Panel Processing: 22 hrs ──► Ken, Week of 5/12
  Benchwork:        18 hrs ──► Spencer, Week of 5/12  (same week, both running)
```

This prevents artificial serialization that would push delivery dates out.

## 7. Station Window Auto-Calculation

Station windows work **backwards from the delivery date**. The system walks the station sequence in reverse, sizing each window by that station's calculated hours for the job.

**Key rule: skip any station with zero calculated hours.**

Examples:
- **P-Lam job** → Panel Processing and Assembly have hours, Finishing has 0. Window skips Finishing entirely; Pack & Ship comes straight after Assembly.
- **Countertop-only job** → Benchwork, Panel Processing, and Assembly all 0. Window is effectively Engineering → Finishing → Pack & Ship → Delivery.
- **Standard cabinet job** → Every station has hours, full sequence runs.

This auto-calculation means the Schedule View on the Production Load Board shows a realistic path, not a generic template that needs manual pruning.

## 8. Outstanding Items to Build

Prioritized roadmap. Later phases depend on earlier ones.

### Phase 1 — Command Center enhancements *(mostly done)*
Chris's Command Center is largely in place. Remaining polish on hours auto-calc and delegation items.

### Phase 2 — Production Load Board enhancements
- **Schedule View** — station-window timeline per job
- **Finishing Days field** — explicit finishing duration input
- **Schedule this Job button** — one-click push of station windows to the calendar

### Phase 3 — Jonathan Command Center
Clone Chris's board structure, adapt for Jonathan's stations and PM portfolio.

### Phase 4 — Weekly Crew Allocation Board and Time Off Board
Build the central hub. Time Off Board built alongside since allocation depends on it.

### Phase 5 — Auto-suggest logic
Implement the priority-ordered scheduler described in Section 5. Runs 4:00–4:30 PM Friday.

### Phase 6 — Manus AI Monday briefing integration
Sunday evening job that reads the aligned allocation and produces the Monday 8:00 AM briefing doc.

### Phase 7 — Bob Command Center *(activate 5/18)*
Clone template once Bob starts. Wire into auto-suggest.

### Phase 8 — Enterprise plan upgrade for team-shared skills
Current Claude plan is per-seat. Enterprise enables shared skills so Jonathan and Bob can run planning sessions without separate subscriptions.

---

**Shop address (reference for field/drive-time calcs):** 653 W 66th St, Loveland CO 80538
