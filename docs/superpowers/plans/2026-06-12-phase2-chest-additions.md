# Phase 2: Residential Chest Additions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the ASSEMBLIES marker chest, rewrite every tool's layer assignment to the approved taxonomy, fix the `'SHIPPING '` subject, rework harvest to merge-by-line, and extend the catalog with color + ASM parameter specs.

**Architecture:** Extends the tested `estimating/` package (Phase 1, 29 tests green). New btx capabilities (color read, layer write, subject rename) feed three new commands (`layers`, `asm_chest`, plus harvest rework) and a supervised live runner that backs up the Drive chests before touching them.

**Tech Stack:** Python 3.14, openpyxl, pytest, stdlib. All `.btx` knowledge already proven in `estimating/btx.py`.

**Spec:** `docs/superpowers/specs/2026-06-10-htw-estimating-pipeline-design.md` §5, §6, §11 phase 2. Design confirmations from Chris 2026-06-12: layer taxonomy table, six ASM markers (incl. Frameless = finish-SF-only), unit-suffix grammar for new subjects.

**Approved layer taxonomy** (chest title → layer): `HTW-R 01 CASE & FF`→`CASE`, `02 CTOP & PANELS`→`CTOP`, `03 DOORS`→`DOORS`, `04 GLASS & MIRROR`→`GLASS`, `05 FINISH`→`FINISH`, `06 TRIM`→`TRIM`, `07 MF`→`MF`, `08 INSERTS`→`INS`, `09 LED`→`LED`, `10 SPECIALTY & MISC`→`MISC`, `11 ASSEMBLIES`→`ASM`. (`NOTES` is reserved for the Phase-4 engine; no tool carries it.)

**Approved ASM markers v1** (all Count/EA, layer `ASM`, empty presets — they price via Phase-3 expansion):

| Subject | Params | Comment template |
|---|---|---|
| `ASM - Finished End (FF Flush) - EA` | D, H | `D__ H__` |
| `ASM - Finished End (FF FE) - EA` | D, H | `D__ H__` |
| `ASM - Finished End (Frameless) - EA` | D, H | `D__ H__` |
| `ASM - Open Interior - EA` | W, H, D, SH | `W__ H__ D__ SH__` |
| `ASM - Glass Door Interior - EA` | W, H, D, SH | `W__ H__ D__ SH__` |
| `ASM - Closet Run - EA` | D, P=HxW per panel | `D__ P__x__ P__x__` |

---

### Task 0: btx color read + layer write + subject rename

**Files:**
- Modify: `estimating/btx.py`
- Modify: `tests/estimating/test_btx.py`
- Modify: `tests/estimating/conftest.py` (fixture gains a `color` key)

- [ ] **Step 1: Extend the fixture** — in `conftest.py` `_raw_dict`, change the signature to `_raw_dict(subject, uc, em="1.06", md="0.60", layer=None, color="0 0.5019608 1")` and the IC part of the string to `f"/IC[{color}]"`. In `_make`, pass `color=t.get("color", "0 0.5019608 1")`.

- [ ] **Step 2: Write the failing tests (append to test_btx.py)**

```python
def test_color_parses_to_hex(make_chest):
    p = make_chest("X", [{"subject": "A", "unit": "LF", "uc": "1.00",
                          "color": "1 0 0.25"}])
    assert btx.read_toolset(p).tools[0].color == "#FF0040"


def test_set_layer_replaces_existing(make_chest, tmp_path):
    p = make_chest("X", [{"subject": "A", "unit": "LF", "uc": "1.00",
                          "layer": "OLD"}])
    ts = btx.read_toolset(p)
    btx.set_layer(ts.tools[0], "TRIM")
    out = tmp_path / "o.btx"
    btx.write_toolset(ts, out)
    assert btx.read_toolset(out).tools[0].layer == "TRIM"


def test_set_layer_inserts_when_absent(make_chest, tmp_path):
    p = make_chest("X", [{"subject": "A", "unit": "LF", "uc": "1.00"}])
    ts = btx.read_toolset(p)
    assert ts.tools[0].layer is None
    btx.set_layer(ts.tools[0], "CASE")
    out = tmp_path / "o.btx"
    btx.write_toolset(ts, out)
    t2 = btx.read_toolset(out).tools[0]
    assert t2.layer == "CASE"
    assert t2.subject == "A"           # nothing else disturbed
    assert t2.preset_unit_cost == "1.00"


def test_rename_subject_roundtrip(make_chest, tmp_path):
    p = make_chest("X", [{"subject": "SHIPPING ", "unit": "EA",
                          "uc": "0.00"}])
    ts = btx.read_toolset(p)
    btx.rename_subject(ts.tools[0], "SHIPPING")
    out = tmp_path / "o.btx"
    btx.write_toolset(ts, out)
    assert btx.read_toolset(out).tools[0].subject == "SHIPPING"


def test_rename_subject_rejects_delimiters(make_chest):
    p = make_chest("X", [{"subject": "A", "unit": "EA", "uc": "1.00"}])
    ts = btx.read_toolset(p)
    with pytest.raises(ValueError, match="delimiters"):
        btx.rename_subject(ts.tools[0], "BAD(NAME)")
```

