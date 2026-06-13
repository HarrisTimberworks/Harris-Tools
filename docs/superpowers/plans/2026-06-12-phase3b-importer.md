# Phase 3b: Markup Importer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a list of measured Bluebeam markups into priced takeoff line items — regular measurement tools priced directly, ASM markers run through the expansion engine, unknown subjects captured for intake — honoring the Verified/Proposed/Rejected review gate.

**Architecture:** A pure `estimating/importer.py` taking injected markup dicts + factors + job_config (no Bluebeam access — fully unit-testable). A thin adapter maps the Bluebeam MCP `list_markups_in_pdf` output to those dicts; an xlsx writer emits the line items. The expansion engine (`estimating/expand.py`, 78 tests) plugs in for ASM subjects.

**Tech Stack:** Python 3.14, openpyxl, pytest, stdlib. Extends the tested `estimating/` package (78 tests green).

**Spec:** `docs/superpowers/specs/2026-06-10-htw-estimating-pipeline-design.md` §8 (importer/gate enforcement), §9 (unknown-product intake), §4 (intake loop).

**Markup record contract** (what the adapter produces, what the core consumes):
```
{"subject": str, "measurement": float, "unit": "LF"|"SF"|"EA",
 "params": str (Assembly Params, "" for non-ASM), "status": "Verified"|"Proposed"|"Rejected"}
```
- Regular measurement tool → line item qty = measurement, raw = measurement × factor[subject].
- ASM marker (subject in expand._DISPATCH) → expand_marker(subject, params, ...) × the markup's count (measurement; default 1 for identical-repeat assemblies).
- subject not in factors and not ASM → intake.
- Gate: Rejected skipped; non-Verified warned + excluded when require_verified.

**File structure:**
```
estimating/
  importer.py        # ImportResult, process_markups, write_line_items, intake_rows
tests/estimating/
  test_importer.py
```

---

### Task 0: Core processor

**Files:**
- Create: `estimating/importer.py`
- Create: `tests/estimating/test_importer.py`

- [ ] **Step 1: Write the failing tests**

```python
import pytest
from estimating import importer

FACTORS = {
    "CASE-COMM - Base PLam - LF": 210.0,
    "FF FinEnds - Flush": 35.0,
    "FIN - Stain (1 Sided)": 2.0,
    "DOOR - Slab - Paint Grade": 18.0,
    "Panels - Paint Grade": 9.0,
}
JOB = {"finish_subject": "FIN - Stain (1 Sided)",
       "door_subject": "DOOR - Slab - Paint Grade",
       "panel_subject": "Panels - Paint Grade"}


def _m(subject, measurement, unit, params="", status="Verified"):
    return {"subject": subject, "measurement": measurement, "unit": unit,
            "params": params, "status": status}


def test_regular_measurement_priced_directly():
    r = importer.process_markups(
        [_m("CASE-COMM - Base PLam - LF", 12.5, "LF")], FACTORS, JOB)
    assert len(r.line_items) == 1
    li = r.line_items[0]
    assert li.subject == "CASE-COMM - Base PLam - LF"
    assert li.qty == 12.5
    assert li.raw_total == pytest.approx(2625.0)   # 12.5 * 210
    assert r.intake == [] and r.warnings == []


def test_asm_marker_expands():
    r = importer.process_markups(
        [_m("ASM - Finished End (FF Flush) - EA", 1, "EA", "D=24 H=84")],
        FACTORS, JOB)
    subs = {li.subject for li in r.line_items}
    assert "FF FinEnds - Flush" in subs
    assert "FIN - Stain (1 Sided)" in subs


def test_asm_count_multiplies_expansion():
    one = importer.process_markups(
        [_m("ASM - Finished End (FF Flush) - EA", 1, "EA", "D=24 H=84")],
        FACTORS, JOB)
    three = importer.process_markups(
        [_m("ASM - Finished End (FF Flush) - EA", 3, "EA", "D=24 H=84")],
        FACTORS, JOB)
    assert sum(li.raw_total for li in three.line_items) == pytest.approx(
        sum(li.raw_total for li in one.line_items) * 3)


def test_unknown_subject_goes_to_intake():
    r = importer.process_markups(
        [_m("CUSTOM - Mystery Thing - EA", 2, "EA")], FACTORS, JOB)
    assert r.line_items == []
    assert r.intake == [{"subject": "CUSTOM - Mystery Thing - EA",
                         "measurement": 2, "unit": "EA"}]


def test_rejected_skipped_proposed_warned():
    r = importer.process_markups([
        _m("CASE-COMM - Base PLam - LF", 5, "LF", status="Rejected"),
        _m("CASE-COMM - Base PLam - LF", 7, "LF", status="Proposed"),
    ], FACTORS, JOB)
    assert r.line_items == []                       # rejected skipped, proposed excluded
    assert any("Proposed" in w for w in r.warnings)
    assert not any("Rejected" in w for w in r.warnings)


def test_expand_failure_becomes_warning_not_crash():
    r = importer.process_markups(
        [_m("ASM - Open Interior - EA", 1, "EA", "W=36 H=84 D=24 SH=3")],
        {}, JOB)   # empty factors -> expand KeyError
    assert r.line_items == []
    assert any("Open Interior" in w for w in r.warnings)
```

