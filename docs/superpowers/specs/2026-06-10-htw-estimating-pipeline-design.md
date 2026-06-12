# HTW Autonomous Estimating Pipeline — Design

**Date:** 2026-06-10
**Status:** Approved by Chris (design review in session); pending spec review
**Scope:** Architecture for Claude-driven takeoffs feeding the existing proposal machinery, across residential and commercial lines.

## 1. Goal and success criteria

Claude analyzes bid documents, pulls takeoff markups in Bluebeam autonomously, produces the Excel takeoff, passes two estimator review gates, and the existing proposal machinery emits the client-facing DOCX/PDF.

- Reduce estimator involvement per bid by 80–90% — final check and send, not measuring.
- Current volume ~10 bids/month; target capacity ~40+/month (demand already arriving: 10 requests in one week). Strategy is higher pricing/margin with lower win rate, compensated by volume.
- Estimator-minutes per bid is the primary optimization target. Claude compute is cheap; review time is not.

## 2. Decisions made (alignment record)

| # | Decision |
|---|---|
| 1 | Review gates: **both** — visual gate on drawings in Bluebeam, numbers gate in Excel |
| 2 | Sequence: commercial skill is the blueprint → adjust residential chest (exists) → build HTW-C ground-up → refine both line skills together |
| 3 | Pricing: **central factor library** is canonical; tool presets and takeoff Factors tabs are generated/synced from it |
| 4 | On-the-fly tool creation: markup-level improvisation is free; importer intake captures unknown Subjects as provisional library rows; promotion pass blesses them into canon |
| 5 | Finish unit: **1-sided-equivalent SF** (2-sided rate is exactly 2× 1-sided; shelves count twice) |
| 6 | Derived quantities (ends, interiors, loose panels): **Approach C — assembly markers + on-drawing derivation notes + importer expansion engine** |
| 7 | Autonomy: full-pass autonomous including page scale setting, with mandatory dimension verification and flag-don't-guess |
| 8 | Excel takeoff for **both** lines; in-Bluebeam money columns are a live preview only — the xlsx is the bid |
| 9 | Tools carry layer assignments mirroring chest categories, so gate-1 review can toggle one trade at a time |

## 3. Architecture

Per-bid flow: plan set → Claude autonomous takeoff (states = Proposed) → Gate 1 drawing review (Verified/Rejected) → importer + assembly expansion engine → Excel takeoff (locked schema) → Gate 2 numbers review → scope map / narrative / proposal (existing stages, unchanged).

Standing infrastructure: factor library (canonical rates) → sync scripts (tool presets, Factors tabs, tool catalog) → tool catalog JSON (what Claude places markups from) → assembly rulebook (domain rules as versioned code) → intake loop (provisional rows back into the library).

The existing `htw-commercial-proposal` skill keeps stages 1–3 (job folder, scope review, xlsx build) and 5–7 (scope map, narrative, proposal). Stage 4 (human measures in Bluebeam) is replaced by the autonomous takeoff engine. One pipeline serves both lines; they differ only in chests, factor rows, and proposal template.

## 4. Factor library

