# Phase 1: Factor Library Infrastructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the canonical factor library (xlsx) plus the scripts that harvest it from the residential tool chests, detect drift, sync presets back into chests, and generate the machine-readable tool catalog.

**Architecture:** A Python package `estimating/` in the Harris-Tools repo. `btx.py` wraps the proven .btx format knowledge (XML, zlib-hex Title/Raw, 6-slot BSIColumnData). `library.py` owns the xlsx schema. Four thin commands (`harvest`, `drift`, `sync`, `catalog`) compose the two. All file-touching code is unit-tested against synthetic fixture chests — never the live Drive files — and the live runs are explicit manual verification steps at the end.

**Tech Stack:** Python 3.14 (already on the machine), `openpyxl` for xlsx, `pytest` for tests, stdlib `xml.etree`/`zlib`/`re`/`json` for .btx work.

**Spec:** `docs/superpowers/specs/2026-06-10-htw-estimating-pipeline-design.md` (§4 library, §5.3 catalog, §11 phase 1)

**Domain background for the engineer (read first):**
- A `.btx` tool set is XML: root `<BluebeamRevuToolSet Version="1">`, child `<Title>` = lowercase hex of zlib-compressed display name, then `<ToolChestItem>` elements. Each item's `<Raw>` is hex(zlib(PDF annotation dict)) containing `/Subj(...)` (the tool's identity) and `/BSIColumnData[(v0)(v1)...(vN)]` (positional custom-column values). In the current 6-column schema: slot 0 = Unit Cost (raw \$), slot 1 = Engineering Multiplier, slot 2 = Margin Divider, slots 3–5 = formula columns (always empty).
- The ten live chests are `HTW-R 01 CASE & FF.btx` … `HTW-R 10 SPECIALTY & MISC.btx` in `G:\Shared drives\Harris Timberworks\BlueBeam Templates & Config\HTW Estimating Tool Chest & Custom Columns\`. **Never modify these without the verify-then-write pattern shown in Task 6, and never touch `HTW - Cabinet Takeoff.btx` (legacy fallback).**
- "Subject" strings are the exact-match key joining tools ↔ library rows ↔ takeoff line items. Treat them as opaque identifiers: never trim, case-fold, or normalize.

**File structure:**

```
estimating/
  __init__.py        # empty
  btx.py             # ToolSet/Tool dataclasses, read_toolset, write_toolset, preset get/set
  library.py         # FactorRow dataclass, create_library, load_factors, append_changelog, validate
  harvest.py         # chests -> seed library rows
  drift.py           # library vs chests comparison report
  sync.py            # library -> chest preset rewrite (with verification)
  catalog.py         # chests + library -> tool_catalog.json
tests/estimating/
  conftest.py        # fixture chest builder (synthetic .btx files)
  test_btx.py
  test_library.py
  test_harvest.py
  test_drift.py
  test_sync.py
  test_catalog.py
```

---

### Task 0: Scaffolding and dependencies

**Files:**
- Create: `estimating/__init__.py` (empty)
- Create: `tests/estimating/__init__.py` (empty)

- [ ] **Step 1: Install dependencies**

Run: `pip install openpyxl pytest`
Expected: both install (or already satisfied). Verify: `python -c "import openpyxl, pytest; print('ok')"` prints `ok`.

- [ ] **Step 2: Create package directories and empty `__init__.py` files**

```powershell
New-Item -ItemType Directory -Force C:\Users\chris\Harris-Tools\estimating | Out-Null
New-Item -ItemType Directory -Force C:\Users\chris\Harris-Tools\tests\estimating | Out-Null
New-Item -ItemType File C:\Users\chris\Harris-Tools\estimating\__init__.py
New-Item -ItemType File C:\Users\chris\Harris-Tools\tests\estimating\__init__.py
```

- [ ] **Step 3: Commit**

```bash
git add estimating tests/estimating
git commit -m "feat(estimating): scaffold package for factor library infrastructure"
```

---

### Task 1: Fixture chest builder (test infrastructure)

**Files:**
- Create: `tests/estimating/conftest.py`

The fixture builds synthetic `.btx` files in the exact live format, so every later test runs against realistic data without touching the Drive.

- [ ] **Step 1: Write conftest with the chest builder fixture**

```python
import xml.etree.ElementTree as ET
import zlib