(`import pytest` at top of test_btx.py if not present.)

- [ ] **Step 3: Run `python -m pytest tests/estimating/test_btx.py -v`** — expect the 5 new tests FAIL (AttributeError), existing 6 pass.

- [ ] **Step 4: Implement in btx.py** — add regex `IC_RE = re.compile(r'/IC\[([^\]]*)\]')` with the others, then:

```python
    @property
    def color(self):
        m = IC_RE.search(self.raw)
        if not m:
            return None
        parts = m.group(1).split()
        if len(parts) < 3:
            return None
        rgb = [round(float(x) * 255) for x in parts[:3]]
        return "#{:02X}{:02X}{:02X}".format(*rgb)
```

(add as a property on `Tool`), and module functions:

```python
def _reencode(tool: Tool):
    tool.element.find("Raw").text = zlib.compress(
        tool.raw.encode("latin-1")).hex()


def _check_pdf_text(value: str, what: str):
    if "(" in value or ")" in value or "\\" in value:
        raise ValueError(
            f"{what} {value!r} contains PDF-string delimiters")


def set_layer(tool: Tool, layer: str):
    """Set the markup's layer (/OC). Replaces an existing assignment or
    inserts one when absent."""
    _check_pdf_text(layer, "layer")
    if OC_RE.search(tool.raw):
        tool.raw = OC_RE.sub(lambda m: f"/OC({layer})", tool.raw, count=1)
    else:
        idx = tool.raw.rstrip().rfind(">>")
        tool.raw = tool.raw[:idx] + f"/OC({layer})" + tool.raw[idx:]
    tool.layer = layer
    _reencode(tool)


def rename_subject(tool: Tool, new_subject: str):
    """Rename the tool's /Subj. The subject is the exact-match key joining
    tools, library rows, and takeoff line items — rename all three together."""
    _check_pdf_text(new_subject, "subject")
    tool.raw = SUBJ_RE.sub(lambda m: f"/Subj({new_subject})", tool.raw,
                           count=1)
    tool.subject = new_subject
    _reencode(tool)
```

Refactor `set_preset_unit_cost` to use `_check_pdf_text(value, "preset value")` and `_reencode(tool)` — keep its error message containing the word "delimiters" so the existing test still matches.

- [ ] **Step 5: Run `python -m pytest tests/estimating -v`** — expect 34 passed.

- [ ] **Step 6: Commit**

```bash
git add estimating/btx.py tests/estimating/test_btx.py tests/estimating/conftest.py
git commit -m "feat(estimating): btx color read, layer write, subject rename"
```

---

### Task 1: layers module — taxonomy audit + apply

**Files:**
- Create: `estimating/layers.py`
- Create: `tests/estimating/test_layers.py`

- [ ] **Step 1: Write the failing tests**

