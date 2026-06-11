# Phase 2 — Manual Overrides System — Build Plan

**Created:** 2026-05-25 (Phase 1 just shipped — branch `claude/beautiful-villani-8d84a8` at commit `d381be4`)
**Status:** Plan approved. Ready for execution.
**Purpose:** version-of-record for the Phase 2 build of the Manual Overrides System. Captures the design decisions and deliverable ordering that came out of the Phase 2 kickoff conversation.

**Phase 1 outcome reminder:** all five spec criteria satisfied — board exists, planner reads it (B1, B4), validation works (B5 + B7-followup, 5 strict checks), schema is proven (B7 smoke matrix), Chris still triggers runs from Claude Code. Live monday has empty Manual Overrides board; iter-11 deployed schedule unchanged.

**Cross-references:**
- Phase 1 plan: `docs/phase-1-manual-overrides-plan.md`
- Original design spec: monday object_id `18410674711` ("🛠️ HTW Manual Overrides System — Design Spec")
- Rolling handoff doc: monday object_id `18410512204`

---

## How to read this doc

1. Section A — **Scope & context**: what Phase 2 delivers, what triggered each decision.
2. Section B — **Design decisions (D1–D7)**: settled by Chris during kickoff conversation 2026-05-25. Each captured with rationale.
3. Section C — **Deliverables (C1–C9)**: ordered task list, with file paths and dependencies.
4. Section D — **Verification approach**: per-task verification policy, building on Phase 1's post-incident no-live-executor rule.
5. Section E — **Out of scope**: what NOT to do in Phase 2 (Phase 3/4/5 items).

---

## Section A — Scope & context

### What Phase 2 delivers

Per the Phase 1 plan doc's Section F + the design spec's "Phase 2 — Outputs" stage:

- **Capacity View doc regenerated automatically each run.** Existing doc at object_id `18410103423` ("📊 HTW Live Capacity View") becomes a derived view of planner output. Rolling 8-week window (current + 7 future).
- **Weekly Briefing doc generated each run.** New doc, single-week shape, for the upcoming week. Captures top notes (deliveries / finish drops / returns), crew table, priority order.
- **🔧 indicator** on Capacity View cells driven by an active override row.
- **Auto-scaffolded priority order** from delivery dates + finishing-cycle events, used by both Capacity View and Weekly Briefing.
- **Drive upload of schedule visuals** (optional C9) — automate the `htw-schedule-latest.html` + `htw-schedule-YYYY-MM-DD.html` artifact upload to the `Production Scheduling > Schedule Visuals` Drive folder.

### Phase 2 end-state (from design spec)

> Outputs flow automatically. `capacity-view-refresh` skill is no longer needed for the daily path.

The skill stays for emergency manual edits but stops being the normal flow. The Capacity View becomes a strict derived view; direct edits get overwritten next run.

### What triggered the design decisions

Live Capacity View doc inspection at kickoff surfaced:

- Doc last refreshed 2026-04-25 (plan v12). Stale by ~30 days.
- 25-block-per-page read limit hit during massive replacements (per 5/2 session log).
- Multiple sections carry "⚠️ v10 rebuild — priority order needs re-authoring" placeholder quotes from prior incomplete refreshes — the existing skill couldn't auto-regenerate priority order, so it inserted placeholders for humans to fill in.

Phase 2's generator removes the placeholder pattern entirely — priority order is auto-scaffolded from delivery dates, no human-in-the-loop required for the initial scaffold (humans can still rewrite at the Monday meeting).

---

## Section B — Design decisions (D1–D7)

All seven settled during the Phase 2 kickoff conversation. Captured here so implementation doesn't relitigate.

### D1. Capacity View update strategy → **(a) Delete-all-blocks-then-add-markdown**

Three options were on the table: (a) delete-all + repopulate, (b) section-by-section replace, (c) create-new-doc-each-run.

**Decision: (a).** Simplest. Brief window where doc is empty is acceptable for an internally-used doc that's not actively consumed mid-write. Avoids the section-tracking complexity of (b). Avoids the doc-proliferation + broken-link issue of (c).

**Implementation note:** add a generation timestamp at the top of the doc so operators see freshness at a glance. If a regeneration fails partway, the existing skill stays usable as a fallback to manually edit.

### D2. Weekly Briefing doc lifecycle → **(a) One doc, overwritten each run**

Spec says "One briefing for the upcoming week; future-week expansion is room-for-later." That reads as a single-doc model.