import pytest

TYPE_MAP = {
    "LF": "Bluebeam.PDF.Annotations.AnnotationMeasurePolylength",
    "SF": "Bluebeam.PDF.Annotations.AnnotationMeasureArea",
    "EA": "Bluebeam.PDF.Annotations.AnnotationMeasureCount",
}


def _raw_dict(subject, uc, em="1.06", md="0.60", layer=None):
    oc = f"/OC({layer})" if layer else ""
    cols = f"({uc})({em})({md})()()()" if uc is not None else "()()()()()()"
    return (
        f"<</Subject 1/Vertices[0 0 1 1]/IC[0 0.5 1]"
        f"/Subj({subject})/BSIColumnData[{cols}]{oc}/Subtype/Polygon>>"
    )


@pytest.fixture
def make_chest(tmp_path):
    """Build a synthetic .btx. tools = list of dicts:
    {subject, unit('LF'|'SF'|'EA'), uc('12.34' or None), layer(optional)}"""

    def _make(name, tools):
        root = ET.Element("BluebeamRevuToolSet", {"Version": "1"})
        title = ET.SubElement(root, "Title")
        title.text = zlib.compress(name.encode("utf-8")).hex()
        for t in tools:
            item = ET.SubElement(root, "ToolChestItem", {"Version": "1"})
            res = ET.SubElement(item, "Resources")
            ET.SubElement(res, "ID").text = "FIXTUREID"
            ET.SubElement(res, "Data").text = "00"
            ET.SubElement(item, "Name").text = "FIXTURENAME"
            ET.SubElement(item, "Type").text = TYPE_MAP[t["unit"]]
            raw = _raw_dict(t["subject"], t.get("uc"), layer=t.get("layer"))
            ET.SubElement(item, "Raw").text = zlib.compress(
                raw.encode("latin-1")).hex()
            ET.SubElement(item, "X").text = "0"
            ET.SubElement(item, "Y").text = "0"
            ET.SubElement(item, "Index").text = "2"
            ET.SubElement(item, "Mode").text = "properties"
        path = tmp_path / f"{name}.btx"
        xml_bytes = ET.tostring(root, encoding="utf-8", xml_declaration=True)
        path.write_bytes(b"\xef\xbb\xbf" + xml_bytes)
        return path

    return _make
```

- [ ] **Step 2: Smoke-check the fixture imports**

Run: `python -m pytest tests/estimating --collect-only -q`
Expected: `no tests ran` with no import errors.

- [ ] **Step 3: Commit**

```bash
git add tests/estimating/conftest.py
git commit -m "test(estimating): synthetic .btx chest fixture"
```

---

### Task 2: btx module — read tool sets

**Files:**
- Create: `estimating/btx.py`
- Create: `tests/estimating/test_btx.py`

- [ ] **Step 1: Write the failing tests**

```python
from estimating import btx


def test_read_toolset_parses_title_and_tools(make_chest):
    p = make_chest("HTW-R 01 CASE & FF", [
        {"subject": "CASE - Test - SF", "unit": "SF", "uc": "26.94"},
        {"subject": "DRW - Test - EA", "unit": "EA", "uc": "125.00",
         "layer": "INS"},
    ])
    ts = btx.read_toolset(p)
    assert ts.title == "HTW-R 01 CASE & FF"
    assert [t.subject for t in ts.tools] == ["CASE - Test - SF",
                                             "DRW - Test - EA"]
    assert ts.tools[0].unit == "SF"
    assert ts.tools[1].unit == "EA"
    assert ts.tools[1].layer == "INS"
    assert ts.tools[0].layer is None


def test_presets_read_from_six_slot_array(make_chest):
    p = make_chest("X", [{"subject": "A", "unit": "LF", "uc": "13.20"}])
    t = btx.read_toolset(p).tools[0]
    assert t.preset_unit_cost == "13.20"


def test_empty_preset_reads_as_none(make_chest):
    p = make_chest("X", [{"subject": "A", "unit": "LF", "uc": None}])
    assert btx.read_toolset(p).tools[0].preset_unit_cost is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/estimating/test_btx.py -v`
Expected: FAIL — `ModuleNotFoundError` / `AttributeError` on `btx.read_toolset`.

- [ ] **Step 3: Write the implementation**

```python
"""Read/write Bluebeam .btx tool sets (current 6-column HTW schema)."""
import re
import xml.etree.ElementTree as ET
import zlib
from dataclasses import dataclass, field

