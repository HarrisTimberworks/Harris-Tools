# Phase 3: Assembly Expansion Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an ASM marker (subject + Assembly Params string) into priced expansion line items via HTW's confirmed rulebook — the math heart of the takeoff pipeline.

**Architecture:** A pure-function module `estimating/expand.py`. Inputs are injected (`factors` dict subject→raw, `job_config` of finish/door/panel subjects) so everything is unit-testable with no file or Bluebeam access. A thin `expand_job` wrapper loads the live library and runs a list of markers. The Bluebeam importer (markups→engine→takeoff xlsx) is Phase 3b, a later plan.

**Tech Stack:** Python 3.14, pytest, stdlib only. Extends the tested `estimating/` package (currently 50 tests green).

**Spec:** `docs/superpowers/specs/2026-06-10-htw-estimating-pipeline-design.md` §6 (rulebook) + the "Confirmed engine decisions (2026-06-12)" block.

**Rulebook (confirmed by Chris; exact formulas):**
- Units: params are INCHES; convert in²→SF via `/144` before any per-SF factor.
- **Finished End — Frameless** (params D, H): finish only = `D*H/144` SF × finish factor (1-sided). No labor.
- **Finished End — FF Flush** (params D, H): `FF FinEnds - Flush` labor ×1 EA + finish `D*H/144` SF × finish factor.
- **Finished End — FF FE** (params D, H): `FF FinEnds - FF FE (*Add Door Sf)` labor ×1 EA + faux-door panel `(D-3)*(H-3)/144` SF × **door** factor. (Default: no separate finish line — finish is in the door factor; config-flagged.)
- **Open Interior / Glass Door Interior** (params W, H, D, SH): 1-sided-eq SF = `(W*H + 2*D*H + W*D + W*D + SH*W*D*2)/144`, × finish factor (1-sided). Identical for both subjects.
- **Closet Run** (params D + repeated P=HxW): per panel material `H*W/144` SF × panel factor; finish per panel × finish factor at a config-flagged sidedness (default flagged — confirm Monday).

**Job config subjects (real residential tool names):** finish e.g. `FIN - Stain (1 Sided)`; door e.g. `DOOR - Slab - Paint Grade`; panel e.g. `Panels - Paint Grade`. Labor subjects: `FF FinEnds - Flush`, `FF FinEnds - FF FE (*Add Door Sf)`.

**File structure:**
```
estimating/
  expand.py          # parse_params, geometry helpers, per-assembly expanders, expand_marker, expand_job
tests/estimating/
  test_expand.py     # param parser + worked-example geometry + each expander + dispatch + reconciliation
```

---

### Task 0: Param parser

**Files:**
- Create: `estimating/expand.py`
- Create: `tests/estimating/test_expand.py`

- [ ] **Step 1: Write the failing tests**

```python
import pytest
from estimating import expand


def test_parse_scalar_params():
    assert expand.parse_params("W=36 H=84 D=24 SH=3") == {
        "W": 36.0, "H": 84.0, "D": 24.0, "SH": 3.0, "panels": []}


def test_parse_decimals_and_extra_space():
    assert expand.parse_params("D=24.5   H=34.5") == {
        "D": 24.5, "H": 34.5, "panels": []}


def test_parse_closet_panels():
    p = expand.parse_params("D=14 P=84x24 P=84x18")
    assert p["D"] == 14.0
    assert p["panels"] == [(84.0, 24.0), (84.0, 18.0)]


def test_parse_empty_is_empty():
    assert expand.parse_params("") == {"panels": []}
    assert expand.parse_params(None) == {"panels": []}


def test_parse_rejects_malformed_token():
    with pytest.raises(ValueError, match="cannot parse"):
        expand.parse_params("W=36 GARBAGE H=84")
```

- [ ] **Step 2: Run to verify fail**

Run: `python -m pytest tests/estimating/test_expand.py -v`
Expected: FAIL (missing module).

- [ ] **Step 3: Implement the parser in expand.py**