- [ ] **Step 2: Run to verify fail**

Run: `python -m pytest tests/estimating/test_importer.py -v`
Expected: FAIL (missing module).

- [ ] **Step 3: Implement importer.py**

```python
"""Markup importer: measured Bluebeam markups -> priced takeoff line items.

Pure core (process_markups) takes injected markup dicts + factors +
job_config. ASM subjects route through the expansion engine; regular
measurement tools price as measurement x factor; unknowns -> intake.
Honors the Verified/Proposed/Rejected review gate."""
from dataclasses import dataclass, field, replace

from . import expand
from .expand import LineItem


@dataclass
class ImportResult:
    line_items: list = field(default_factory=list)
    intake: list = field(default_factory=list)      # unknown subjects + measure
    warnings: list = field(default_factory=list)


def process_markups(markups, factors, job, *, require_verified=True):
    res = ImportResult()
    for m in markups:
        subj = m["subject"]
        status = m.get("status", "Verified")
        if status == "Rejected":
            continue
        if require_verified and status != "Verified":
            res.warnings.append(f"unverified ({status}): {subj}")
            continue
        if subj in expand._DISPATCH:
            count = int(m.get("measurement") or 1)
            try:
                items = expand.expand_marker(subj, m.get("params", ""),
                                             factors, job)
            except (KeyError, ValueError) as e:
                res.warnings.append(f"expand failed [{subj}]: {e}")
                continue
            for it in items:
                res.line_items.append(replace(
                    it, qty=round(it.qty * count, 4),
                    raw_total=round(it.raw_total * count, 2)))
        elif subj in factors:
            qty = float(m.get("measurement") or 0)
            rate = float(factors[subj])
            res.line_items.append(LineItem(subj, subj, m.get("unit", "?"),
                                           qty, rate, round(qty * rate, 2)))
        else:
            res.intake.append({"subject": subj,
                               "measurement": m.get("measurement"),
                               "unit": m.get("unit")})
    return res
```

- [ ] **Step 4: Run to verify pass**

Run: `python -m pytest tests/estimating/test_importer.py -v`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add estimating/importer.py tests/estimating/test_importer.py
git commit -m "feat(estimating): markup importer core (price/expand/intake/gate)"
```

---

### Task 1: Intake → provisional library rows

**Files:**
- Modify: `estimating/importer.py`
- Modify: `tests/estimating/test_importer.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_intake_rows_are_provisional_factorrows():
    from estimating import library
    intake = [{"subject": "CUSTOM - New Thing - EA", "measurement": 4,
               "unit": "EA"}]
    rows = importer.intake_rows(intake, line="C", source_date="2026-06-12")
    assert len(rows) == 1
    r = rows[0]
    assert isinstance(r, library.FactorRow)
    assert r.subject == "CUSTOM - New Thing - EA"
    assert r.line == "C"
    assert r.status == "provisional"
    assert r.raw_cost == 0.0
    assert r.unit == "EA"
    assert "intake" in r.source.lower()