SUBJ_RE = re.compile(r'/Subj\(((?:[^()\\]|\\.)*)\)')
COL_RE = re.compile(r'/BSIColumnData\[((?:\((?:[^()\\]|\\.)*\))*)\]')
TOKEN_RE = re.compile(r'\((?:[^()\\]|\\.)*\)')
OC_RE = re.compile(r'/OC\(((?:[^()\\]|\\.)*)\)')

UNIT_BY_TYPE = {
    "Bluebeam.PDF.Annotations.AnnotationMeasurePolylength": "LF",
    "Bluebeam.PDF.Annotations.AnnotationMeasureArea": "SF",
    "Bluebeam.PDF.Annotations.AnnotationMeasureCount": "EA",
}


def _unescape(s):
    return s.replace("\\(", "(").replace("\\)", ")")


@dataclass
class Tool:
    subject: str
    unit: str           # LF | SF | EA
    raw: str            # decoded annotation dict (latin-1 text)
    element: ET.Element = field(repr=False)
    layer: str | None = None
    col_tokens: list[str] = field(default_factory=list)  # incl. parens

    @property
    def preset_unit_cost(self):
        if not self.col_tokens:
            return None
        v = self.col_tokens[0][1:-1]
        return _unescape(v) if v else None


@dataclass
class ToolSet:
    title: str
    path: str
    tools: list[Tool]
    _tree: ET.ElementTree = field(repr=False)


def _decode_hexzlib(text):
    return zlib.decompress(bytes.fromhex(text)).decode("latin-1")


def read_toolset(path) -> ToolSet:
    tree = ET.parse(path)
    root = tree.getroot()
    title = zlib.decompress(
        bytes.fromhex(root.findtext("Title"))).decode("utf-8")
    tools = []
    for item in root.findall("ToolChestItem"):
        raw = _decode_hexzlib(item.findtext("Raw"))
        subj_m = SUBJ_RE.search(raw)
        col_m = COL_RE.search(raw)
        oc_m = OC_RE.search(raw)
        tools.append(Tool(
            subject=_unescape(subj_m.group(1)) if subj_m else "(no subject)",
            unit=UNIT_BY_TYPE.get(item.findtext("Type"), "?"),
            raw=raw,
            element=item,
            layer=_unescape(oc_m.group(1)) if oc_m else None,
            col_tokens=TOKEN_RE.findall(col_m.group(1)) if col_m else [],
        ))
    return ToolSet(title=title, path=str(path), tools=tools, _tree=tree)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/estimating/test_btx.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add estimating/btx.py tests/estimating/test_btx.py
git commit -m "feat(estimating): btx reader with subject/unit/layer/preset access"
```

---

### Task 3: btx module — write preset changes back

**Files:**
- Modify: `estimating/btx.py` (append functions)
- Modify: `tests/estimating/test_btx.py` (append tests)

- [ ] **Step 1: Write the failing tests (append to test_btx.py)**

```python
def test_set_preset_and_write_roundtrip(make_chest, tmp_path):
    p = make_chest("X", [{"subject": "A", "unit": "LF", "uc": "10.00"},
                         {"subject": "B", "unit": "EA", "uc": "5.00"}])
    ts = btx.read_toolset(p)
    btx.set_preset_unit_cost(ts.tools[0], "12.50")
    out = tmp_path / "out.btx"
    btx.write_toolset(ts, out)
    ts2 = btx.read_toolset(out)
    assert ts2.tools[0].preset_unit_cost == "12.50"
    assert ts2.tools[1].preset_unit_cost == "5.00"   # untouched
    assert ts2.title == "X"
    assert ts2.tools[0].subject == "A"


def test_set_preset_refuses_non_six_slot_array(make_chest):
    p = make_chest("X", [{"subject": "A", "unit": "LF", "uc": "10.00"}])
    ts = btx.read_toolset(p)
    ts.tools[0].col_tokens = ["()"] * 20   # simulate legacy 20-slot tool
    try:
        btx.set_preset_unit_cost(ts.tools[0], "1.00")
        assert False, "expected ValueError"
    except ValueError:
        pass
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `python -m pytest tests/estimating/test_btx.py -v`
Expected: first 3 pass, 2 new FAIL with `AttributeError: ... set_preset_unit_cost`.