```python
"""Assembly expansion engine — turn ASM markers + params into priced lines.

Pure functions: inject `factors` (subject->raw float) and `job_config`;
no file or Bluebeam access here (see expand_job for the live wrapper).
Params are INCHES; convert in^2 -> SF via /144 before per-SF factors."""
import re
from dataclasses import dataclass

_SCALAR = re.compile(r"^([A-Za-z]+)=(\d+(?:\.\d+)?)$")
_PANEL = re.compile(r"^P=(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$")


def parse_params(s):
    """'W=36 H=84 D=24 SH=3' -> {'W':36.0,...,'panels':[]};
    'P=84x24' tokens collect into panels [(H,W),...]."""
    out = {"panels": []}
    if not s:
        return out
    for tok in s.split():
        m = _PANEL.match(tok)
        if m:
            out["panels"].append((float(m.group(1)), float(m.group(2))))
            continue
        m = _SCALAR.match(tok)
        if m:
            out[m.group(1)] = float(m.group(2))
            continue
        raise ValueError(f"cannot parse param token {tok!r}")
    return out


def _sf(*inches_pairs):
    """sum of (a*b) inch-products converted to square feet."""
    return sum(a * b for a, b in inches_pairs) / 144.0
```

- [ ] **Step 4: Run to verify pass**

Run: `python -m pytest tests/estimating/test_expand.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add estimating/expand.py tests/estimating/test_expand.py
git commit -m "feat(estimating): assembly param parser (W=.. H=.. P=HxW)"
```

---

### Task 1: Geometry — interior 1-sided-equivalent SF

**Files:**
- Modify: `estimating/expand.py`
- Modify: `tests/estimating/test_expand.py`

- [ ] **Step 1: Append the failing tests (hand-worked from the confirmed rule)**

```python
def test_interior_sf_worked_example():
    # W=36 H=84 D=24 SH=3:
    # back 36*84=3024 + sides 2*24*84=4032 + top 36*24=864 + bottom 864
    # + shelves 3*36*24*2=5184  => 13968 in^2 / 144 = 97.0 SF
    assert expand.interior_one_sided_sf(36, 84, 24, 3) == pytest.approx(97.0)


def test_interior_sf_zero_shelves():
    # back 3024 + sides 4032 + top 864 + bottom 864 = 8784 /144 = 61.0
    assert expand.interior_one_sided_sf(36, 84, 24, 0) == pytest.approx(61.0)


def test_finished_end_sf():
    # D=24 H=84 -> 2016 in^2 /144 = 14.0 SF
    assert expand.finished_end_sf(24, 84) == pytest.approx(14.0)


def test_faux_door_sf():
    # FF FE: (24-3)*(84-3) = 21*81 = 1701 /144 = 11.8125 SF
    assert expand.faux_door_sf(24, 84) == pytest.approx(11.8125)
```

- [ ] **Step 2: Run to verify fail**

Run: `python -m pytest tests/estimating/test_expand.py -v`
Expected: 4 new FAIL.

- [ ] **Step 3: Append implementation**

```python
def interior_one_sided_sf(W, H, D, SH):
    """1-sided-equivalent finish SF for a finished interior.
    back + 2 sides + top + bottom + shelves(x2, two-sided)."""
    return _sf((W, H), (D, H), (D, H), (W, D), (W, D),
               *([(W, D)] * (int(SH) * 2)))


def finished_end_sf(D, H):
    """Exposed end face = depth x height, 1-sided."""
    return _sf((D, H))


def faux_door_sf(D, H):
    """FF FE faux door: cabinet side minus 1.5in reveal all around (=-3in)."""
    return _sf((D - 3.0, H - 3.0))
```

- [ ] **Step 4: Run to verify pass**

Run: `python -m pytest tests/estimating/test_expand.py -v`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add estimating/expand.py tests/estimating/test_expand.py
git commit -m "feat(estimating): interior/finished-end/faux-door SF geometry"
```

---

### Task 2: LineItem + per-assembly expanders

**Files:**
- Modify: `estimating/expand.py`
- Modify: `tests/estimating/test_expand.py`

- [ ] **Step 1: Append the failing tests**

```python
FACTORS = {
    "FF FinEnds - Flush": 35.0,
    "FF FinEnds - FF FE (*Add Door Sf)": 60.0,
    "FIN - Stain (1 Sided)": 2.0,
    "DOOR - Slab - Paint Grade": 18.0,
    "Panels - Paint Grade": 9.0,
}
JOB = {"finish_subject": "FIN - Stain (1 Sided)",
       "door_subject": "DOOR - Slab - Paint Grade",
       "panel_subject": "Panels - Paint Grade"}