```python
from estimating import btx, layers


def test_audit_reports_current_assignments(make_chest, tmp_path):
    make_chest("HTW-R 06 TRIM", [
        {"subject": "T1", "unit": "LF", "uc": "1.00", "layer": "Case"},
        {"subject": "T2", "unit": "LF", "uc": "1.00"},
    ])
    report = layers.audit(tmp_path)
    assert report["HTW-R 06 TRIM"] == {"T1": "Case", "T2": None}


def test_apply_sets_chest_layer_on_every_tool(make_chest, tmp_path):
    p = make_chest("HTW-R 06 TRIM", [
        {"subject": "T1", "unit": "LF", "uc": "1.00", "layer": "Case"},
        {"subject": "T2", "unit": "LF", "uc": "1.00"},
    ])
    changed = layers.apply(tmp_path)
    assert changed == [("HTW-R 06 TRIM", "T1", "Case", "TRIM"),
                      ("HTW-R 06 TRIM", "T2", None, "TRIM")]
    ts = btx.read_toolset(p)
    assert [t.layer for t in ts.tools] == ["TRIM", "TRIM"]


def test_apply_skips_already_correct(make_chest, tmp_path):
    make_chest("HTW-R 09 LED", [
        {"subject": "L1", "unit": "LF", "uc": "1.00", "layer": "LED"},
    ])
    assert layers.apply(tmp_path) == []


def test_apply_refuses_unknown_chest_title(make_chest, tmp_path):
    make_chest("HTW-R 12 MYSTERY", [
        {"subject": "M1", "unit": "EA", "uc": "1.00"},
    ])
    import pytest
    with pytest.raises(KeyError, match="MYSTERY"):
        layers.apply(tmp_path)
```

- [ ] **Step 2: Run `python -m pytest tests/estimating/test_layers.py -v`** — expect FAIL (missing module).

- [ ] **Step 3: Implement estimating/layers.py**

```python
"""Layer taxonomy: one layer per chest, per the approved Phase-2 table."""
import glob
import os

from . import btx

LAYER_BY_CHEST = {
    "HTW-R 01 CASE & FF": "CASE",
    "HTW-R 02 CTOP & PANELS": "CTOP",
    "HTW-R 03 DOORS": "DOORS",
    "HTW-R 04 GLASS & MIRROR": "GLASS",
    "HTW-R 05 FINISH": "FINISH",
    "HTW-R 06 TRIM": "TRIM",
    "HTW-R 07 MF": "MF",
    "HTW-R 08 INSERTS": "INS",
    "HTW-R 09 LED": "LED",
    "HTW-R 10 SPECIALTY & MISC": "MISC",
    "HTW-R 11 ASSEMBLIES": "ASM",
}


def _chests(chest_dir):
    pattern = os.path.join(str(chest_dir), btx.CHEST_GLOB)
    return [btx.read_toolset(p) for p in sorted(glob.glob(pattern))]


def audit(chest_dir):
    """Current layer per tool, grouped by chest title."""
    return {ts.title: {t.subject: t.layer for t in ts.tools}
            for ts in _chests(chest_dir)}


def apply(chest_dir):
    """Set every tool's layer to its chest's taxonomy layer.
    Returns [(chest, subject, old, new)] for tools actually changed.
    Raises KeyError for a chest title not in the taxonomy."""
    changed = []
    for ts in _chests(chest_dir):
        if ts.title not in LAYER_BY_CHEST:
            raise KeyError(f"no layer defined for chest {ts.title!r}")
        target = LAYER_BY_CHEST[ts.title]
        dirty = False
        for tool in ts.tools:
            if tool.layer == target:
                continue
            changed.append((ts.title, tool.subject, tool.layer, target))
            btx.set_layer(tool, target)
            dirty = True
        if dirty:
            btx.write_toolset(ts, ts.path)
            for tool in btx.read_toolset(ts.path).tools:
                if tool.layer != target:
                    raise RuntimeError(
                        f"layer verification failed for {tool.subject!r} "
                        f"in {ts.path}")
    return changed
```

- [ ] **Step 4: Run `python -m pytest tests/estimating -v`** — expect 38 passed.

- [ ] **Step 5: Commit**

```bash
git add estimating/layers.py tests/estimating/test_layers.py
git commit -m "feat(estimating): layer taxonomy audit + verified apply"
```

---

### Task 2: harvest merge-by-line + subject rename plumbing

**Files:**
- Modify: `estimating/harvest.py`
- Modify: `tests/estimating/test_harvest.py`
- Create: `estimating/rename.py`
- Create: `tests/estimating/test_rename.py`

- [ ] **Step 1: Write the failing harvest test (append)**