- [ ] **Step 3: Append the implementation to btx.py**

```python
def set_preset_unit_cost(tool: Tool, value: str):
    """Rewrite slot 0 (Unit Cost) of the 6-slot array in tool.raw + element."""
    if len(tool.col_tokens) != 6:
        raise ValueError(
            f"{tool.subject}: expected 6-slot BSIColumnData, "
            f"found {len(tool.col_tokens)} — refusing (legacy-schema tool?)")
    tool.col_tokens[0] = f"({value})"
    new_block = "/BSIColumnData[" + "".join(tool.col_tokens) + "]"
    tool.raw = COL_RE.sub(lambda m: new_block, tool.raw, count=1)
    tool.element.find("Raw").text = zlib.compress(
        tool.raw.encode("latin-1")).hex()


def write_toolset(ts: ToolSet, path):
    xml_bytes = ET.tostring(ts._tree.getroot(), encoding="utf-8",
                            xml_declaration=True)
    with open(path, "wb") as f:
        f.write(b"\xef\xbb\xbf" + xml_bytes)
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `python -m pytest tests/estimating/test_btx.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add estimating/btx.py tests/estimating/test_btx.py
git commit -m "feat(estimating): btx preset writer with legacy-schema guard"
```

---

### Task 4: library module — the factor library xlsx

**Files:**
- Create: `estimating/library.py`
- Create: `tests/estimating/test_library.py`

- [ ] **Step 1: Write the failing tests**

```python
import pytest
from estimating import library


def test_create_then_load_roundtrip(tmp_path):
    p = tmp_path / "lib.xlsx"
    library.create_library(p)
    rows = [
        library.FactorRow(subject="DRW - Solid Maple", line="R",
                          category="CASE & FF", unit="EA",
                          raw_cost=125.00, status="active",
                          source="tool preset harvest",
                          source_date="2026-06-10", notes=""),
    ]
    library.write_factors(p, rows)
    loaded = library.load_factors(p)
    assert len(loaded) == 1
    assert loaded[0].subject == "DRW - Solid Maple"
    assert loaded[0].raw_cost == 125.00
    assert loaded[0].status == "active"


def test_validate_rejects_duplicate_subjects(tmp_path):
    rows = [
        library.FactorRow("A", "R", "X", "EA", 1.0, "active", "", "", ""),
        library.FactorRow("A", "C", "Y", "LF", 2.0, "active", "", "", ""),
    ]
    with pytest.raises(ValueError, match="duplicate"):
        library.validate(rows)


def test_validate_rejects_bad_status():
    rows = [library.FactorRow("A", "R", "X", "EA", 1.0, "maybe", "", "", "")]
    with pytest.raises(ValueError, match="status"):
        library.validate(rows)


def test_changelog_appends(tmp_path):
    p = tmp_path / "lib.xlsx"
    library.create_library(p)
    library.append_changelog(p, version="v1", author="test",
                             change="seeded", date="2026-06-10")
    assert library.latest_version(p) == "v1"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/estimating/test_library.py -v`
Expected: FAIL on missing module/attributes.

- [ ] **Step 3: Write the implementation**

```python
"""HTW Factor Library xlsx: canonical Subject-keyed raw-cost rates."""
from dataclasses import dataclass, astuple

import openpyxl

FACTOR_HEADERS = ["Subject", "Line", "Category", "Unit", "Raw Cost",
                  "Status", "Source", "Source Date", "Notes"]
VENDOR_HEADERS = ["Vendor", "Preferred Source", "Discount Multiplier",
                  "Notes"]
CHANGELOG_HEADERS = ["Date", "Version", "Author", "Change"]
VALID_STATUS = {"active", "provisional", "retired"}
VALID_LINE = {"R", "C", "Both"}


@dataclass
class FactorRow:
    subject: str
    line: str
    category: str
    unit: str
    raw_cost: float
    status: str
    source: str
    source_date: str
    notes: str


