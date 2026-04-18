---
name: friday-shutdown
description: >
  Runs Chris Harris's Friday Shutdown Ritual for Harris Timberworks. Use this skill whenever Chris
  mentions Friday shutdown, weekly planning, plan next week, shutdown ritual, weekly review, end of
  week planning, schedule next week, or anything about reviewing his week and setting up the next one.
  Also trigger when Chris asks to pull his inbox items, review billing/AR status for planning purposes,
  or build out next week's time blocks on his monday.com Command Center board. Even if it's not Friday,
  if Chris wants to run the shutdown ritual or plan an upcoming week, use this skill.
---

# Friday Shutdown Ritual — Harris Timberworks

You are helping Chris Harris, owner of Harris Timberworks LLC (high-end custom cabinet shop in Colorado), run his weekly shutdown ritual. This is the single most important planning session of Chris's week — it's how next week runs smoothly. Treat it with that weight.

Chris has ADHD, so the structure matters. Deep work goes in the morning, admin and calls in the afternoon. Time blocks keep him anchored. The goal is a fully loaded monday.com board with every hour of next week accounted for before he leaves on Friday.

**Session timing:** The shutdown ritual runs Friday 2:00-4:00 PM. A 4:30-5:00 PM alignment meeting follows where Chris meets with Jonathan and Bob to align individual plans into the production schedule.

## Quick Reference — Board IDs and Key Columns

| Board | ID | Purpose |
|-------|-----|---------|
| Owner's Weekly Command Center | 18407211932 | Chris's personal weekly schedule |
| Billing | 18406671577 | Invoice tracking, AR status |
| Master PM Board | 9820786641 | Active jobs, delivery dates, PM assignments, job locations |
| Production Load Board | 18407601557 | Active production jobs, station hours, delivery dates |

**Command Center groups:**
- `group_mm23hmw2` — 📥 Inbox — Captured But Not Scheduled
- `group_mm23d4m9` — 🔥 This Week — Active
- Role/Hat groups: Admin & Finance, Site & Field Work, Business Development, Job Closeout, Production Prep

**Command Center columns:**
- Time Block (`text_mm23w79g`) — text like "Mon 9:00–12:00pm"
- Scheduled Day (`date_mm233znr`) — date
- Role/Hat (`dropdown_mm23rqtk`) — IDs: 1=Production Prep, 2=Site & Field, 3=Business Dev, 4=Job Closeout, 5=Admin, 6=Finance
- Hours (`numeric_mm2gr3mc`) — auto-calculated from Time Block
- Activity Type (`color_mm2gxkcy`) — Production or Non-Production
- Related Job (`board_relation_mm2gg556`) — links to Master PM Board
- Notes / Next Step (`long_text_mm23rjb8`)
- Priority (`color_mm235v8j`)

## The Ritual — 6 Phases

### Phase 1: Pull Data (do all four in parallel)

Fetch these simultaneously:

1. **Inbox items** — Pull all items from the Command Center board in the Inbox group (`group_mm23hmw2`). Use `get_board_items_page` with `includeColumns: true`.

2. **Billing board** — Pull all items from board 18406671577 with columns. Categorize every invoice by status:
   - **OVERDUE**: Status = "Sent" and due date is before today
   - **DUE NEXT WEEK**: Status = "Sent" or "Scheduled" and due date falls within next week
   - **APPROVAL REQUESTED**: Any invoice needing approval
   - **PAID**: Note recently paid invoices as good news
   
   For each overdue/upcoming invoice, check the linked PM Board project via `board_relation_mm22yy19` to determine who the PM is. This determines who makes the AR call — Chris handles his relationships, Jonathan handles his.

3. **Master PM Board scan** — Pull current jobs from board 9820786641 (group: `topics`). For each active job, check:
   - **Delivery Date** (`date_mky9t1jb`): Flag anything within 3 weeks — those get priority scheduling
   - **Job Location** (`location_mktt5dwe`): Needed for field day routing and drive time calculation
   - **PM** (`multiple_person_mm08rwvb`): Determines ownership

4. **Production Load Board scan** — Pull active jobs from board 18407601557 (Active Jobs group). For each job check:
   - **Total Production Hrs** — understand the job's scale
   - **Production Status** — which station it's currently at
   - **Delivery Date** — correlate with Master PM view
   - **Job Subtype** — commercial vs residential vs countertop
   - Flag any jobs where Chris is engineering (Complex complexity jobs with no CU entered yet often need Chris engineering time)

### Phase 2: Analyze and Present

Present findings to Chris in this order:

**📥 Inbox Summary** — List each captured item with its Role/Hat tag and suggested priority:
- 🔴 URGENT: Tied to an install date within 2 weeks, or time-locked appointment
- 🟡 This week: Should be scheduled but has flexibility on which day
- 🔵 Low urgency: Can wait or takes minimal time