```python
def test_harvest_preserves_other_lines(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF",
               [{"subject": "R1", "unit": "EA", "uc": "1.00"}])
    lib = tmp_path / "lib.xlsx"
    library.create_library(lib)
    commercial = library.FactorRow("C1", "C", "CASE", "LF", 9.0, "active",
                                   "deep dive", "2026-06-12", "")
    library.write_factors(lib, [commercial])
    harvest.harvest_to_library(tmp_path, lib, line="R",
                               source_date="2026-06-12")
    loaded = {r.subject: r for r in library.load_factors(lib)}
    assert set(loaded) == {"C1", "R1"}          # C row survived
    assert loaded["C1"].line == "C"
```

- [ ] **Step 2: Write the failing rename tests**

```python
from estimating import btx, library, rename


def test_rename_updates_chest_and_library(make_chest, tmp_path):
    p = make_chest("HTW-R 10 SPECIALTY & MISC",
                   [{"subject": "SHIPPING ", "unit": "EA", "uc": "0.00"}])
    lib = tmp_path / "lib.xlsx"
    library.create_library(lib)
    library.write_factors(lib, [library.FactorRow(
        "SHIPPING ", "R", "SPECIALTY & MISC", "EA", 0.0, "active",
        "harvest", "2026-06-11", "")])
    result = rename.rename_everywhere(tmp_path, lib, "SHIPPING ", "SHIPPING")
    assert result == {"chest_tools": 1, "library_rows": 1}
    assert btx.read_toolset(p).tools[0].subject == "SHIPPING"
    assert library.load_factors(lib)[0].subject == "SHIPPING"


def test_rename_errors_when_subject_not_found(make_chest, tmp_path):
    make_chest("HTW-R 09 LED", [{"subject": "A", "unit": "EA",
                                 "uc": "1.00"}])
    lib = tmp_path / "lib.xlsx"
    library.create_library(lib)
    import pytest
    with pytest.raises(ValueError, match="not found"):
        rename.rename_everywhere(tmp_path, lib, "NOPE", "X")
```

- [ ] **Step 3: Run both new test files** — expect FAIL.

- [ ] **Step 4: Rework `harvest_to_library`**

```python
def harvest_to_library(chest_dir, lib_path, *, line, source_date):
    """Replace ONLY the harvested line's rows; rows of other lines and
    'Both' are preserved untouched."""
    rows = harvest_chests(chest_dir, line=line, source_date=source_date)
    existing = library.load_factors(lib_path)
    kept = [r for r in existing if r.line != line]
    library.write_factors(lib_path, kept + rows)
    library.append_changelog(lib_path, version=f"harvest-{source_date}",
                             author="harvest script",
                             change=f"re-seeded {len(rows)} line={line} rows "
                                    f"from {chest_dir}; kept "
                                    f"{len(kept)} other-line rows",
                             date=source_date)
    return rows
```

- [ ] **Step 5: Implement estimating/rename.py**

```python
"""Rename a Subject everywhere it is a key: chest tools + library rows."""
import glob
import os
from dataclasses import replace

from . import btx, library


def rename_everywhere(chest_dir, lib_path, old, new):
    """Returns {'chest_tools': n, 'library_rows': n}. Raises ValueError if
    the old subject is found nowhere."""
    tool_hits = 0
    pattern = os.path.join(str(chest_dir), btx.CHEST_GLOB)
    for path in sorted(glob.glob(pattern)):
        ts = btx.read_toolset(path)
        dirty = False
        for tool in ts.tools:
            if tool.subject == old:
                btx.rename_subject(tool, new)
                tool_hits += 1
                dirty = True
        if dirty:
            btx.write_toolset(ts, ts.path)
    rows = library.load_factors(lib_path)
    row_hits = 0
    new_rows = []
    for r in rows:
        if r.subject == old:
            new_rows.append(replace(r, subject=new))
            row_hits += 1
        else:
            new_rows.append(r)
    if row_hits:
        library.write_factors(lib_path, new_rows)
    if tool_hits == 0 and row_hits == 0:
        raise ValueError(f"subject {old!r} not found in chests or library")
    return {"chest_tools": tool_hits, "library_rows": row_hits}
```

- [ ] **Step 6: Run `python -m pytest tests/estimating -v`** — expect 41 passed.

- [ ] **Step 7: Commit**