def test_intake_dedupes_repeated_subject():
    intake = [{"subject": "X - A - EA", "measurement": 1, "unit": "EA"},
              {"subject": "X - A - EA", "measurement": 2, "unit": "EA"}]
    rows = importer.intake_rows(intake, line="C", source_date="2026-06-12")
    assert len(rows) == 1
```

- [ ] **Step 2: Run to verify fail**

Run: `python -m pytest tests/estimating/test_importer.py -v`
Expected: 2 new FAIL.

- [ ] **Step 3: Implement (append to importer.py)**

```python
def intake_rows(intake, *, line, source_date):
    """Turn unknown-subject intake records into provisional FactorRows
    (raw_cost 0.0, status provisional) for later promotion. Deduped by
    subject."""
    from .library import FactorRow
    seen, rows = set(), []
    for rec in intake:
        s = rec["subject"]
        if s in seen:
            continue
        seen.add(s)
        rows.append(FactorRow(
            subject=s, line=line, category="INTAKE", unit=rec.get("unit") or "EA",
            raw_cost=0.0, status="provisional", source="markup intake",
            source_date=source_date,
            notes="auto-captured from a takeoff markup - needs pricing"))
    return rows
```

- [ ] **Step 4: Run to verify pass**

Run: `python -m pytest tests/estimating/test_importer.py -v`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add estimating/importer.py tests/estimating/test_importer.py
git commit -m "feat(estimating): intake unknown subjects as provisional rows"
```

---

### Task 2: Line-items xlsx writer

**Files:**
- Modify: `estimating/importer.py`
- Modify: `tests/estimating/test_importer.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_write_line_items_xlsx(tmp_path):
    import openpyxl
    r = importer.process_markups(
        [_m("CASE-COMM - Base PLam - LF", 12.5, "LF")], FACTORS, JOB)
    out = tmp_path / "takeoff_lines.xlsx"
    importer.write_line_items(r, out, job=JOB,
                              source="Test Job", source_date="2026-06-12")
    wb = openpyxl.load_workbook(out)
    assert "Line Items" in wb.sheetnames
    ws = wb["Line Items"]
    headers = [c.value for c in ws[1]]
    assert headers == ["Component", "Subject", "Unit", "Qty",
                       "Raw Unit $", "Raw Total $"]
    # data row present + a grand-total in the last row
    vals = [r2[5] for r2 in ws.iter_rows(min_row=2, values_only=True)
            if r2[5] is not None]
    assert 2625.0 in vals


def test_write_includes_intake_and_warnings_sheets(tmp_path):
    import openpyxl
    r = importer.process_markups([
        _m("CUSTOM - Mystery - EA", 2, "EA"),
        _m("CASE-COMM - Base PLam - LF", 1, "LF", status="Proposed"),
    ], FACTORS, JOB)
    out = tmp_path / "t.xlsx"
    importer.write_line_items(r, out, job=JOB, source="J", source_date="d")
    wb = openpyxl.load_workbook(out)
    assert "Intake (needs pricing)" in wb.sheetnames
    assert "Warnings" in wb.sheetnames
```

- [ ] **Step 2: Run to verify fail**

Run: `python -m pytest tests/estimating/test_importer.py -v`
Expected: 2 new FAIL.

- [ ] **Step 3: Implement (append to importer.py)**

```python
def write_line_items(result, out_path, *, job, source, source_date):
    """Write the import result to an xlsx: Line Items (+ grand total),
    Intake, Warnings, and a small Job header."""
    import openpyxl
    from openpyxl.styles import Font
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Line Items"
    ws.append(["Component", "Subject", "Unit", "Qty", "Raw Unit $",
               "Raw Total $"])
    for c in ws[1]:
        c.font = Font(bold=True)
    total = 0.0
    for li in result.line_items:
        ws.append([li.component, li.subject, li.unit, li.qty, li.raw_unit,
                   li.raw_total])
        total += li.raw_total
    ws.append(["", "", "", "", "GRAND TOTAL (raw)", round(total, 2)])
    ws[ws.max_row][4].font = Font(bold=True)
    ws[ws.max_row][5].font = Font(bold=True)

    wi = wb.create_sheet("Intake (needs pricing)")
    wi.append(["Subject", "Measurement", "Unit"])
    for c in wi[1]:
        c.font = Font(bold=True)
    for rec in result.intake:
        wi.append([rec["subject"], rec.get("measurement"), rec.get("unit")])

    ww = wb.create_sheet("Warnings")
    ww.append(["Warning"])
    ww[1][0].font = Font(bold=True)
    for w in result.warnings:
        ww.append([w])

    wj = wb.create_sheet("Job", 0)
    for k, v in [("Source", source), ("Date", source_date),
                 ("Finish", job.get("finish_subject")),
                 ("Door", job.get("door_subject")),
                 ("Panel", job.get("panel_subject"))]:
        wj.append([k, v])
    wb.save(out_path)
```