def create_library(path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Factors"
    ws.append(FACTOR_HEADERS)
    wb.create_sheet("Vendors").append(VENDOR_HEADERS)
    wb.create_sheet("Changelog").append(CHANGELOG_HEADERS)
    wb.save(path)


def validate(rows):
    seen = set()
    for r in rows:
        if r.subject in seen:
            raise ValueError(f"duplicate subject: {r.subject!r}")
        seen.add(r.subject)
        if r.status not in VALID_STATUS:
            raise ValueError(f"bad status {r.status!r} on {r.subject!r}")
        if r.line not in VALID_LINE:
            raise ValueError(f"bad line {r.line!r} on {r.subject!r}")


def write_factors(path, rows):
    validate(rows)
    wb = openpyxl.load_workbook(path)
    ws = wb["Factors"]
    ws.delete_rows(2, ws.max_row)
    for r in rows:
        ws.append(astuple(r))
    wb.save(path)


def load_factors(path):
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb["Factors"]
    rows = []
    for vals in ws.iter_rows(min_row=2, values_only=True):
        if vals[0] is None:
            continue
        rows.append(FactorRow(*[
            v if v is not None else "" for v in vals[:9]]))
    wb.close()
    return rows


def append_changelog(path, *, version, author, change, date):
    wb = openpyxl.load_workbook(path)
    wb["Changelog"].append([date, version, author, change])
    wb.save(path)


def latest_version(path):
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb["Changelog"]
    version = None
    for vals in ws.iter_rows(min_row=2, values_only=True):
        if vals[1] is not None:
            version = vals[1]
    wb.close()
    return version
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/estimating/test_library.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add estimating/library.py tests/estimating/test_library.py
git commit -m "feat(estimating): factor library xlsx schema with validation + changelog"
```

---

### Task 5: harvest — seed the library from chests

**Files:**
- Create: `estimating/harvest.py`
- Create: `tests/estimating/test_harvest.py`

- [ ] **Step 1: Write the failing tests**

```python
from estimating import harvest, library


def test_harvest_builds_rows_from_chests(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF", [
        {"subject": "CASE - A", "unit": "SF", "uc": "26.94"},
        {"subject": "DRW - B", "unit": "EA", "uc": "125.00"},
    ])
    make_chest("HTW-R 09 LED", [
        {"subject": "LED - C", "unit": "LF", "uc": "7.00"},
    ])
    rows = harvest.harvest_chests(tmp_path, line="R",
                                  source_date="2026-06-10")
    assert [r.subject for r in rows] == ["CASE - A", "DRW - B", "LED - C"]
    assert rows[0].category == "CASE & FF"
    assert rows[0].unit == "SF"
    assert rows[0].raw_cost == 26.94
    assert rows[0].status == "active"
    assert rows[2].category == "LED"


def test_harvest_flags_missing_preset_as_provisional_zero(make_chest,
                                                          tmp_path):
    make_chest("HTW-R 01 CASE & FF", [
        {"subject": "NO PRICE", "unit": "EA", "uc": None},
    ])
    rows = harvest.harvest_chests(tmp_path, line="R",
                                  source_date="2026-06-10")
    assert rows[0].raw_cost == 0.0
    assert rows[0].status == "provisional"


def test_end_to_end_harvest_to_xlsx(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF",
               [{"subject": "A", "unit": "EA", "uc": "1.50"}])
    lib = tmp_path / "lib.xlsx"
    library.create_library(lib)
    harvest.harvest_to_library(tmp_path, lib, line="R",
                               source_date="2026-06-10")
    loaded = library.load_factors(lib)
    assert loaded[0].subject == "A"
    assert library.latest_version(lib) == "harvest-2026-06-10"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/estimating/test_harvest.py -v`
Expected: FAIL on missing module.

- [ ] **Step 3: Write the implementation**

```python
"""Seed factor library rows from HTW chest .btx files."""
import glob
import os
import re

from . import btx, library

CHEST_GLOB = "HTW-? [0-9][0-9] *.btx"
CATEGORY_RE = re.compile(r"^HTW-[RC] \d\d (.+)$")