```bash
git add estimating/harvest.py estimating/rename.py tests/estimating/test_harvest.py tests/estimating/test_rename.py
git commit -m "feat(estimating): merge-by-line harvest + subject rename everywhere"
```

---

### Task 3: ASM chest generator

**Files:**
- Create: `estimating/asm_chest.py`
- Create: `tests/estimating/test_asm_chest.py`

- [ ] **Step 1: Write the failing tests**

```python
from estimating import asm_chest, btx


def test_generated_chest_parses_with_six_markers(tmp_path):
    p = asm_chest.build(tmp_path)
    ts = btx.read_toolset(p)
    assert ts.title == "HTW-R 11 ASSEMBLIES"
    assert [t.subject for t in ts.tools] == [s for s, _ in asm_chest.MARKERS]
    assert all(t.unit == "EA" for t in ts.tools)
    assert all(t.layer == "ASM" for t in ts.tools)
    assert all(t.preset_unit_cost is None for t in ts.tools)
    assert all(len(t.col_tokens) == 6 for t in ts.tools)


def test_markers_carry_param_template_comment(tmp_path):
    p = asm_chest.build(tmp_path)
    ts = btx.read_toolset(p)
    raw = ts.tools[3].raw            # ASM - Open Interior - EA
    assert "/Contents(W__ H__ D__ SH__)" in raw


def test_library_rows_for_markers():
    rows = asm_chest.library_rows(source_date="2026-06-12")
    assert len(rows) == 6
    assert all(r.unit == "EA" and r.line == "R" and r.raw_cost == 0.0
               and r.status == "active" for r in rows)
    assert rows[0].subject == "ASM - Finished End (FF Flush) - EA"
```

NOTE: `(FF Flush)` contains parens — inside a PDF string they must be written escaped (`\\(FF Flush\\)`) in Raw; `btx._unescape` handles read-back. The builder must escape parens when writing /Subj and /Contents.

- [ ] **Step 2: Run** — expect FAIL (missing module).

- [ ] **Step 3: Implement estimating/asm_chest.py**

```python
"""Generate the HTW-R 11 ASSEMBLIES chest: six count-type ASM markers.

Markers carry NO preset price (expansion engine prices them in Phase 3);
their Comment ships the parameter template the placer fills in."""
import os
import xml.etree.ElementTree as ET
import zlib

from . import library

TITLE = "HTW-R 11 ASSEMBLIES"
COUNT_TYPE = "Bluebeam.PDF.Annotations.AnnotationMeasureCount"
MARKERS = [
    ("ASM - Finished End (FF Flush) - EA", "D__ H__"),
    ("ASM - Finished End (FF FE) - EA", "D__ H__"),
    ("ASM - Finished End (Frameless) - EA", "D__ H__"),
    ("ASM - Open Interior - EA", "W__ H__ D__ SH__"),
    ("ASM - Glass Door Interior - EA", "W__ H__ D__ SH__"),
    ("ASM - Closet Run - EA", "D__ P__x__ P__x__"),
]
IC = "1 0.4392157 0"        # orange — visually distinct review color


def _escape(s):
    return s.replace("(", "\\(").replace(")", "\\)")


def _marker_raw(subject, template):
    return (
        "<</Version 1"
        "/DS(font: Helvetica 12pt; text-align:center; "
        "line-height:13.8pt; color:#FF7000)"
        "/CountStyle/Checkmark/MeasurementTypes 128/NumCounts 1"
        "/IT/PolygonCount"
        "/Vertices[4.5 11.05393 6.538075 13.092 11.05611 8.569456 "
        "20.45741 17.97527 22.5 15.9417 11.06155 4.499999]"
        f"/IC[{IC}]"
        f"/Subj({_escape(subject)})"
        "/BSIColumnData[()()()()()()]"
        "/OC(ASM)"
        f"/Contents({_escape(template)})"
        "/Subtype/Polygon/Rect[0 0 27 22.47527]"
        "/C[1 0.4392157 0]/F 132"
        "/BS<</W 0/Type/Border/S/S>>>>"
    )


def build(out_dir):
    root = ET.Element("BluebeamRevuToolSet", {"Version": "1"})
    title = ET.SubElement(root, "Title")
    title.text = zlib.compress(TITLE.encode("utf-8")).hex()
    for subject, template in MARKERS:
        item = ET.SubElement(root, "ToolChestItem", {"Version": "1"})
        res = ET.SubElement(item, "Resources")
        ET.SubElement(res, "ID").text = "HTWASMMARKER"
        ET.SubElement(res, "Data").text = "00"
        ET.SubElement(item, "Name").text = "HTWASMMARKER"
        ET.SubElement(item, "Type").text = COUNT_TYPE
        raw = _marker_raw(subject, template)
        ET.SubElement(item, "Raw").text = zlib.compress(
            raw.encode("latin-1")).hex()
        ET.SubElement(item, "X").text = "0"
        ET.SubElement(item, "Y").text = "0"
        ET.SubElement(item, "Index").text = "4"
        ET.SubElement(item, "Mode").text = "properties"
    out_path = os.path.join(str(out_dir), f"{TITLE}.btx")
    xml_bytes = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    with open(out_path, "wb") as f:
        f.write(b"\xef\xbb\xbf" + xml_bytes)
    return out_path


def library_rows(*, source_date):
    return [library.FactorRow(
        subject=subject, line="R", category="ASSEMBLIES", unit="EA",
        raw_cost=0.0, status="active", source="asm chest generator",
        source_date=source_date,
        notes="assembly marker — expands via rulebook (spec §6)")
        for subject, _ in MARKERS]
```