**Artifact:** `HTW Factor Library.xlsx` in `G:\Shared drives\Harris Timberworks\BlueBeam Templates & Config\`. Master data lives next to the chests and column schema it governs.

**Why xlsx:** every pipeline script reads/writes via the local mount; estimator edits in Excel; existing Excel lockfile discipline applies.

**Schema (Factors tab)** — one row per Subject (the exact-match key used on tools, markups, and Line Items):

| Column | Purpose |
|---|---|
| Subject | Exact-match key |
| Line | R / C / Both |
| Category | CASE, DOOR, TRIM, FIN, ASM, … (mirrors chest structure) |
| Unit | LF, SF, EA, SF-1EQ |
| Raw cost | The factor — raw, no margin (matches existing Factors-tab semantics) |
| Status | active / provisional / retired |
| Source + date | Vendor quote, originating job, when priced |
| Notes | Provenance and assumptions |

**Additional tabs:** `Vendors` (preferred source + default discount multiplier per vendor, e.g. list-price → HTW cost rules), `Changelog`. Dated snapshot copies provide versioning; **every takeoff xlsx stamps the library version that priced it.**

**Governance:** Chris or estimator edits the xlsx → scripted sync regenerates tool presets, Factors tabs, and the tool catalog, and reports preset-vs-library drift. Provisional rows are reviewed/promoted periodically (candidate home: Friday shutdown ritual).

**Commercial deep-dive (explicit implementation phase, flagged by Chris):** harvest all existing rate sources — `example_room_factors.md`, Factors tabs from past commercial takeoff xlsx files, the commercial chest tool roster, `htw_policies.md` — into a candidate table; gap-analyze against the planned HTW-C tool list so every tool has a row; hold a pricing review session where every row is blessed, corrected, or killed before going active. Nothing ships as active without one human review.

**Residential consistency note:** tool Unit Cost presets are raw cost (the ×1.06 ÷0.6 happens in the markup-list columns), so one raw-cost library feeds both lines without translation.

## 5. Tool system changes

Foundation (already live as of 2026-06-10): 6-column money schema in profile and migrated PDFs; ten locked HTW-R chests on the Drive; presets remapped clean; debris generation eliminated.

**Additions:**

1. **ASSEMBLIES chest (`HTW-R 11`, later `HTW-C` twin).** Count-type markers placed at real cabinet/closet locations: `ASM - Finished End (FF Flush)`, `ASM - Finished End (FF FE)`, `ASM - Open Interior`, `ASM - Glass Door Interior`, `ASM - Closet Run`, extensible. Each carries a structured parameter string (e.g. `W36 H84 D24 SH=3`) and sits beside a human-readable derivation note. One marker expands into labor count + computed finish/panel SF lines. Existing FIN/Panels tools remain for real traceable geometry and as the library rows the engine expands into. The fake-rectangle margin-math practice is retired.
2. **Review state model** stamped onto each job PDF: **Proposed → Verified / Rejected**, plus **Needs Pricing** (provisional rates) and **Flagged** (low confidence: scale doubts, ambiguous scope, failed reconciliation).
3. **Tool catalog (JSON), regenerated at every sync.** Per tool: Subject, measurement type, unit, category, color, layer, rate, and parameter spec for ASM tools. Claude places markups exclusively from the catalog so they are identical to estimator-placed tools.
4. **Layer taxonomy.** One layer per chest category plus `TAKEOFF-NOTES` for derivation text. Audit current `/OC(...)` assignments across all 188 tools (known stale, e.g. DRW tools on `INS`), rewrite in one scripted `.btx` pass. Gate-1 review toggles one layer/trade at a time. Layer auto-creation on markup drop must be verified in the pilot (MCP `set_markup_property` requires the layer to exist; tool-carried `/OC` behavior to confirm).
5. **Optional subject grammar pass (Chris to decide during implementation):** append unit suffixes to residential subjects (`DRW - Solid Maple - EA`) to match the commercial `… - LF/SF/EA` convention. Redundant with tool type + library Unit, but human-readable and lets the importer cross-check declared unit vs measurement type.

## 6. Assembly rulebook (domain rules, as dictated by Chris)

Canonical finish unit: **1-sided-equivalent SF**. The finisher's 2-sided rate is exactly 2× the 1-sided rate, so 2-sided surfaces simply count twice.

**Finished interior surface rules:**

| Surface | Area | Sidedness |
|---|---|---|
| Back (interior face) | W × H | 1-sided |
| Sides (interior faces) | 2 × (D × H) | 1-sided |
| Top (underside) | W × D | 1-sided |
| Bottom (top face) | W × D | 1-sided |
| Shelves | count × (W × D) | 2-sided (counts ×2) |

**Shelf-count rules:** base cabinet with top drawer → 1 adjustable shelf; base fully open (no top drawer) → 2 adjustable shelves; uppers → 12–13" maximum spacing, count derived from cabinet height.

**Finished ends:** labor = existing FF FinEnd count factors (Flush vs FF FE variants); finish SF = D × H, 1-sided. **Open question for rulebook coding:** exact FF FE expansion (the legacy tool note `*Add Door Sf` implies the faux frame-and-door end adds door SF) — confirm formula with the estimator before coding.

**Loose panels / closets:** `ASM - Closet Run` marker carries a panel schedule (count × dims) read from elevation + plan; expands to panel material SF + finish SF per sidedness rules. Exact panel/finish interaction to confirm with the estimator during rulebook coding.

**Dimension sourcing:** depth from plan view; width/height from elevations; standards as defaults (base 24"D, uppers 12"D, etc.) with per-cabinet overrides when drawings show custom; shelf counts by the rules above unless the elevation/section shows otherwise.

The rulebook ships as versioned, unit-tested code in the takeoff skill, plus a human-readable reference doc. Estimator corrections at the gates feed rulebook revisions.

## 7. Autonomous takeoff engine (passes)

- **Pass 0 — Sheet routing:** classify pages (plan/elevation/section/detail/schedule); build the plan-tag ↔ elevation-sheet crosswalk; room inventory.
- **Pass 1 — Scale discipline:** set scale from sheet notation, verify by measuring 2–3 printed dimension strings against drawn geometry. Failed or mixed-scale sheets are **Flagged** and never measured. No guessing.
- **Pass 2 — Real geometry:** room by room — case runs by height class (plan LF cross-checked to elevations), door/drawer-front areas, glass, trim LF, counts. Catalog tools, correct layers, state Proposed, comments where judgment was applied.
- **Pass 3 — Assemblies:** detect exposed ends (run terminations not against walls, confirmed in elevation), open/glass interiors (door schedule + elevations), closet runs. Place ASM markers with parameters + derivation notes.
- **Pass 4 — Self-audit:** two-view reconciliation per room (plan vs elevation LF within tolerance; disagreement → Flagged, never averaged); coverage check against the Scope Review (every in-scope room has markups or an explicit "no casework" note); produce the **Takeoff Summary** (coverage, flags with reasons, provisional prices with sources, assumptions).

## 8. Review gates

**Gate 1 — drawings.** Estimator reads the Takeoff Summary (exceptions first), then sweeps layer by layer with the markup list filtered to Proposed, flipping to Verified/Rejected. Fix-in-place then Verify is encouraged. Exit: zero Proposed, all Flags resolved, all provisional prices confirmed.

**Importer (gate enforcement).** Pulls markups directly via the Bluebeam integration (CSV export as fallback). Only Verified markups count; remaining Proposed is a hard warning; Rejected ignored. Assembly markers expand through the rulebook; unknown Subjects route to intake; preset-vs-library drift reported. Output: populated Line Items + gate-2 review sheet (expansion math itemized, provisional prices with sources, knobs to confirm).

**Gate 2 — numbers.** Spot-check expansions, confirm knobs (margin, install %, jurisdiction tax), compare totals to history/gut. Then existing stages 5–7 run unchanged.

## 9. Unknown-product research flow

When plans spec a product with no Subject in catalog/library: Claude researches the price online (exact part number, source URL + date captured), applies Vendors-tab discount rules where known, creates a **provisional** library row, and places the markup with state **Needs Pricing**. Both gates surface provisional items in a dedicated "new pricing this bid" list. Estimator confirms/corrects; post-bid promotion makes it a real tool + active row. Claude never silently invents a price; every researched number carries its receipt.

## 10. Skill packaging

- **New shared skill: autonomous takeoff engine** (passes 0–4, state model stamping, Takeoff Summary). Serves both lines.
- **`htw-commercial-proposal`:** stages 1–3, 5–7 unchanged; stage 4 invokes the engine.
- **Residential proposal skill:** added later on the same engine.
- **Skill scripts:** expansion engine + rulebook, importer, catalog generator, library sync, intake/promotion.
- Project reference docs (`HTW_TOOLSET_TAXONOMY.md`, `MATRIX_SPEC.md`, etc.) updated to match.

## 11. Rollout plan

1. **Factor library v1** — residential rows harvested from tonight's tool presets (nearly free); commercial deep-dive phase with pricing review session (§4).
2. **Residential chest adjustments** — ASM chest, layer taxonomy pass, catalog generator, optional subject suffixes.
3. **Expansion engine + importer + intake** — with a **golden test**: re-run the pipeline against Andrea Dart (1018 Vine St) and reconcile against the human takeoff that priced it ($213,668.07 known-good total).
4. **Takeoff engine pilot** on a live residential bid, full-pass; measure gate-1 correction rate as the quality metric; corrections feed the rulebook.
5. **HTW-C chests ground-up** (born conformant: grammar, units, ASM markers, synced presets) + first commercial pilot bid.
6. **Refine both proposal skills**; ramp toward 40 bids/month.

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Drawing-reading accuracy (misread scope, missed rooms, wrong heights) — **the** risk | Scale verification, two-view reconciliation, coverage checks vs Scope Review, flag-don't-guess, gate 1, golden test, correction-rate metric feeding rulebook |
| Layer auto-creation behavior unverified | Pilot verification item (§5.4) |
| Mixed-scale detail sheets | Flagged for human, never guessed |
| Library edited without sync | Drift tripwire in importer (detect, not prevent) |
| FF FE / closet expansion formulas under-specified | Open questions named in §6; confirm with estimator before coding |
| Positional BSIColumnData fragility | Column schema frozen (2026-06-10); library is canonical so presets are regenerable at any time |

## 13. Out of scope

- Pricing/margin strategy and win-rate management (business decision, feeds Knobs only).
- Bid triage (existing `htw-bid-triage`), Mozaik procurement takeoffs (`htw-takeoff`), post-award tracking (monday.com handoff).
- Residential proposal template design (later phase; engine ships first).