For each Inbox item, prompt Chris with the 4-option triage:
- **Schedule** — will set Scheduled Day, Time Block, Role/Hat, Hours, Activity Type → moves to correct Role/Hat group
- **Defer** — stays in Inbox with a "revisit next Friday" note
- **Delegate** — marks for handoff to Jonathan or Bob (will create item in their Command Center once those exist)
- **Delete** — archive, not worth doing

**💰 Billing / AR Summary** — Split into:
- Overdue invoices Chris owns (with amounts, days overdue)
- Overdue invoices Jonathan owns (flag for handoff)
- Invoices due next week (with due dates)
- Recently paid invoices (positive signal)

**📊 PM Board Scan** — Flag:
- Jobs with install/delivery dates within 3 weeks (these drive Monday/Tuesday deep work)
- Any engineering bottlenecks (jobs where Chris is the blocker)
- Jobs needing site measures (from Production Load Board scan or status)

**🏭 Production Load Summary** — One-line summary of:
- How many jobs are in each production status
- Biggest upcoming jobs (>50 hrs) and their delivery dates
- Any jobs Chris needs to engineer this week

### Phase 3: Build the Schedule

**Auto-detect the week.** Calculate next Monday–Friday from today's date. If Chris specifies a different range, use that instead.

**Lay down the scaffolding first.** Before scheduling any project-specific work, place these recurring blocks:

#### Standard Daily Blocks (every day except field days)

| Block | Time | Role/Hat | Activity Type |
|-------|------|----------|---------------|
| 🟢 Startup Ritual | 9:00–9:15am | Admin (5) | Non-Production |
| 🔨 Morning RFI Round | 9:15–9:30am | Production Prep (1) | Non-Production |
| 🔨 Afternoon RFI Round | 1:00–1:30pm | Production Prep (1) | Non-Production |

**Field days skip RFI blocks.** When a site visit is scheduled, omit both RFI rounds for that day.

#### Weekly Recurring Blocks

| Block | Default Day | Time | Role/Hat |
|-------|-------------|------|----------|
| 📋 Weekly sync with Leslie | Monday | 4:00–5:00pm | Admin (5) |
| 📧 Email triage | Daily (at least 1 block) | 30 min, afternoon | Admin (5) |
| 💰 AR Calls | Monday (default, 1 block/week) | 1 hr, afternoon | Finance (6) |
| 📋 Sync with Leslie & Cathryn | Friday (or mid-week) | 30 min | Admin (5) |
| 📋 Shutdown Ritual | Friday | **2:00–4:00pm** | Admin (5) |
| 📋 Production Alignment Meeting | Friday | **4:30–5:00pm** | Admin (5) |

#### Scheduling Priority Order

After scaffolding, fill the remaining blocks in this priority order:

1. **Install-critical production work** — Jobs with install dates within 3 weeks. These get Monday and Tuesday morning deep work blocks (9:30am–12:00pm). Engineering bottlenecks always go first. **Activity Type: Production** (counts against Engineering station capacity). **Related Job: link to Master PM Board.**

2. **Confirmed field visits** — Lock in site measures with drive time. Pull address from PM Board `location_mktt5dwe`, calculate drive from shop (653 W 66th St, Loveland CO 80538). Boulder ≈ 45 min, Fort Collins ≈ 15 min, Denver ≈ 60 min. Always block departure + site time + return. **Activity Type: Non-Production**. **Related Job: link to Master PM Board.**

3. **Job closeouts** — Batch together in afternoon blocks, 1–1.5 hrs each. Activity Type: Non-Production.

4. **Business development** — Estimates, outreach sessions, proposals. Afternoon blocks. Activity Type: Non-Production.

5. **System/process buildout projects** — If Chris has a multi-session project (like a production scheduling buildout), give it substantial time across multiple days. Default to 2-hour morning deep work sessions. Activity Type: Non-Production.

6. **Low-urgency admin** — Photo scheduling, documentation, etc. Short blocks in gaps. Activity Type: Non-Production.

#### AR Call Block Construction

For the AR block, auto-construct the call list from the billing analysis:
- Chris's overdue + due-this-week invoices = his call list (include invoice numbers and amounts in the notes)
- Jonathan's items = a written handoff list (also include in the notes so Chris can hand it to Jonathan)

#### Team Handoff Items

Generate these items automatically each week:
- **"Hand Jonathan written AR list"** — Include in the AR block notes or as a separate 15-min item
- **"Confirm Spencer has everything for [job]"** — For any job with an install date next week or the week after
- **"Confirm Ian's mobilization dates"** — If any punch list/closeout jobs are active

#### Hours Field Auto-Calculation

For each block, calculate Hours from the Time Block text:
- Parse start and end times (e.g., "Mon 9:00–12:00pm" → 3 hours)
- Standard format: "[Day] [Start time]–[End time][am/pm]"
- If start time has no am/pm suffix, inherit from end time
- 15-min increments → 0.25, 30-min → 0.5, 45-min → 0.75
- Round to nearest 0.25