def harvest_chests(chest_dir, *, line, source_date):
    rows = []
    pattern = os.path.join(str(chest_dir), CHEST_GLOB)
    for path in sorted(glob.glob(pattern)):
        ts = btx.read_toolset(path)
        m = CATEGORY_RE.match(ts.title)
        category = m.group(1) if m else ts.title
        for tool in ts.tools:
            uc = tool.preset_unit_cost
            rows.append(library.FactorRow(
                subject=tool.subject,
                line=line,
                category=category,
                unit=tool.unit,
                raw_cost=float(uc) if uc else 0.0,
                status="active" if uc else "provisional",
                source="tool preset harvest",
                source_date=source_date,
                notes="" if uc else "no preset on tool — needs pricing",
            ))
    return rows


def harvest_to_library(chest_dir, lib_path, *, line, source_date):
    rows = harvest_chests(chest_dir, line=line, source_date=source_date)
    library.write_factors(lib_path, rows)
    library.append_changelog(lib_path, version=f"harvest-{source_date}",
                             author="harvest script",
                             change=f"seeded {len(rows)} rows from "
                                    f"{chest_dir}", date=source_date)
    return rows
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/estimating/test_harvest.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add estimating/harvest.py tests/estimating/test_harvest.py
git commit -m "feat(estimating): harvest library rows from chest presets"
```

---

### Task 6: sync + drift — library back to chests, with verification

**Files:**
- Create: `estimating/drift.py`
- Create: `estimating/sync.py`
- Create: `tests/estimating/test_drift.py`
- Create: `tests/estimating/test_sync.py`

- [ ] **Step 1: Write the failing drift tests**

```python
from estimating import drift, library


def _row(subject, cost):
    return library.FactorRow(subject, "R", "X", "EA", cost, "active",
                             "", "", "")


def test_drift_reports_mismatch_and_missing(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF", [
        {"subject": "A", "unit": "EA", "uc": "10.00"},
        {"subject": "B", "unit": "EA", "uc": "5.00"},
    ])
    rows = [_row("A", 12.00), _row("C", 3.00)]
    report = drift.check(tmp_path, rows)
    assert ("A", 10.00, 12.00) in report.price_mismatches
    assert "B" in report.tools_missing_from_library
    assert "C" in report.library_missing_from_chests


def test_no_drift_is_clean(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF",
               [{"subject": "A", "unit": "EA", "uc": "10.00"}])
    report = drift.check(tmp_path, [_row("A", 10.00)])
    assert report.clean
```

- [ ] **Step 2: Write the failing sync tests**

```python
from estimating import btx, drift, library, sync


def _row(subject, cost):
    return library.FactorRow(subject, "R", "X", "EA", cost, "active",
                             "", "", "")


def test_sync_rewrites_presets_to_match_library(make_chest, tmp_path):
    p = make_chest("HTW-R 01 CASE & FF", [
        {"subject": "A", "unit": "EA", "uc": "10.00"},
        {"subject": "B", "unit": "EA", "uc": "5.00"},
    ])
    changed = sync.sync_presets(tmp_path, [_row("A", 12.00), _row("B", 5.00)])
    assert changed == [("A", "10.00", "12.00")]
    ts = btx.read_toolset(p)
    assert ts.tools[0].preset_unit_cost == "12.00"
    assert ts.tools[1].preset_unit_cost == "5.00"
    assert drift.check(tmp_path, [_row("A", 12.00), _row("B", 5.00)]).clean


def test_sync_skips_retired_and_unknown(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF",
               [{"subject": "A", "unit": "EA", "uc": "10.00"}])
    rows = [library.FactorRow("A", "R", "X", "EA", 99.0, "retired",
                              "", "", "")]
    changed = sync.sync_presets(tmp_path, rows)
    assert changed == []
```

- [ ] **Step 3: Run both to verify they fail**

Run: `python -m pytest tests/estimating/test_drift.py tests/estimating/test_sync.py -v`
Expected: FAIL on missing modules.

- [ ] **Step 4: Write drift.py**

```python
"""Compare factor library rows against chest tool presets."""
import glob
import os
from dataclasses import dataclass, field

from . import btx

CHEST_GLOB = "HTW-? [0-9][0-9] *.btx"


@dataclass
class DriftReport:
    price_mismatches: list = field(default_factory=list)   # (subj, tool, lib)
    tools_missing_from_library: list = field(default_factory=list)
    library_missing_from_chests: list = field(default_factory=list)

    @property
    def clean(self):
        return not (self.price_mismatches or self.tools_missing_from_library
                    or self.library_missing_from_chests)