(Clean up the out_path duplication — keep only the `os.path.join` form.)

- [ ] **Step 4: Run `python -m pytest tests/estimating -v`** — expect 44 passed.

- [ ] **Step 5: Commit**

```bash
git add estimating/asm_chest.py tests/estimating/test_asm_chest.py
git commit -m "feat(estimating): ASSEMBLIES chest generator with six ASM markers"
```

---

### Task 4: catalog v2 — color + params

**Files:**
- Modify: `estimating/catalog.py`
- Modify: `tests/estimating/test_catalog.py`

- [ ] **Step 1: Update the exact-entry test and add a params test**

In `test_catalog_merges_chests_and_library`, the expected entry gains two keys (fixture default color `0 0.5019608 1` → `#0080FF`):

```python
    assert entry == {
        "subject": "A",
        "chest": "HTW-R 01 CASE & FF",
        "category": "CASE & FF",
        "measurement": "SF",
        "layer": "CASE",
        "color": "#0080FF",
        "params": None,
        "raw_cost": 26.94,
        "status": "active",
    }
```

Append:

```python
def test_catalog_includes_asm_params(tmp_path):
    from estimating import asm_chest
    asm_chest.build(tmp_path)
    out = tmp_path / "tool_catalog.json"
    data = catalog.build(tmp_path, [], out, version="v")
    by_subject = {t["subject"]: t for t in data["tools"]}
    assert by_subject["ASM - Open Interior - EA"]["params"] == \
        ["W", "H", "D", "SH"]
    assert by_subject["ASM - Closet Run - EA"]["params"] == ["D", "P"]
```

- [ ] **Step 2: Run** — expect the modified + new test FAIL.

- [ ] **Step 3: Implement** — in catalog.py add:

```python
ASM_PARAMS = {
    "ASM - Finished End (FF Flush) - EA": ["D", "H"],
    "ASM - Finished End (FF FE) - EA": ["D", "H"],
    "ASM - Finished End (Frameless) - EA": ["D", "H"],
    "ASM - Open Interior - EA": ["W", "H", "D", "SH"],
    "ASM - Glass Door Interior - EA": ["W", "H", "D", "SH"],
    "ASM - Closet Run - EA": ["D", "P"],
}
```