**Decision: (a).** Use `set_name` to update the doc name each run (e.g., "📋 HTW Weekly Briefing — Week of 2026-06-01" → "📋 HTW Weekly Briefing — Week of 2026-06-08" the following week). Prior briefing content is overwritten; no archive.

Operationally, the Monday meeting consumes the current briefing; older versions aren't useful. If they ever are, Phase 5 polish can add an archive pattern.

### D3. 🔧 indicator placement → **(a) Prefix on the Hrs value**

Three options: (a) prefix on Hrs ("20 🔧"), (b) suffix on Job name, (c) new "Source" column.

**Decision: (a).** Minimal table-shape disruption — the existing 5-column table (Crew/Load/Job/Station/Hrs) keeps its width and headers. The 🔧 lives in the same cell as the number, immediately visible.

### D4. Priority order semantics → **(a) Pure delivery-date sort**

Spec says: "auto-scaffolded from delivery dates by the planner (date-ordered list). Humans rewrite at the meeting if more nuance is needed."

**Decision: (a).** Sort by delivery date ascending. Map 🔴/🟡/🟢 buckets to delivery-date proximity:
- 🔴 HIGHEST: delivery within ≤1 week of the current week being shown
- 🟡 HIGH: delivery within ≤2 weeks
- 🟢 NORMAL: delivery > 2 weeks out

Finish drops + finish returns are surfaced separately in the per-week "key dates" block at the top of each section, not in the priority list.

The auto-scaffold is the starting point. Operators can hand-edit the Weekly Briefing's priority list at the Monday meeting if they want more nuance — that's the design intent.

### D5. Generation timing → **(a) Fire after writeback in --plan**

Spec aligns: "planner becomes the writer." Every --plan run refreshes the outputs.

**Decision: (a).** Outputs (Capacity View, Weekly Briefing) regenerate at the end of --plan, after Pass 2 + override writeback. --execute is unchanged from Phase 1's behavior (writes Crew Allocation subitems + finish dates). Outputs are derived from the saved plan JSON, so --execute doesn't need to regenerate them.

### D6. Generator output format → **(a) Markdown via add_markdown_content**

**Decision: (a).** The existing Capacity View doc shapes (headings, tables, lists, dividers) all map cleanly to markdown. monday's `add_markdown_content` operation converts markdown to blocks at insertion time. No need for fine-grained per-block control.

If a future generator needs more precise styling (e.g., specific colors, parent_block_id nesting for notice_boxes), we'd revisit. For Phase 2's shapes, markdown is sufficient.

### D7. Capacity View doc object_id → **Yes, reuse `18410103423`**

**Decision: yes, keep the existing doc.** Referenced in the rolling handoff doc, the system handoff, and likely bookmarks. Don't break those links.

---

## Section C — Deliverables (C1–C9)

Ordered by dependency. C1 is the leaf dependency; C8 closes the loop. C9 is optional.

| # | Deliverable | File(s) | Depends on | Notes |
|---|---|---|---|---|
| C1 | Priority order auto-scaffold | new `scripts/capacity-view-generator.js` (start small, may split later) | none | Pure function. From active jobs + delivery dates + finish events → 🔴/🟡/🟢-categorized priority list per week. Used by both C2 and C6. |
| C2 | Capacity View per-week section generator | same file or new sibling | C1 | Pure function. Plan + jobs + priorities → one week's markdown (heading + key dates + crew table + priority list). |
| C3 | Capacity View full-doc generator | same | C2 | Pure function. Rolling 8-week window (current + 7 future) of section blocks + header (with generation timestamp + plan version) + legend. |
| C4 | Capacity View writer | new `scripts/write-capacity-view.js` | C3 | Side-effectful. Takes generated markdown + doc object_id 18410103423. Reads all existing block IDs (paginating through all pages), deletes them in batch, then calls `add_markdown_content` to repopulate. |
| C5 | 🔧 override indicator integration | extends C2 + C3 | C4, plus accepted-overrides set from validation results | Annotate cells in the per-week tables that are driven by accepted overrides. Prefix on the Hrs cell value: `"20 🔧"`. |
| C6 | Weekly Briefing generator | new `scripts/weekly-briefing-generator.js` | C1, C2 | Pure function. Single-week shape — leverages C2's per-week section generator. Briefing-specific framing (different doc title, slightly different intro block). |
| C7 | Weekly Briefing writer | new `scripts/write-weekly-briefing.js` | C6 | Side-effectful. Creates the doc on first run; updates name + content on subsequent runs. Uses `set_name` + the same delete-and-repopulate pattern as C4. |
| C8 | Wire into run-planner.js | extend `scripts/run-planner.js` | C4, C7 | After writeback in --plan, call both writers with the final plan + jobs + accepted-overrides. Console output adds a `=== OUTPUTS ===` section showing what was regenerated. |
| C9 *(optional)* | Drive upload for schedule visuals | new `scripts/upload-schedule-visuals.js` | C8 | Automate the `htw-schedule-latest.html` + dated-file upload to Drive folder `1d2U75nioR2-FySF-m_qO7V0or9hh1Hxq` (Production Scheduling > Schedule Visuals). May need OAuth setup; defer if scope grows. |