def _by_subject(items):
    return {i.subject: i for i in items}


def test_expand_frameless_end():
    items = expand.expand_frameless_end({"D": 24, "H": 84}, FACTORS, JOB)
    assert len(items) == 1
    fin = items[0]
    assert fin.subject == "FIN - Stain (1 Sided)"
    assert fin.qty == pytest.approx(14.0)
    assert fin.unit == "SF"
    assert fin.raw_total == pytest.approx(28.0)   # 14 SF * $2


def test_expand_ff_flush_end():
    items = expand.expand_ff_flush_end({"D": 24, "H": 84}, FACTORS, JOB)
    bs = _by_subject(items)
    assert bs["FF FinEnds - Flush"].qty == 1
    assert bs["FF FinEnds - Flush"].unit == "EA"
    assert bs["FF FinEnds - Flush"].raw_total == pytest.approx(35.0)
    assert bs["FIN - Stain (1 Sided)"].raw_total == pytest.approx(28.0)


def test_expand_ff_fe_end():
    items = expand.expand_ff_fe_end({"D": 24, "H": 84}, FACTORS, JOB)
    bs = _by_subject(items)
    assert bs["FF FinEnds - FF FE (*Add Door Sf)"].raw_total == pytest.approx(60.0)
    door = bs["DOOR - Slab - Paint Grade"]
    assert door.qty == pytest.approx(11.8125)
    assert door.raw_total == pytest.approx(212.625)   # 11.8125 * 18
    # default: no separate finish line on the faux door
    assert "FIN - Stain (1 Sided)" not in bs


def test_expand_open_interior():
    items = expand.expand_interior({"W": 36, "H": 84, "D": 24, "SH": 3},
                                   FACTORS, JOB)
    assert len(items) == 1
    assert items[0].subject == "FIN - Stain (1 Sided)"
    assert items[0].qty == pytest.approx(97.0)
    assert items[0].raw_total == pytest.approx(194.0)   # 97 * 2


def test_expand_closet_run_material():
    items = expand.expand_closet_run(
        {"D": 14, "panels": [(84, 24), (84, 18)]}, FACTORS, JOB)
    bs_panel = [i for i in items if i.subject == "Panels - Paint Grade"]
    # panel SF: (84*24 + 84*18)/144 = (2016+1512)/144 = 24.5 SF
    total_panel_sf = sum(i.qty for i in bs_panel)
    assert total_panel_sf == pytest.approx(24.5)


def test_missing_factor_raises():
    with pytest.raises(KeyError, match="not in factor library"):
        expand.expand_frameless_end({"D": 24, "H": 84}, {}, JOB)
```

- [ ] **Step 2: Run to verify fail**

Run: `python -m pytest tests/estimating/test_expand.py -v`
Expected: new tests FAIL.

- [ ] **Step 3: Append implementation**

```python
@dataclass
class LineItem:
    component: str          # human label
    subject: str            # factor library subject
    unit: str               # EA | SF
    qty: float
    raw_unit: float
    raw_total: float


def _rate(factors, subject):
    if subject not in factors:
        raise KeyError(f"{subject!r} not in factor library")
    return float(factors[subject])


def _line(component, subject, unit, qty, factors):
    rate = _rate(factors, subject)
    return LineItem(component, subject, unit, round(qty, 4), rate,
                    round(qty * rate, 2))


# FF FE: does the faux-door panel also get a separate finish line?
# Default False — finish is in the door factor. Flip after Monday confirm.
FF_FE_PANEL_ALSO_FINISHED = False
# Closet loose-panel finish: sides applied to each panel (0=none,1,2).
# Flagged — confirm Monday. Default 1 (show face) until confirmed.
CLOSET_PANEL_FINISH_SIDES = 1


def expand_frameless_end(p, factors, job):
    sf = finished_end_sf(p["D"], p["H"])
    return [_line("Finished end finish", job["finish_subject"], "SF", sf, factors)]


def expand_ff_flush_end(p, factors, job):
    sf = finished_end_sf(p["D"], p["H"])
    return [
        _line("FF flush end labor", "FF FinEnds - Flush", "EA", 1, factors),
        _line("Finished end finish", job["finish_subject"], "SF", sf, factors),
    ]