Common time block patterns:
- "9:00–9:15am" → 0.25 hrs
- "9:00–9:30am" → 0.5 hrs
- "9:15–9:30am" → 0.25 hrs
- "1:00–1:30pm" → 0.5 hrs
- "9:30am–12:00pm" → 2.5 hrs
- "4:00–5:00pm" → 1 hr
- "2:00–4:00pm" → 2 hrs

### Phase 4: Present and Iterate

Present the full proposed schedule to Chris, organized by day, with time blocks in chronological order. Use this format:

```
**MONDAY [date] — [Day Theme]**
- `Mon 9:00–9:15am` 🟢 Startup Ritual [0.25 hrs, Non-Production]
- `Mon 9:15–9:30am` 🔨 Morning RFI Round [0.25 hrs, Non-Production]
- `Mon 9:30am–12:00pm` 🪵 **[Job Name] — [Task]** *(context note)* [2.5 hrs, Production, → Master PM Job]
...
```

Show Hours total per day and weekly total. Flag if a day is over-scheduled (>8 hrs committed excluding breaks).

**Always wait for Chris's approval before pushing to monday.com.** He will usually want to make adjustments — move tasks between days, add/remove blocks, shift timing. Iterate until he says it's good.

### Phase 5: Push to monday.com

Once Chris approves:

1. **Archive old items.** Query the This Week Active group directly to get all items currently in `group_mm23d4m9`:
   ```graphql
   query { boards(ids: [18407211932]) { groups(ids: ["group_mm23d4m9"]) { items_page(limit: 100) { items { id name } } } } }
   ```
   Archive ALL items returned in a single batched mutation with aliases.

2. **Archive scheduled inbox items.** Archive the inbox items that Chris confirmed for next week's schedule (not all inbox items — only the ones being scheduled).

3. **Handle delegated items.** For any items Chris chose to delegate, note them in the session output for later action. (Once Jonathan's and Bob's Command Centers exist, these will be auto-created on their boards.)

4. **Create new items.** Use `create_item` for each scheduled block with:
   - `boardId`: 18407211932
   - `groupId`: "group_mm23d4m9"
   - `name`: Task name with emoji prefix
   - `columnValues`: JSON with date, time block, dropdown role, hours, activity type, related job, notes

   Column value format:
   ```json
   {
     "text_mm23w79g": "Mon 9:00–9:15am",
     "date_mm233znr": {"date": "2026-04-20"},
     "dropdown_mm23rqtk": {"ids": [5]},
     "numeric_mm2gr3mc": 0.25,
     "color_mm2gxkcy": {"label": "Non-Production"},
     "board_relation_mm2gg556": {"item_ids": [JOB_ID]},
     "long_text_mm23rjb8": {"text": "Notes here"}
   }
   ```

   Create items in parallel batches by day (8–10 items per batch).

5. **Verify.** After all creates complete, query the This Week Active group one more time to confirm only new items are present.

### Phase 6: Summary

After pushing, give Chris a clean summary:
- Total items created, organized by day count
- Total Production hours vs Non-Production hours for the week
- Key highlights for the week (critical install dates, AR totals, field days)
- Delegated items list (for handoff to Jonathan/Bob)
- Link to the board

## Important Notes

- **Drive time is real time.** Every field visit needs departure + site + return blocks. The shop is always the starting location: 653 W 66th St, Loveland CO 80538.

- **Morning = deep work, Afternoon = admin/calls.** This is an ADHD accommodation. Protect the morning blocks.

- **The shutdown ritual note.** The Friday shutdown ritual item should always include a reminder in its notes about: morning + afternoon RFI blocks daily (except field days), drive time on field days, 4:30 PM alignment meeting with Jonathan and Bob.

- **Don't over-schedule.** Leave some breathing room. If the inbox has 15 items but only 8 fit comfortably, schedule 8 and tell Chris the other 7 stay in the inbox.

- **Real job names.** Every item should use real job names from the PM Board or Production Load Board — never generic placeholders.

- **Activity Type matters.** Production = actual engineering hours on a job that will count against station capacity. Non-Production = everything else (admin, meetings, AR calls, site measures, business dev, system building). Default to Non-Production when in doubt.

- **Role/Hat groups are for energy-zone workflow.** During the week, Chris works from Role/Hat groups when he has a block of specific energy type. Friday session triages Inbox items into these groups via Scheduled Day. This keeps the Inbox the only active capture target during the week.

- **Hours auto-calc is critical** — these Hours values feed the Weekly Crew Allocation Board later to calculate Chris's actual production availability. Be accurate.

- **Chris's base weekly hours = 15.** This is intentional — Chris's capacity is limited by design (business owner with broad responsibilities). The week should not schedule more than 15 hours of Production work for Chris.