### Sequencing notes

- **C1–C3 are pure functions, no monday I/O.** TDD with synthetic plan + jobs fixtures. Fast feedback loop.
- **C4 + C7 are the only writers.** Live verification against the existing Capacity View doc (C4) and a new Weekly Briefing doc (C7).
- **C5 is a delta on C2 + C3** — small extension once the core generator is in place.
- **C6 reuses C2** for the per-week section. Briefing-specific wrapper is small.
- **C8 is the final wire-up** — narrow blast radius in run-planner.js.

---

## Section D — Verification approach

### Pure functions (C1, C2, C3, C5, C6)

TDD with synthetic plan JSON + jobs fixtures. New test files for each:
- `scripts/test-priority-order.js` — C1
- `scripts/test-capacity-view-generator.js` — C2, C3, C5
- `scripts/test-weekly-briefing-generator.js` — C6

Same shape as Phase 1 tests (plain Node, no framework, RED → GREEN cycle).

### Writers (C4, C7)

Pure-function tests for the markdown-building portions of each (the part that constructs `add_markdown_content` operations from generator output). Live verification against the actual doc IDs (`18410103423` for Capacity View; the Weekly Briefing's doc created on first run).

**Per the post-incident verification policy** from Phase 1: do not run --execute live during testing. Capacity View / Weekly Briefing writes are doc updates, not Crew Allocation writes — different surface, different risk profile. But still: prefer dry-run patterns where the writer logs what it WOULD write without firing the mutation, then a separate explicit "real run" once the dry-run output looks right.

### Integration (C8)

Live verification: run `node scripts/run-planner.js --plan` against current monday state (override board empty post-Phase-1-cleanup). Verify:
- Console reports `=== OUTPUTS ===` section with Capacity View + Weekly Briefing regeneration confirmations.
- Capacity View doc (object_id 18410103423) is refreshed — generation timestamp at top is today's date, 8 weeks visible, no "v10 rebuild" placeholder quotes.
- Weekly Briefing doc exists and shows the upcoming week's content.
- All 14 Phase 1 test files still pass.

### Smoke matrix re-run (post-C5)

After C5 lands, re-run the 9-row B7 smoke matrix against the new validator (already done in Phase 1) PLUS the new output generators. The 🔧 indicator should appear on cells driven by the 1 Accepted override row (Row 2 — pure clear, which affects placement via crewExclusion). Verify visually on the Capacity View.

Cleanup of those 9 rows happens in the same operator-driven pattern as Phase 1.

---

## Section E — Out of scope for Phase 2

Belongs to Phase 3+:

- ❌ Saturday 6pm auto-run via Windows Task Scheduler (Phase 3)
- ❌ 60s polling for on-demand trigger (Phase 3)
- ❌ Trigger surface on the override board (button or status-driven trigger item) (Phase 3)
- ❌ Notification surface (email / Slack / bell) (Phase 3)
- ❌ Cloud VPS migration (Phase 4)
- ❌ Webhook from monday button to cloud server (Phase 4)
- ❌ Future-week briefings (Phase 5)
- ❌ Better notification surfaces if email is too noisy (Phase 5)

Belongs to Phase 2's Option B follow-up (documented in Phase 1's `## B7-followup results` section):

- ⏸ **Planner permissive for out-of-window forces.** Currently the validator strict-rejects forces outside computed station windows. Phase 2 could revisit if making the planner accept out-of-window forces (extending windows or adding a pinned-placement pass) becomes worth the cascade risk on finishing-cycle math. Deferred until operational need surfaces — no current need.

---

## Section F — Open questions for execution

These don't block design but need answers during the build:

1. **Block-delete pagination strategy for C4.** The existing Capacity View has ~100+ blocks (8 weeks × 12-14 rows per table + headers + lists + dividers). monday's read API paginates at 25 blocks. The writer needs to iterate all pages, collect block IDs, then issue delete operations. Settle: batch deletes in one mutation (with aliases) vs. sequential per-block deletes?
2. **What does "active jobs" mean for the priority scaffold?** The planner's `activeJobs` filter is `['Not Started', 'Scheduled', 'Ready to Schedule', 'Finishing']`. For C1's priority scaffold, use the same filter. Confirm during C1 implementation.
3. **Weekly Briefing doc creation pattern.** On first run, the briefing doc doesn't exist. C7 needs to either: (a) create the doc inline, OR (b) require the operator to create a stub doc once and store its object_id. Lean (a) — automatic creation with a known name pattern. Confirm during C7.
4. **🔧 indicator scope.** Currently scoped to cells driven by accepted overrides on the override board (from validation results). Should it also indicate `forceAssignment` entries in `rebalance-overrides.json` that are still active during the JSON-vs-board coexistence window? Probably no — the JSON forceAssignments are not "manual overrides" in the spec's sense; they're structural config. Confirm during C5.
5. **Phase 1.1 Stage 2 lands inside C5.** Phase 1.1 closed the Applied-row persistence gap (validateAll + translateOverrideRows + run-planner.js filters now accept Pending + Applied — see `docs/phase-1-manual-overrides-plan.md` "## Phase 1.1" section for the lifecycle table). Two deferred items belong to C5's scope: (a) column-edit detection on Applied rows (operator edits Hours/Reason → flip back to Pending; likely a monday native automation, not code), (b) 🔧 indicator stable-vs-stale interaction when an Applied row re-validates to Conflict (the indicator should drop from cells the row used to drive). Confirm both during C5.
6. **monday `add_content_to_doc_from_markdown` per-call block-count limit.** Surfaced during C4 first live regen on 2026-05-25: a 9173-byte markdown that renders to ~720 blocks returned `INTERNAL_SERVER_ERROR` from the `docs-api` service. Manual recovery via splitting at `---` divider boundaries (10 chunks, 14-266 blocks each) succeeded on all sequential calls. C4-followup landed `chunkMarkdownAtDividers` + `addMarkdownToDocChunked` (commit on or near this doc update) as the mitigation. The exact threshold is unknown — empirically somewhere between 266 (passing) and 720 (failing). Phase 5 polish ladder if a single section ever exceeds the limit: (a) recursive sub-section chunking (split at `## ` boundaries within a section); (b) dynamic threshold tuning (probe + measure once per session); (c) parallel chunk inserts with a rate-limit budget (faster regen but harder to fail-gracefully). Defer until a heavy-load week trips the single-chunk case.

---

## Section H — C5–C8 build record (2026-06-10 session)

C5 through C8 landed in one session (commits `b35e481` C5, `c99faf3` C6, `0b858e4` C7, C8 follows). Full suite: 20 test files, 838 checks, green. Live `DRY_RUN=1 node scripts/run-planner.js --plan` verified end-to-end against monday data: two passes, validation (0 rows — board empty), dry writeback, plan + validation persisted, `=== OUTPUTS ===` with Capacity View dry-replace (100 blocks read) and Weekly Briefing would-create.

### Decisions settled during the build

1. **Pure-clear 🔧 semantics (§D smoke note).** A pure-clear row wrenches every final-plan `(job × station)` cell whose crew×week hours-sum differs from the baseline plan — the cells the crewExclusion re-routed work into. Unchanged cells don't wrench. Requires both plans, so derivation runs inside `run-planner.js` and persists as `validation.acceptedTuples`; standalone writer CLIs read that via `tuplesFromPersistedValidation` (to-side-only fallback for pre-C8 files).
2. **F.4 confirmed: no.** JSON `forceAssignments` never wrench — they render *(pinned)* only. Anchored by test (test-derive-override-tuples.js Test 10).
3. **F.5b (stale 🔧) falls out free.** Tuples derive from the current run's accepted set; an Applied row that re-validates to Conflict contributes nothing, so its old cells lose the wrench with zero extra logic.
4. **F.3 confirmed: lean (a).** Briefing doc auto-creates via `create_doc` into workspace 11761515 / Claude Handoffs folder 20251829 (introspection 2026-06-10 confirmed `CreateDocWorkspaceInput.folder_id` exists on API-Version `next`). Identity persists in `config/weekly-briefing-doc.json`; lost state or deleted doc → fresh create (orphan stays for manual cleanup).
5. **Briefing week rule.** Sat/Sun (UTC) → next Monday (the Saturday-6pm scheduled run briefs the upcoming week); Mon–Fri → current week's Monday (mid-week on-demand briefs the week in progress).
6. **Hermetic writers.** `runPlanner` only fires output writers injected via deps; the CLI entry wires the real ones. Unit tests can never accidentally mutate live docs even with a token in env.
7. **Writer failure policy.** Writers independent; CV failure logs loudly (artifact path + recovery options) and the briefing still runs; `runPlanner` doesn't throw — plan/validation files are already saved and writers are re-runnable standalone.