def expand_ff_fe_end(p, factors, job):
    door_sf = faux_door_sf(p["D"], p["H"])
    items = [
        _line("FF FE end labor", "FF FinEnds - FF FE (*Add Door Sf)", "EA", 1, factors),
        _line("Faux door panel", job["door_subject"], "SF", door_sf, factors),
    ]
    if FF_FE_PANEL_ALSO_FINISHED:
        items.append(_line("Faux door finish", job["finish_subject"], "SF",
                           door_sf, factors))
    return items


def expand_interior(p, factors, job):
    sf = interior_one_sided_sf(p["W"], p["H"], p["D"], p.get("SH", 0))
    return [_line("Interior finish (1-sided-eq)", job["finish_subject"], "SF",
                  sf, factors)]


def expand_closet_run(p, factors, job):
    items = []
    for (H, W) in p["panels"]:
        psf = _sf((H, W))
        items.append(_line(f"Closet panel {H:g}x{W:g} material",
                           job["panel_subject"], "SF", psf, factors))
        if CLOSET_PANEL_FINISH_SIDES:
            items.append(_line(f"Closet panel {H:g}x{W:g} finish",
                               job["finish_subject"], "SF",
                               psf * CLOSET_PANEL_FINISH_SIDES, factors))
    return items
```

- [ ] **Step 4: Run to verify pass**

Run: `python -m pytest tests/estimating/test_expand.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add estimating/expand.py tests/estimating/test_expand.py
git commit -m "feat(estimating): per-assembly expanders with injected factors"
```

---

### Task 3: Dispatch by subject

**Files:**
- Modify: `estimating/expand.py`
- Modify: `tests/estimating/test_expand.py`

- [ ] **Step 1: Append the failing tests**

```python
def test_dispatch_routes_each_subject():
    cases = {
        "ASM - Finished End (Frameless) - EA": "D=24 H=84",
        "ASM - Finished End (FF Flush) - EA": "D=24 H=84",
        "ASM - Finished End (FF FE) - EA": "D=24 H=84",
        "ASM - Open Interior - EA": "W=36 H=84 D=24 SH=3",
        "ASM - Glass Door Interior - EA": "W=36 H=84 D=24 SH=3",
        "ASM - Closet Run - EA": "D=14 P=84x24",
    }
    for subject, params in cases.items():
        items = expand.expand_marker(subject, params, FACTORS, JOB)
        assert items and all(i.raw_total >= 0 for i in items)


def test_dispatch_unknown_subject_raises():
    with pytest.raises(ValueError, match="no expander"):
        expand.expand_marker("ASM - Mystery - EA", "D=1 H=1", FACTORS, JOB)


def test_glass_equals_open():
    a = expand.expand_marker("ASM - Open Interior - EA",
                             "W=36 H=84 D=24 SH=3", FACTORS, JOB)
    b = expand.expand_marker("ASM - Glass Door Interior - EA",
                             "W=36 H=84 D=24 SH=3", FACTORS, JOB)
    assert a[0].raw_total == b[0].raw_total
```

- [ ] **Step 2: Run to verify fail**

Run: `python -m pytest tests/estimating/test_expand.py -v`
Expected: new tests FAIL.

- [ ] **Step 3: Append implementation**

```python
_DISPATCH = {
    "ASM - Finished End (Frameless) - EA": expand_frameless_end,
    "ASM - Finished End (FF Flush) - EA": expand_ff_flush_end,
    "ASM - Finished End (FF FE) - EA": expand_ff_fe_end,
    "ASM - Open Interior - EA": expand_interior,
    "ASM - Glass Door Interior - EA": expand_interior,
    "ASM - Closet Run - EA": expand_closet_run,
}


def expand_marker(subject, params_str, factors, job):
    """Top-level: subject + raw params string -> priced LineItems."""
    fn = _DISPATCH.get(subject)
    if fn is None:
        raise ValueError(f"no expander for subject {subject!r}")
    return fn(parse_params(params_str), factors, job)
