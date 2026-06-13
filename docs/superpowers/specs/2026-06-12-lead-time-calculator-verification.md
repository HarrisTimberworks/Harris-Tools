# Lead Time Calculator V2 — Verification Report

**Date:** 2026-06-12 (evening rollout)
**Spec:** `2026-06-12-lead-time-calculator-design.md` · **Plan:** `docs/superpowers/plans/2026-06-12-lead-time-calculator-v2.md`
**Live as of:** main `8dcf442` (code merged at `b440334`, config at `8dcf442`), Quotes group `group_mm49tvn2`.

## 1. Test suite

- 32/32 test files green at the pre-merge gate AND re-gated after integrating the parallel `loadJobs` Hrs-Left change (`4373a28`) — 511 checks total across the quote files (engine 66, hours model 29, trigger 39, lead-times 16; orchestrator grew to 100; existing planner-trigger suite 93 unmodified-then-extended).
- Adversarial final review: 1 BLOCKER (feasibility predicate ignored displacement of committed jobs — fixed with a multiset warnings-diff vs baseline), 2 IMPORTANT (200-row quotes-page guard; lead-times writer failures now notify + appear in run summaries), 9 minors. All fixed in `2b11072`, test-anchored.

## 2. Live verification (performed by Claude, 2026-06-13 00:34–00:36 UTC)

| Row (id) | Input | Result | Verified |
|---|---|---|---|
| TEST earliest (12267876438) | Res - Face Frame, 25 bx, c2 | **Quoted**: Quoted Week 2026-09-07, Capacity Week 2026-07-20 | Both numbers on row; update has floor explanation, station hours, freshness, PM disclaimer; no spurious "(rounded from)" |
| TEST target (12267925762) | same + target 2026-06-29 | **Quoted**: DOES NOT FIT ❌, named blocker "Engineering: 15 hrs could not be placed within window 2026-05-25 → 2026-05-29", earliest-that-fits w/o 2026-07-20, quoted w/o 2026-09-07 | Named bottleneck (not generic shortfall); outcome table behavior |
| TEST invalid (12267865144) | boxes 0 | **Quote Error**: "Boxes must be a number ≥ 1 (got '0')" | Named reason; no dates written; no notification |

- Poll evidence: `logs/planner-2026-06-12.log` — "quotes: 2 processed, 0 healed, 0 deferred, 0 remaining" (row 1 in the prior tick); end-to-end latency ~60–90 s per row.
- Capacity answer (7/20 ≈ 5.5 wks) matches the demand-gap analysis (spec §3: lightly-loaded boards → honest answer 6–9 wks); the policy floor correctly carried the quote to 12 wks (9/7). Launch acceptance: the capacity chain math is hermetically anchored (66 engine checks incl. real-runPlan placement tests); quoted-vs-actual retrospective accumulates in the persistent quote rows.
- Lead-times artifacts: hook fires in the real entry path (`DRY_RUN=1 node scripts/run-planner.js --plan` → "✓ Lead-times artifacts (dry-run)"); standalone writer produced real artifacts — JSON carries only `{label, weeks, quotedWeek}` (Face frame ~13 · Frameless ~13 · Commercial ~11 wks), snippet headline-only. Production `logs/lead-times*.{json,html}` will materialize on the next real planner run.
- Automation audit (read-only, 11 automations on board 18413101550): 3 auto-stale (trigger on **To Week** + overrides-Status) + 8 edited-Applied→Pending (overrides columns + overrides-Status). Quote rows use none of those columns → structurally untouchable. Standing rule (ops manual §2.9): quote rows never set To Week or the overrides Status column.
- Setup caveat that materialized (anticipated in plan Task 10): monday rejected the column-creation `defaults` shapes, so dropdown/status labels were created empty; healed on first write via `create_labels_if_missing` — labels now exist for UI use.

## 3. Remaining steps (Chris)

1. **Delete the 3 TEST QUOTE rows** (💬 Quotes group — trash is recoverable). Left for you per the house rule that row deletions on shared boards are yours.
2. **Create the "Quotes" board view** showing Job Type / Boxes / Complexity / Target Date / Quote Status / Quoted Week / Capacity Week; hide those 7 columns in the Main view.
3. **Destructive verification A — self-heal:** create a quote row → Quote Requested; when it flips to Quoting, kill the node poll process (Task Manager). Expected: row sits at Quoting; within ~5 min a tick flips it to Quote Error with a died-mid-flight update. Recover: flip back to Quote Requested.
4. **Destructive verification B — config-lint notify:** edit `config/quote-policy.json`, set `"preProductionWeeks": "two"` (do NOT commit); create a quote row → Quote Requested. Expected: row stays Requested; you get a lint notification each tick. Restore: `git checkout -- config/quote-policy.json`; the row then quotes normally.
5. **Republish the ops manual monday copy** (doc 18417585088) from `docs/operations-manual.md` — new §1 rows, §2.9, §4.5, §5 rows.

## 4. Policy tuning reminder

`config/quote-policy.json` (commit immediately after every edit): floors at Res 12 / Commercial 10 wks, pre-production 2 wks, finishing-days default 5, reference basket = 25-box FF c2 / 25-box FL c2 / 40-box Commercial c3. Both numbers always shown on every quote — tighten the floors as the boards start carrying the sold pipeline.