### Latent bug fixed en route

**`forced` field-name mismatch.** The planner emits `forced: true` on pinned placements (rebalance-schedule.js:1091); the generator's pinned detection checked only `p.pinned || p.force` — fixture-only names — so *(pinned)* never rendered from a real plan JSON. Both detection sites fixed; regression tests anchor to the planner's canonical field. Same incident family as the 2026-05-25 `avail` bug; the live dry-run now shows `23 *(pinned)*` on Bob's R5-P2 CU force.

### F.5a — operator recipe (monday native automations, NOT code)

Column-edit detection on Applied rows can't be done in the planner (it only sees board state at run time, not edit events). Create these **custom automations on the Manual Overrides board (18413101550)** in the monday UI — one per input column:

> When **Hours** changes, and only if **Status** is **Applied**, set **Status** to **Pending**

Repeat for: **Job**, **Station**, **From Crew**, **From Week**, **To Crew**, **To Week**, **Allow Over-Cap**. (Skip Reason — it's commentary, not plan input.) Until these exist, the planner still re-validates Applied rows every run (Phase 1.1), so an edited Applied row gets re-checked on the next run anyway — the automations just make the Pending flip visible immediately.

### Adversarial review (2026-06-10, 24-agent multi-lens + skeptic verification)

10 raw findings → 6 confirmed (3 distinct root causes, all fixed same session), 4 refuted:

1. **Fixed (HIGH):** `ensureBriefingDoc` treated ANY resolve error (rate-limit, 5xx, network) as "doc deleted" → would create a duplicate briefing doc and repoint the state file. Now only the deliberate `No doc found for object_id` error falls through to create; transient errors rethrow into the C8 per-writer failure policy.
2. **Fixed (MEDIUM):** C8 + both writer CLIs passed `loadTimeOff()`'s raw shape (`{ personId, from, to, … }`) to generators expecting `{ crew, week, hours }` — PTO-only crews silently vanished from both docs. New `timeOffEntriesFromPlan(plan)` derives entries from the plan's `capacityGrid` `slot.timeOff` (no board-shape knowledge needed); all three call sites switched.
3. **Fixed (LOW):** the CV writer saved its W2 recovery artifact only after the doc reads succeeded, so a read-phase failure left no artifact while the failure message pointed at one. Save-first ordering now (matches the briefing writer); run-planner's failure message reworded to be accurate in all cases.

Refuted (correctly): briefingWeekFor's Mon–Fri current-week semantics (documented decision §H.5), rename-before-replace ordering (D2 single-doc model), board-override cells carrying both 🔧 and *(pinned)* (board rows become forceAssignments — Test 16 anchors the coexistence), and "Section D steps not performed" (live dry-run done; smoke matrix is operator-gated, see below).

### Known cosmetic items (deferred)

- Plan/validation filenames use the UTC date; markdown artifacts use the local date. Around midnight UTC they differ by a day (`rebalance-plan-2026-06-11.json` vs `capacity-view-2026-06-10.md`). Pairing logic is internally consistent (both files the CLI pairs use UTC). Phase 5 polish.
- Same-key placements (e.g. one pinned + one auto-routed for the same job × station × crew × week) render as two table rows. Matches plan JSON reality; merge-display is Phase 5 polish if it bothers anyone.

---

## Section G — Suggested fresh-chat opener for Phase 3 (when Phase 2 lands)

> Resume Phase 3 of the Manual Overrides System build. Read `docs/phase-2-manual-overrides-plan.md` Section E (out-of-scope items) for the Phase 3 deliverable list. State: Phase 2 complete; branch `claude/beautiful-villani-8d84a8` is the active line; Capacity View + Weekly Briefing now regenerate automatically each --plan; `capacity-view-refresh` skill is no longer the daily path.