def check(chest_dir, rows) -> DriftReport:
    lib = {r.subject: r for r in rows}
    report = DriftReport()
    seen = set()
    pattern = os.path.join(str(chest_dir), CHEST_GLOB)
    for path in sorted(glob.glob(pattern)):
        for tool in btx.read_toolset(path).tools:
            seen.add(tool.subject)
            row = lib.get(tool.subject)
            if row is None:
                report.tools_missing_from_library.append(tool.subject)
                continue
            tool_cost = float(tool.preset_unit_cost or 0.0)
            if abs(tool_cost - float(row.raw_cost)) > 0.005:
                report.price_mismatches.append(
                    (tool.subject, tool_cost, float(row.raw_cost)))
    report.library_missing_from_chests = sorted(set(lib) - seen)
    return report
```

- [ ] **Step 5: Write sync.py**

```python
"""Push library raw costs into chest tool presets (verify-then-write)."""
import glob
import os

from . import btx

CHEST_GLOB = "HTW-? [0-9][0-9] *.btx"


def sync_presets(chest_dir, rows):
    """Returns list of (subject, old, new) actually changed.
    Skips retired rows and tools not in the library."""
    rates = {r.subject: f"{float(r.raw_cost):.2f}"
             for r in rows if r.status != "retired"}
    changed = []
    pattern = os.path.join(str(chest_dir), CHEST_GLOB)
    for path in sorted(glob.glob(pattern)):
        ts = btx.read_toolset(path)
        dirty = False
        for tool in ts.tools:
            new = rates.get(tool.subject)
            old = tool.preset_unit_cost
            if new is None or old == new:
                continue
            btx.set_preset_unit_cost(tool, new)
            changed.append((tool.subject, old, new))
            dirty = True
        if dirty:
            btx.write_toolset(ts, path)
            verify = btx.read_toolset(path)   # verify-then-write pattern
            for tool in verify.tools:
                expected = rates.get(tool.subject)
                if expected is not None and \
                        tool.preset_unit_cost != expected:
                    raise RuntimeError(
                        f"post-write verification failed for "
                        f"{tool.subject!r} in {path}")
    return changed
```

- [ ] **Step 6: Run tests to verify all pass**

Run: `python -m pytest tests/estimating -v`
Expected: all pass (16 tests at this point).

- [ ] **Step 7: Commit**

```bash
git add estimating/drift.py estimating/sync.py tests/estimating/test_drift.py tests/estimating/test_sync.py
git commit -m "feat(estimating): drift report + verified preset sync"
```

---

### Task 7: catalog — the machine-readable tool registry

**Files:**
- Create: `estimating/catalog.py`
- Create: `tests/estimating/test_catalog.py`

- [ ] **Step 1: Write the failing tests**

```python
import json

from estimating import catalog, library


def test_catalog_merges_chests_and_library(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF", [
        {"subject": "A", "unit": "SF", "uc": "26.94", "layer": "CASE"},
    ])
    rows = [library.FactorRow("A", "R", "CASE & FF", "SF", 26.94,
                              "active", "src", "2026-06-10", "")]
    out = tmp_path / "tool_catalog.json"
    catalog.build(tmp_path, rows, out)
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["version"]
    entry = data["tools"][0]
    assert entry == {
        "subject": "A",
        "chest": "HTW-R 01 CASE & FF",
        "category": "CASE & FF",
        "measurement": "SF",
        "layer": "CASE",
        "raw_cost": 26.94,
        "status": "active",
    }


def test_catalog_marks_tools_without_library_rows(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF",
               [{"subject": "ORPHAN", "unit": "EA", "uc": "1.00"}])
    out = tmp_path / "tool_catalog.json"
    catalog.build(tmp_path, [], out)
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["tools"][0]["status"] == "missing-from-library"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/estimating/test_catalog.py -v`
Expected: FAIL on missing module.

- [ ] **Step 3: Write the implementation**

```python
"""Generate tool_catalog.json — the registry Claude places markups from."""
import glob
import json
import os
from datetime import date

from . import btx

CHEST_GLOB = "HTW-? [0-9][0-9] *.btx"