and in the per-tool dict add `"color": tool.color,` and `"params": ASM_PARAMS.get(tool.subject),` (insert both between "layer" and "raw_cost" to match the test's dict).

- [ ] **Step 4: Run `python -m pytest tests/estimating -v`** — expect 45 passed.

- [ ] **Step 5: Commit**

```bash
git add estimating/catalog.py tests/estimating/test_catalog.py
git commit -m "feat(estimating): catalog v2 with tool color + ASM param specs"
```

---

### Task 5: Phase 2 live runner (supervised, with backup)

**Files:**
- Create: `estimating/run_phase2.py`

- [ ] **Step 1: Write the runner**

```python
"""Phase 2 live run: backup chests, apply layers, fix SHIPPING subject,
generate ASSEMBLIES chest, merge ASM library rows, regenerate catalog.

WRITES to the live chests — coordinate with Chris (Revu closed or chests
not checked out) before running."""
import os
import shutil
import sys
from datetime import date

from . import asm_chest, catalog, drift, harvest, layers, library, rename

BASE = (r"G:\Shared drives\Harris Timberworks\BlueBeam Templates & Config")
CHESTS = os.path.join(BASE, "HTW Estimating Tool Chest & Custom Columns")
LIB = os.path.join(BASE, "HTW Factor Library.xlsx")
CATALOG = os.path.join(BASE, "tool_catalog.json")


def main():
    today = date.today().isoformat()
    backup = os.path.join(CHESTS, f"backup-{today}")

    if os.path.exists(backup):
        print(f"REFUSING: backup dir {backup} already exists "
              f"(was phase 2 already run today?)")
        sys.exit(2)
    os.makedirs(backup)
    import glob as _g
    for p in _g.glob(os.path.join(CHESTS, "*.btx")):
        shutil.copy2(p, backup)
    print(f"backed up {len(os.listdir(backup))} chest files -> {backup}")

    changed = layers.apply(CHESTS)
    print(f"layers: {len(changed)} tool assignments rewritten")

    result = rename.rename_everywhere(CHESTS, LIB, "SHIPPING ", "SHIPPING")
    print(f"SHIPPING rename: {result}")

    asm_path = asm_chest.build(CHESTS)
    print(f"ASSEMBLIES chest written -> {asm_path}")

    rows = library.load_factors(LIB)
    existing_subjects = {r.subject for r in rows}
    new_rows = [r for r in asm_chest.library_rows(source_date=today)
                if r.subject not in existing_subjects]
    library.write_factors(LIB, rows + new_rows)
    library.append_changelog(LIB, version=f"phase2-{today}",
                             author="phase 2 runner",
                             change=f"layers applied, SHIPPING renamed, "
                                    f"{len(new_rows)} ASM rows added",
                             date=today)
    print(f"library: {len(new_rows)} ASM rows added")

    rows = library.load_factors(LIB)
    report = drift.check(CHESTS, rows)
    print(f"drift clean: {report.clean}")
    if not report.clean:
        print("  mismatches:", report.price_mismatches)
        print("  tools missing:", report.tools_missing_from_library)
        print("  lib missing:", report.library_missing_from_chests)
        sys.exit(1)

    catalog.build(CHESTS, rows, CATALOG, version=f"phase2-{today}")
    print(f"catalog regenerated -> {CATALOG}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Pre-flight** — confirm with Chris that Revu is closed (or at least no chest checked out), G: reachable, and the library exists at LIB.

- [ ] **Step 3: Execute** `python -m estimating.run_phase2`. Expected: 10 files backed up; ~188 layer rewrites (most tools have stale/no layers); SHIPPING rename {chest_tools: 1, library_rows: 1}; ASSEMBLIES chest written; 6 ASM rows added; drift clean: True; catalog regenerated.

   **STOP CONDITIONS — report BLOCKED, do not commit:** drift dirty, rename count != 1/1, layer verification error, any exception. The backup dir enables full restore.

- [ ] **Step 4: Commit the runner**

```bash
git add estimating/run_phase2.py
git commit -m "feat(estimating): phase 2 live runner (backup, layers, rename, ASM chest)"
```

---

### Task 6: Chris-side verification + memory

- [ ] **Step 1: Chris in Revu** — restart Revu (reloads chests from Drive), then: Manage Tool Sets → Add → Existing → `HTW-R 11 ASSEMBLIES.btx`. Drop one tool from each of three chests onto a blank PDF and verify in the Layers panel that `CASE`/`TRIM`/`ASM` layers auto-create and the markups land on them. Drop `ASM - Open Interior - EA` and confirm the comment shows `W__ H__ D__ SH__`. This is the spec §5.4 layer-auto-creation verification — if layers do NOT auto-create from tool-carried /OC, report back; the fallback design is a layer-seed step in the takeoff skill.

- [ ] **Step 2: Update memory** (bluebeam memory file): Phase 2 complete — layers live, ASSEMBLIES chest exists, SHIPPING fixed, catalog v2 (color+params), backup location, layer-auto-creation verdict from step 1.
