# Bluebeam Markup Importer: End-to-End Live Import Flow

## Overview

The markup importer bridges measured Bluebeam markups to the HTW estimating library. The live workflow integrates a manual Bluebeam phase (measure, mark assembly params, set review states) with an automated pricing engine that expands ASM assemblies, prices regular items, and captures unknowns for later library promotion.

## Live Workflow

### Step 1: Measure and Annotate in Bluebeam
1. **Measure** with HTW tools (Polygon/PolyLine/Count annotations).
2. **Fill Assembly Params** on ASM markers (e.g., `W=36 H=84 D=24 SH=3` for an Open Interior, or `P=HxW` for closet panels). Measurement units derive from the marker type.
3. **Set review state** on each markup:
   - **Verified** → included in takeoff.
   - **Proposed** → logged as warning, skipped.
   - **Rejected** → silently skipped.

### Step 2: Extract Markups from PDF
Use Bluebeam MCP:
```python
from estimating import importer
markups = bluebeam_client.list_markups_in_pdf(
    pageNumber=-1,  # all pages
    includeCustomColumns=True
)
# Returns: dict[markupId] -> {type, subject, measurement, Assembly Params, status, ...}
```

### Step 3: Map Raw Entries to Import Records
```python
records = []
for raw in markups.values():
    rec = importer.markup_record(raw)
    # rec = {subject, measurement, unit, params, status}
    records.append(rec)
```

The `markup_record()` function:
- Extracts **type** (Polygon, PolyLine, Count) → **unit** (SF, LF, EA).
- Parses **measurement** (e.g., "12.5 SF" → 12.5).
- Handles both Bluebeam-native and custom-column cases (case-insensitive key lookup).
- Returns contract dict: `{subject, measurement, unit, params, status}`.

### Step 4: Price Markups
```python
from estimating import library
factors = {r.subject: r.raw_cost for r in library.load_factors(LIBRARY_FILE)}
job = {
    "finish_subject": "FIN - Stain (1 Sided)",
    "door_subject": "DOOR - Slab - Paint Grade",
    "panel_subject": "Panels - Paint Grade",
}
result = importer.process_markups(records, factors, job, require_verified=True)
# result = ImportResult(line_items, intake, warnings)
```

**process_markups** logic:
- **Rejected**: skipped silently.
- **Proposed/Unverified**: logged as warning, skipped (if `require_verified=True`).
- **ASM subjects** (e.g., `ASM - Open Interior - EA`): routed through `expand.expand_marker(subj, params, factors, job)`.
  - Expands to component line items (lumber, finish, hardware).
  - Multiplied by markup count.
- **Regular subjects** (e.g., `CASE-COMM - Base PLam - LF`): priced as `measurement × factor`.
- **Unknown subjects**: captured in `intake` (subject, measurement, unit) for later pricing.

### Step 5: Export Review Workbook
```python
importer.write_line_items(result, out_xlsx, job=job,
                          source="<job name>", source_date="2026-06-12")
```

Produces **xlsx** with sheets:
- **Job**: source name, date, finish/door/panel config.
- **Line Items**: component, subject, unit, qty, raw unit price, raw total. Grand total row at bottom.
- **Intake (needs pricing)**: unknown subjects awaiting library promotion.
- **Warnings**: unverified markups, expansion failures.

### Step 6: Promote Intake to Library
Once prices are set, convert intake rows to library FactorRows:
```python
factor_rows = importer.intake_rows(result.intake, line="C",
                                   source_date="2026-06-12")
# Each row: status="provisional", raw_cost=0.0 (awaiting edit)
# Deduped by subject; ready for library.append_rows(factor_rows)
```

## Worked Example

### Example 1: CASE Measurement
**Bluebeam markup:**
- Type: Polygon
- Subject: `CASE-COMM - Base PLam - LF`
- Measurement: `12.5 SF`
- Status: Verified

**Import record:** `{subject: "CASE-COMM - Base PLam - LF", measurement: 12.5, unit: "SF", params: "", status: "Verified"}`

**Pricing (assuming factor $210/LF):**
- Regular subject found in factors.
- Line item: qty=12.5, raw_unit=$210, raw_total=$2,625.

---

### Example 2: ASM Open Interior
**Bluebeam markup:**
- Type: Polygon
- Subject: `ASM - Open Interior - EA`
- Measurement: `1 EA`
- Assembly Params: `W=36 H=84 D=24 SH=3`
- Status: Verified

**Import record:** `{subject: "ASM - Open Interior - EA", measurement: 1, unit: "EA", params: "W=36 H=84 D=24 SH=3", status: "Verified"}`

**Expansion (assumes factors for Lumber, Finish, Hardware):**
1. `expand.expand_marker("ASM - Open Interior - EA", "W=36 H=84 D=24 SH=3", factors, job)`
2. Returns line items for:
   - Lumber (shelves, frame): qty in SF.
   - Finish (paint/stain): qty in SF.
   - Hardware (shelf pins, clips): qty in EA.
3. Each multiplied by markup count (1 in this case).

**Result:** 3–5 line items in the takeoff, one per component.

---

## Testing & Live Boundary

- **Pure core (process_markups, expand_marker, intake_rows)**: fully unit-tested (89 tests, all passing). No external dependencies.
- **Live Bluebeam read** (list_markups_in_pdf) **and library load**: manual adapter layer. Not in CI (requires running Bluebeam and access to live library file).
- **markup_record**: unit-tested; handles type/measurement parsing and case-insensitive Bluebeam keys.

To test the end-to-end flow manually:
1. Open a PDF in Bluebeam with HTW tools enabled.
2. Make a few test markups (ASM + regular measurement).
3. Run the skill or CLI tool that calls `list_markups_in_pdf` → `process_markups` → `write_line_items`.
4. Inspect the output xlsx for correctness.

## File Reference

- **estimating/importer.py**: `markup_record()`, `process_markups()`, `intake_rows()`, `write_line_items()`, ImportResult class.
- **estimating/expand.py**: `expand_marker()` (ASM assembly engine), LineItem class.
- **estimating/library.py**: `load_factors()`, FactorRow class, library I/O.
- **tests/estimating/test_importer.py**: 11 unit tests for the importer core (89 total estimating tests).
