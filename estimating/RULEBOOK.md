# Assembly Expansion Rulebook

A reference for cabinet estimators on how the expansion engine calculates material and labor costs from ASM markers and cabinet dimensions.

## Assembly Parameter Format

Cabinet dimensions are specified as whitespace-separated key=value tokens in inches:

- **W** — Width (front-to-back, facing-out perspective)
- **H** — Height (vertical)
- **D** — Depth (side-to-side)
- **SH** — Number of shelves (default 0 if omitted)

Example: `W=36 H=84 D=24 SH=3`

For closet runs, add panel dimensions as `P=HxW` (height × width in inches):

Example: `D=14 P=84x24 P=84x18` — a 14" deep closet with two panels: 84"H × 24"W and 84"H × 18"W

## Assembly Expansion Formulas & Worked Examples

All sample calculations use these reference rates:
- **FIN - Stain (1 Sided)**: $2/SF (finish/stain)
- **DOOR - Slab - Paint Grade**: $18/SF (door material)
- **Panels - Paint Grade**: $9/SF (cabinet panel material)
- **FF FinEnds - Flush**: $35/EA (frameless flush end labor)
- **FF FinEnds - FF FE (*Add Door Sf)**: $60/EA (frameless frame-and-edge end labor)

### Finished End (Frameless)

**Expansion**: Single finish cost for the exposed end face.

**Formula**: `(D × H) / 144 SF × finish_rate`

**Example** (D=24, H=84):
- Square inches: 24 × 84 = 2016
- Square feet: 2016 / 144 = 14 SF
- Cost: 14 SF × $2/SF = **$28**

---

### Finished End (FF Flush)

**Expansion**: Frameless flush end labor (EA) plus finish cost for the face.

**Formula**: 
- Line 1: `1 EA × FF_Flush_rate = $35`
- Line 2: `(D × H) / 144 SF × finish_rate = $28` (same as Frameless)
- **Total: $63**

**Example** (D=24, H=84): $35 (labor) + $28 (finish) = **$63**

---

### Finished End (FF FE — Frame-and-Edge)

**Expansion**: Frameless FE end labor (EA) plus faux door material for the panel (SF), with optional finish if configured.

**Formula**:
- Line 1: `1 EA × FF_FE_rate = $60`
- Line 2: `((D − 3) × (H − 3)) / 144 SF × door_rate`
  - Subtracts 1.5" reveal on all sides (–3" total per dimension)
- Optional Line 3: If config **FF_FE_PANEL_ALSO_FINISHED** is true, add `((D − 3) × (H − 3)) / 144 SF × finish_rate`

**Example** (D=24, H=84):
- Faux door square inches: (24 − 3) × (84 − 3) = 21 × 81 = 1701
- Square feet: 1701 / 144 = 11.8125 SF
- Labor: 1 EA × $60/EA = $60
- Door material: 11.8125 SF × $18/SF = $212.62
- **Total (without finish): $272.62**

---

### Open Interior

**Expansion**: Interior finish cost for all exposed surfaces (1-sided-equivalent).

**Formula**:
```
SF = (back + 2×sides + top + bottom + shelves×2) / 144
   = (W×H + 2×D×H + 2×W×D + 2×SH×W×D) / 144
Cost = SF × finish_rate
```

**Example** (W=36, H=84, D=24, SH=3):
- Back: 36 × 84 = 3024 in²
- Two sides: 2 × 24 × 84 = 4032 in²
- Top & bottom: 2 × (36 × 24) = 1728 in²
- Shelves (3 shelves, two-sided): 3 × 2 × (36 × 24) = 5184 in²
- Total: (3024 + 4032 + 1728 + 5184) / 144 = **97 SF**
- Cost: 97 SF × $2/SF = **$194**

---

### Glass Door Interior

**Expansion**: Identical to Open Interior (same formula and cost).

---

### Closet Run

**Expansion**: For each panel in the run, add material cost and optionally finish cost.

**Formula** (per panel):
- Line 1: `(H × W) / 144 SF × panel_rate` (material)
- Line 2 (if configured): `(H × W) / 144 SF × finish_rate × sides` (finish)

**Config**: **CLOSET_PANEL_FINISH_SIDES** (default: 1) — number of sides to finish per panel.

**Example** (D=14, panels: 84×24 and 84×18, with 1-sided finish):
- Panel 1 (84×24):
  - Material: (84 × 24) / 144 = 14 SF × $9/SF = $126
  - Finish: 14 SF × $2/SF = $28
- Panel 2 (84×18):
  - Material: (84 × 18) / 144 = 10.5 SF × $9/SF = $94.50
  - Finish: 10.5 SF × $2/SF = $21
- **Total: $269.50**

---

## Job Configuration Contract

The expansion engine requires three configuration keys in the `job` object, each referencing a subject in the factor library:

- **finish_subject** — The subject to use for all finish/stain line items (e.g., "FIN - Stain (1 Sided)")
- **door_subject** — The subject to use for door panel material (e.g., "DOOR - Slab - Paint Grade")
- **panel_subject** — The subject to use for cabinet panel material (e.g., "Panels - Paint Grade")

These are tied to real residential tool subjects in the Bluebeam templates and must be provided to `expand_job()` at runtime.

---

## OPEN — Confirm at Monday Review

The following configuration flags are one-line changes to the expansion logic. Their behavior should be validated during residential takeoffs in Phase 4:

### 1. **FF_FE_PANEL_ALSO_FINISHED** (default: False)

**Line**: `estimating/expand.py`, line 99

**Behavior**:
- **False** (current): FF FE end panels are charged as door material only (no separate finish cost)
- **True** (alternate): Faux door panels are finished on one side in addition to the door material charge

**Decision**: Confirm with estimating whether a frame-and-edge finished end includes finish labor on the panel, or if the finish is assumed in the door material rate.

### 2. **CLOSET_PANEL_FINISH_SIDES** (default: 1)

**Line**: `estimating/expand.py`, line 100

**Behavior**:
- **1** (current): Each closet panel is finished on one side
- **2** (alternate): Each closet panel is finished on both sides
- **0** (no finish): Panels are material only

**Decision**: Confirm with estimating how many sides of closet panels receive finish, and whether this varies by job.

---

## Testing & Validation

The engine is validated against:
1. **Unit tests** — Each formula verified with worked examples (tests/estimating/test_expand.py)
2. **Reconciliation** — Sanity checks against historical takeoffs without ASM markers (estimating/reconcile_dart.py)
3. **Live golden test** — Once ASM markers are present on a measured residential job (Phase 4)