- [ ] **Step 4: Run the full suite**

Run: `python -m pytest tests/estimating -v`
Expected: all pass (78 prior + 10 importer = 88).

- [ ] **Step 5: Commit**

```bash
git add estimating/importer.py tests/estimating/test_importer.py
git commit -m "feat(estimating): line-items xlsx writer with intake + warnings"
```

---

### Task 3: Bluebeam adapter (thin, documented)

**Files:**
- Modify: `estimating/importer.py`
- Create: `estimating/IMPORTER.md`

- [ ] **Step 1: Add the record-mapping helper (pure, testable)**

```python
_UNIT_BY_TYPE = {
    "Bluebeam.PDF.Annotations.AnnotationMeasurePolylength": "LF",
    "Bluebeam.PDF.Annotations.AnnotationMeasureArea": "SF",
    "Bluebeam.PDF.Annotations.AnnotationMeasureCount": "EA",
    "PolyLine": "LF", "Polygon": "SF", "Count": "EA",
}


def markup_record(raw, *, params_column="Assembly Params",
                  state_column="status"):
    """Map one Bluebeam list_markups_in_pdf entry (a dict of properties +
    custom columns) to the importer's markup-record contract. Tolerant of
    missing fields. `raw` keys are Bluebeam property names."""
    typ = raw.get("type") or raw.get("Type") or ""
    unit = _UNIT_BY_TYPE.get(typ, "?")
    meas = raw.get("measurement") or raw.get("Measurement") or 0
    try:
        meas = float(str(meas).split()[0]) if meas else 0.0
    except (ValueError, IndexError):
        meas = 0.0
    return {"subject": raw.get("subject") or raw.get("Subject") or "",
            "measurement": meas, "unit": unit,
            "params": raw.get(params_column, "") or "",
            "status": raw.get(state_column) or "Verified"}
```

- [ ] **Step 2: Add a test for the mapper**

```python
def test_markup_record_maps_bluebeam_entry():
    raw = {"type": "Polygon", "subject": "CASE-COMM - Base PLam - LF",
           "measurement": "12.5 SF", "Assembly Params": "", "status": "Verified"}
    rec = importer.markup_record(raw)
    assert rec["subject"] == "CASE-COMM - Base PLam - LF"
    assert rec["unit"] == "SF"
    assert rec["measurement"] == 12.5
    assert rec["status"] == "Verified"
```

Run: `python -m pytest tests/estimating -v` → expect 89 passed.

- [ ] **Step 3: Write IMPORTER.md** documenting the end-to-end live flow: (1) measure in Bluebeam with HTW tools + fill Assembly Params on ASM markers + set review states; (2) `list_markups_in_pdf(includeCustomColumns=True)` → list of raw entries; (3) `markup_record` each → `process_markups(records, factors, job)` → `write_line_items(...)`; (4) review Intake + Warnings, promote intake rows via the library. Note this adapter reads through the Bluebeam MCP (live) and so is exercised manually, not in CI.

- [ ] **Step 4: Commit**

```bash
git add estimating/importer.py estimating/IMPORTER.md tests/estimating/test_importer.py
git commit -m "feat(estimating): Bluebeam markup-record adapter + importer docs"
```

- [ ] **Step 5: Update memory** with: importer live (estimating/importer.py — process_markups/intake_rows/write_line_items/markup_record), the markup-record contract, that the live Bluebeam read + xlsx write is the manual adapter layer, and that Phase 4 (autonomous takeoff filling these markups) is next.