```

- [ ] **Step 4: Run to verify pass**

Run: `python -m pytest tests/estimating/test_expand.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add estimating/expand.py tests/estimating/test_expand.py
git commit -m "feat(estimating): expand_marker subject dispatch"
```

---

### Task 4: Live wrapper + reconciliation

**Files:**
- Modify: `estimating/expand.py`
- Modify: `tests/estimating/test_expand.py`

- [ ] **Step 1: Append the failing tests**

```python
def test_expand_job_loads_factors_and_validates_config(tmp_path):
    from estimating import library
    lib = tmp_path / "lib.xlsx"
    library.create_library(lib)
    library.write_factors(lib, [
        library.FactorRow("FIN - Stain (1 Sided)", "R", "FINISH", "SF",
                          2.0, "active", "", "", ""),
    ])
    markers = [("ASM - Open Interior - EA", "W=36 H=84 D=24 SH=3")]
    job = {"finish_subject": "FIN - Stain (1 Sided)",
           "door_subject": "X", "panel_subject": "Y"}
    items, errors = expand.expand_job(lib, markers, job)
    assert errors == []
    assert items[0].raw_total == pytest.approx(194.0)


def test_expand_job_reports_missing_factor_not_crash(tmp_path):
    from estimating import library
    lib = tmp_path / "lib.xlsx"
    library.create_library(lib)   # empty
    markers = [("ASM - Open Interior - EA", "W=1 H=1 D=1 SH=0")]
    job = {"finish_subject": "FIN - Stain (1 Sided)",
           "door_subject": "X", "panel_subject": "Y"}
    items, errors = expand.expand_job(lib, markers, job)
    assert items == []
    assert len(errors) == 1 and "FIN - Stain (1 Sided)" in errors[0]
```

- [ ] **Step 2: Run to verify fail**

Run: `python -m pytest tests/estimating/test_expand.py -v`
Expected: new tests FAIL.

- [ ] **Step 3: Append implementation**

```python
def expand_job(lib_path, markers, job):
    """Load the live factor library and expand a list of (subject, params).
    Returns (line_items, errors). A marker whose factor is missing or whose
    params are malformed produces an error string and is skipped — never
    crashes the batch."""
    from . import library
    factors = {r.subject: r.raw_cost for r in library.load_factors(lib_path)}
    items, errors = [], []
    for subject, params_str in markers:
        try:
            items.extend(expand_marker(subject, params_str, factors, job))
        except (KeyError, ValueError) as e:
            errors.append(f"{subject} [{params_str}]: {e}")
    return items, errors
```

- [ ] **Step 4: Run the full suite**

Run: `python -m pytest tests/estimating -v`
Expected: all pass (50 prior + 20 new = 70).

- [ ] **Step 5: Commit**

```bash
git add estimating/expand.py tests/estimating/test_expand.py
git commit -m "feat(estimating): expand_job live-library wrapper with error capture"
```

---

### Task 5: Rulebook reference doc + Andrea Dart reconciliation

**Files:**
- Create: `estimating/RULEBOOK.md`
- Create: `estimating/reconcile_dart.py`

- [ ] **Step 1: Write the human-readable rulebook**

Create `estimating/RULEBOOK.md` documenting every formula with the worked $97 SF interior example and the FF FE faux-door example, the two config flags and their open questions, and the job_config contract. (Mirror the spec block; this is the estimator-facing reference.)

- [ ] **Step 2: Write a reconciliation harness (no hard assertions — a report)**

`estimating/reconcile_dart.py`: pick 3–5 finished-interior or finished-end cabinets from the Andrea Dart archive (`Harris-Tools\.claude\tmp\dart_cull\andrea_dart_16col_pre_cull_archive.json` lists every markup's data), and for each, given its real dims, print what `expand_marker` would produce vs the finish SF the estimator manually drew. This validates the rulebook against human judgment. Print a table; flag any >5% deltas for Chris.

- [ ] **Step 3: Run the reconciliation and capture output**

Run: `python -m estimating.reconcile_dart`
Review the deltas with Chris. Large deltas mean either a rulebook gap or a non-standard cabinet — both worth knowing before Phase 4 auto-fills params.

- [ ] **Step 4: Commit**

```bash
git add estimating/RULEBOOK.md estimating/reconcile_dart.py
git commit -m "docs(estimating): expansion rulebook reference + Dart reconciliation harness"
```

- [ ] **Step 5: Update memory** with: expansion engine live (estimating/expand.py), the two confirmed decisions, the two config-flagged open items for Monday, and that Phase 3b (Bluebeam importer → takeoff xlsx) is the next build.