def build(chest_dir, rows, out_path, version=None):
    lib = {r.subject: r for r in rows}
    tools = []
    pattern = os.path.join(str(chest_dir), CHEST_GLOB)
    for path in sorted(glob.glob(pattern)):
        ts = btx.read_toolset(path)
        for tool in ts.tools:
            row = lib.get(tool.subject)
            tools.append({
                "subject": tool.subject,
                "chest": ts.title,
                "category": row.category if row else None,
                "measurement": tool.unit,
                "layer": tool.layer,
                "raw_cost": float(row.raw_cost) if row else None,
                "status": row.status if row else "missing-from-library",
            })
    payload = {"version": version or date.today().isoformat(),
               "tools": tools}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=1)
    return payload
```

- [ ] **Step 4: Run the full suite**

Run: `python -m pytest tests/estimating -v`
Expected: all pass (18 tests).

- [ ] **Step 5: Commit**

```bash
git add estimating/catalog.py tests/estimating/test_catalog.py
git commit -m "feat(estimating): tool catalog JSON generator"
```

---

### Task 8: Live run against the real chests (manual verification)

**Files:**
- Create: `estimating/run_phase1.py`

No unit tests — this is the supervised live run. The chests on the Drive are the locked shared sets; coordinate with Chris so Revu isn't holding them checked out.

- [ ] **Step 1: Write the runner**

```python
"""Phase 1 live run: harvest -> library v1, drift check, catalog.
Read-only against chests (harvest/catalog); does NOT sync presets."""
import sys
from datetime import date

from . import drift, harvest, library, catalog

CHESTS = (r"G:\Shared drives\Harris Timberworks\BlueBeam Templates & Config"
          r"\HTW Estimating Tool Chest & Custom Columns")
LIB = (r"G:\Shared drives\Harris Timberworks\BlueBeam Templates & Config"
       r"\HTW Factor Library.xlsx")
CATALOG = (r"G:\Shared drives\Harris Timberworks\BlueBeam Templates & Config"
           r"\tool_catalog.json")


def main():
    today = date.today().isoformat()
    library.create_library(LIB)
    rows = harvest.harvest_to_library(CHESTS, LIB, line="R",
                                      source_date=today)
    print(f"library seeded: {len(rows)} rows -> {LIB}")
    report = drift.check(CHESTS, rows)
    print(f"drift clean: {report.clean}")
    if not report.clean:
        print("  mismatches:", report.price_mismatches)
        print("  tools missing:", report.tools_missing_from_library)
        print("  lib missing:", report.library_missing_from_chests)
        sys.exit(1)
    catalog.build(CHESTS, rows, CATALOG, version=f"harvest-{today}")
    print(f"catalog written -> {CATALOG}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run it**

Run: `python -m estimating.run_phase1`
Expected: `library seeded: 188 rows`, `drift clean: True`, catalog written. If row count ≠ 188 or drift is dirty, STOP and investigate before committing — the chests are the source of record here.

- [ ] **Step 3: Manual spot-check with Chris**

Open `HTW Factor Library.xlsx` from the Drive. Verify: `DRW - Solid Maple` = 125.00 EA, `CASE - Frameless - Melamine - <17"` = 26.94 SF, categories match chest names, Changelog has the harvest entry. Any tool harvested as `provisional` (no preset) goes on Chris's pricing review list.

- [ ] **Step 4: Commit**

```bash
git add estimating/run_phase1.py
git commit -m "feat(estimating): phase 1 live runner (harvest + drift + catalog)"
```

---

### Task 9: Update memory and hand off

- [ ] **Step 1: Update the project memory** (`bluebeam-column-index-shift.md` or successor) with: factor library live at its Drive path, library is canonical, sync/drift/catalog commands exist in `estimating/`, and the rule that presets are now regenerated — never hand-edited.

- [ ] **Step 2: Report Phase 1 complete** with: row count, provisional list (Chris's pricing review queue), catalog path. Phase 2 (ASM chest + layers) plans next.

- [ ] **Step 3: Schedule the commercial deep-dive working session.** The commercial side of the library (spec §4) is a research-and-review session with Chris and the estimator — harvesting `example_room_factors.md`, past commercial takeoff Factors tabs, and `htw_policies.md` into Line=C rows through the same `write_factors`/`validate` path built here. It needs no additional code from this plan; it needs the humans and their sources in one sitting.
