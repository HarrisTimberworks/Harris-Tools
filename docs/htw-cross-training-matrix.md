# 🎯 HTW Cross-Training + Routing Matrix

**Last updated:** 2026-04-24
**Authority:** This is the single source of truth for crew station assignments. When this conflicts with other docs or script source, this wins. Update this doc FIRST when roles/skills change, then propagate to scripts.

**Files that reference this matrix (keep in sync):**
- `scripts/schedule-production-jobs.js` → `ROUTING` object
- `scripts/rebalance-schedule.js` → `ROUTING` + `SECONDARY` objects
- `scripts/validate-cross-training.js` → `MATRIX` object
- `config/rebalance-overrides.json` → referenced in per-job notes
- `docs/htw-production-system-handoff.md` → Section 3 summary version

---

## 1. Crew Roster

| Name | Monday user ID | Monday display name | Role | Base hrs/wk | Start date | Notes |
|---|---|---|---|---|---|---|
| Chris Harris | 77398023 | Chris Harris | Owner/Operator | 15 production | Active | Engineering FF primary; limited production bandwidth |
| Jonathan Korban | 78941017 | Jonathan Korban | PM / Engineering | 40 | Active | Commercial + Res-FL Engineering lead |
| Paisios | 77398083 | paisios@harristimberworks.com | Multi-station utility | 40 | Active | Primary P&S / Delivery; Secondary wide range |
| Rob | 102500064 | rob tomb | Remote PT Engineering | as-needed | Active | Engineering only, remote, part-time |
| Ian Ratcliffe | 99508397 | ian ratcliffe | Shop floor lead | 40 | Active | Primary Benchwork for FL/Commercial/C/S; Primary Post Fin |
| Vladimir "Spencer" Almgren | 97341714 | Vladimir Almgren | Shop floor | 40 | Active | Primary Benchwork for FF/Mixed; wide Secondary |
| Ken | — (no monday account) | — | CNC / Panel Processing | 40 | Active | Panel Processing Primary. Never Benchwork. Post Fin Commercial only. |
| Robert "Bob" Brening | 100329892 | Robert Brening | Shop Foreman | 40 | **Employee: 2026-05-18**; subcontract 4/27 Mon-Wed | Primary on nearly everything once employed |

**Display name mapping** (used by all scripts):

```
Chris Harris → Chris
Jonathan Korban → Jonathan
paisios@harristimberworks.com → Paisios
rob tomb → Rob
ian ratcliffe → Ian
Vladimir Almgren → Spencer
Robert Brening → Bob
Ken → Ken (text column only, no monday account)
```

---

## 2. Stations

Production flows sequentially through these 7 stations:

1. **Engineering** — CAD, cutlists, detailing, shop drawings
2. **Panel Processing** — CNC cutting, edgebanding, sheet good prep
3. **Benchwork** — Solid wood milling, face frames, door/drawer fronts, custom pieces
4. **Pre Fin Cab Assembly** — Box assembly, attach face frames, prep for finish
5. **Post Fin Cab Assembly** — Hardware install, doors/drawers, final assembly after finish vendor return
6. **Pack & Ship** — Wrapping, crating, loading
7. **Delivery** — Transport to jobsite / client

**Special flows:**
- **P-Lam jobs** skip Finishing cycle entirely (Benchwork multiplier = 0 zeroes standard bench for P-Lam boxes, though CU bench can still apply). Pre-Fin for P-Lam is typically 0 too.
- **Countertop/Surface-only jobs** skip Benchwork, Pre-Fin, Post-Fin entirely (just Panel Processing + Pack/Delivery).
- **Custom Units (CUs)** use override columns (`CU Eng Hrs`, `CU Panel Hrs`, `CU Bench Hrs`, `CU PreFin Hrs`, `CU PostFin Hrs`) instead of formula-calculated hours. Per Chris: CU Post Fin CAN run parallel with tail-end of CU Benchwork.

---

## 3. Routing Matrix (Primary Assignments)

The SCHEDULER uses this first. When multiple Primaries are listed, hours split evenly.

| Station | Res - Face Frame | Res - Frameless | Commercial | Countertop/Surface | Mixed (→FF) |
|---|---|---|---|---|---|
| Engineering | Chris | Chris | **Jonathan** | **Jonathan** | Chris |
| Panel Processing | **Ken** | **Ken** | **Ken** | **Ken** | **Ken** |
| Benchwork | **Spencer** | **Ian** | **Ian** | **Ian** | **Spencer** |
| Pre Fin Cab Assembly | **Spencer** | **Ian** | **Ian** | **Ian** | **Spencer** |
| Post Fin Cab Assembly | Ian + Bob | Ian + Bob | Ian + Bob | Ian + Bob | Ian + Bob |
| Pack & Ship | Paisios | Paisios | Paisios | Paisios | Paisios |
| Delivery | Paisios | Paisios | Paisios | Paisios | Paisios |

**Primary rules:**
- "Ian + Bob" means both are Primary — split hours evenly between them. If one is unavailable (TO, field work, not yet started), the other takes the whole load OR Secondary fills.
- Bob is FILTERED OUT of Primary routing before his employment start date 2026-05-18 (controlled by `BOB_START_DATE` constant in scripts).
- When Primary is over capacity, route overflow to Secondary (see Section 4).

---

## 4. Secondary Matrix (Fallback Assignments)

Used by the rebalancer when Primary is at/over capacity, or when Chris explicitly routes away from an overloaded Primary. Ordered by preference (first listed = most preferred Secondary).

### Res - Face Frame

| Station | Secondaries (in order) |
|---|---|
| Engineering | Paisios, Jonathan |
| Panel Processing | Bob, Ian (emergency only — Ian isn't trained on CNC) |
| Benchwork | Ian, Bob, Paisios |
| Pre Fin Cab Assembly | Ian, Bob, Paisios |
| Post Fin Cab Assembly | Spencer, Paisios |
| Pack & Ship | Ian, Spencer, Bob, Jonathan |
| Delivery | Ian, Spencer, Bob, Jonathan |

### Res - Frameless

| Station | Secondaries (in order) |
|---|---|
| Engineering | Paisios, Jonathan, Rob (fill only) |
| Panel Processing | Bob, Ian (CNC-trained for FL) |
| Benchwork | Spencer, Bob, Paisios |
| Pre Fin Cab Assembly | Spencer, Bob, Paisios |
| Post Fin Cab Assembly | Spencer, Paisios |
| Pack & Ship | Ian, Spencer, Bob, Jonathan |
| Delivery | Ian, Spencer, Bob, Jonathan |

### Commercial

| Station | Secondaries (in order) |
|---|---|
| Engineering | Chris (if load permits), Paisios |
| Panel Processing | Bob, Ian |
| Benchwork | Spencer, Bob, Paisios |
| Pre Fin Cab Assembly | Spencer, Bob, Paisios, Ken (commercial only — Ken OK here) |
| Post Fin Cab Assembly | Spencer, Paisios, **Ken (commercial only)** |
| Pack & Ship | Ian, Spencer, Bob, Jonathan |
| Delivery | Ian, Spencer, Bob, Jonathan |

### Countertop/Surface

| Station | Secondaries (in order) |
|---|---|
| Engineering | Chris (if load permits), Paisios |
| Panel Processing | Bob (especially for edgebanding), Ian |
| Benchwork | Bob, Spencer (rare — most C/S jobs have no benchwork) |
| Post Fin Cab Assembly | Spencer, Paisios |
| Pack & Ship | Ian, Spencer, Bob, Jonathan |
| Delivery | Ian, Spencer, Bob, Jonathan |

### Mixed (treats as FF primarily, but draws from both pools)

| Station | Secondaries (in order) |
|---|---|
| Engineering | Jonathan, Paisios |
| Panel Processing | Bob, Ian |
| Benchwork | Ian, Bob, Paisios |
| Pre Fin Cab Assembly | Ian, Bob, Paisios |
| Post Fin Cab Assembly | Spencer, Paisios |
| Pack & Ship | Ian, Spencer, Bob, Jonathan |
| Delivery | Ian, Spencer, Bob, Jonathan |

---

## 5. Hard Rules (Never Violate)

These are absolute — the scheduler must never route in violation:

1. **Ken NEVER does Benchwork.** No exceptions. Hard constraint.
2. **Ken's Post Fin work is Commercial jobs ONLY.** Not residential.
3. **Rob is remote PT, Engineering only.** Never schedule for shop-floor stations.
4. **Bob is FILTERED OUT pre-2026-05-18** for employee-based scheduling. (Before that date he can only appear as a subcontractor entry in overrides.)
5. **Paisios on Benchwork is LIMITED to light work** (small pieces, prep, assisting). Not a full bench replacement for Ian/Spencer.
6. **Ken on Pre Fin is emergency only.** Capability exists but disruptive to his Panel throughput — avoid unless Primary + Secondary all over cap.

---

## 6. Per-Person Capability Profile

Detailed view of what each crew member can and can't do.

### Chris Harris (Owner)

- **Primary:** Engineering (Res-FF, Res-FL, Mixed)
- **Secondary (load permitting):** Engineering (Commercial, Countertop/Surface)
- **Limits:** Only 15 production hrs/wk — rest goes to owner/operator tasks (BD, admin, field supervision)
- **Not trained:** Any shop-floor station (by design — focuses on design/CAD)

### Jonathan Korban (PM / Engineering Lead)

- **Primary:** Engineering (Commercial, Countertop/Surface)
- **Secondary:** Engineering (Res-FF, Res-FL, Mixed) as backup to Chris; Pack & Ship, Delivery
- **Skills beyond Engineering:** Capable of edgebanding (demonstrated via Cator Ruma weekend plan)
- **Note:** Often covers PM/client work in parallel — treat the 40 hrs as planning ceiling, not floor

### Paisios (Shop Utility)

- **Primary:** Pack & Ship, Delivery
- **Secondary:** Engineering (Res-FF) backup to Chris, Engineering Res-FL Tertiary (Chris P → Paisios S → Jonathan T → Rob F); Benchwork (light work only); Post Fin Cab Assembly (all subtypes)
- **Training in progress:** Engineering FF
- **Availability note:** On paternity leave 2026-04-27 through 2026-05-08

### Ian Ratcliffe (Shop Floor Lead)

- **Primary:** Benchwork (Res-FL, Commercial, C/S), Pre Fin Cab Assembly (Res-FL, Commercial, C/S), Post Fin Cab Assembly (all subtypes — paired with Bob)
- **Secondary:** Benchwork (Res-FF, Mixed), Pre Fin (Res-FF, Mixed), Panel Processing (all subtypes — FL-trained on CNC), Pack & Ship, Delivery
- **Not trained:** Engineering
- **Availability notes:** Field work (warranty/punch) entire week 2026-04-27; Personal TO 5/8, 5/11, 5/25–5/29

### Vladimir "Spencer" Almgren (Shop Floor)

- **Primary:** Benchwork (Res-FF, Mixed), Pre Fin Cab Assembly (Res-FF, Mixed)
- **Secondary:** Benchwork (Res-FL, Commercial, C/S), Pre Fin (Res-FL, Commercial, C/S), Post Fin Cab Assembly (all subtypes), Pack & Ship, Delivery
- **Not trained:** Engineering, Panel Processing

### Ken (CNC / Panel Processing)

- **Primary:** Panel Processing (all subtypes)
- **Secondary:** Pre Fin Cab Assembly (Commercial emergency only), Post Fin Cab Assembly (Commercial only), Pack & Ship, Delivery
- **Hard limit:** Never Benchwork
- **No monday account:** Uses `text_mm2mpjcn` ("Assigned To") column on subitems

### Robert "Bob" Brening (Shop Foreman)

- **Primary (from 2026-05-18 forward):** Post Fin Cab Assembly (all — paired with Ian), Benchwork (all subtypes as capacity demands), Panel Processing (Secondary on CNC)
- **Secondary:** All shop stations, Pack & Ship, Delivery
- **Subcontract availability:** 2026-04-27 Mon-Wed (24 hrs) — use overrides config, NOT Primary routing

### Rob (Remote PT)

- **Fill role only:** Engineering Res-FL (Chris P → Paisios S → Jonathan T → Rob F) when all others over cap
- **Not trained:** Any shop-floor station
- **Scheduling:** On demand only, not a routine capacity slot

---

## 7. Engineering Priority Ladder (Res-FL Specific)

Because Frameless engineering is Chris's limited bandwidth and critical-path, Res-FL uses an explicit priority chain:

1. **Primary:** Chris
2. **Secondary:** Paisios (in training)
3. **Tertiary:** Jonathan
4. **Fill (only when 1-3 over cap):** Rob (remote PT)

The rebalancer walks this ladder in order when placing Res-FL Engineering hours.

---

## 8. Special Cases and Job-Specific Overrides

Situations where the default routing gets overridden for operational reasons. These are captured in `config/rebalance-overrides.json`:

### Cator Ruma (2026-04-29 delivery, Countertop-only)

Not a normal route. Execution:

- **Ian Friday 4/24:** 8 hrs Cator Ruma Panel head-start
- **Jonathan Sat-Sun 4/25–4/26:** 16 hrs weekend edgebanding
- **Ken week of 4/27:** ~8 hrs CNC cutting
- **Edgebanding subcontractor week of 4/27:** ~32 hrs
- **Bob subcontract Mon-Wed 4/27–4/29:** 24 hrs flexible
- **Pack & Ship / Delivery Wed 4/29:** Paisios unavailable (paternity) — fallback to Jonathan or Ian

Uses `customWindow.panel` spanning 2026-04-20 → 2026-05-01.

### Roster 5 P1 (Frameless, 2026-05-27)

- Primary routing applies normally (Commercial).
- Jonathan Engineering for 5 hrs remaining.
- Ken Panel 33.9.
- P-Lam → no Bench, no Pre-Fin, no finishing cycle.
- Post Fin 40 hrs — Ian + Bob split (normal Commercial Primary).

### Roster 5 P2 (Custom Units, 2026-06-10)

Normal Commercial routing but with `parallelPostFin: true` flag:

- CU Post Fin CAN overlap with tail-end of CU Benchwork (different pieces, different crew slots)
- Benchwork runs later weeks, Post Fin starts overlapping in final bench week
- 126 hrs CU Bench is massive — Primary Ian + Secondary Spencer + Bob (employed 5/18+) all contribute
- CU finishing cycle = 7 days per Chris (finish vendor is neighbor, no transit)

### SHI - Huntington Hills (2026-06-01)

Chris directed Bench + Pre Fin route to **Spencer** as Secondary instead of Ian as Primary, since Ian is overloaded. Override applied during session.

---

## 9. Ken's "Assigned To" Pattern

Because Ken has no monday.com account, subitems on his parent rows use:

- **Person column** left empty
- **`text_mm2mpjcn` ("Assigned To" text column):** populated with `"Ken"`

The rebalancer handles this automatically — when crew is Ken, it omits the Person column value and only sets the text column.

Script code:

```javascript
const personPart = personId ? `,"person":{"personsAndTeams":[{"id":${personId},"kind":"person"}]}` : '';
// Ken's personId is null → personPart is empty → only text column gets populated
```

---

## 10. Cross-Train Flag Values (subitem column `color_mm2m34ta`)

When `validate-cross-training.js` runs, it sets each subitem's Cross-Train Flag based on how the assigned crew relates to the station:

| Value | Label | Meaning |
|---|---|---|
| 0 | Primary | Assigned crew is Primary per matrix |
| 1 | Secondary | Assigned crew is Secondary per matrix |
| 2 | Not Trained | Assigned crew is NOT in the training matrix for this station (should never happen normally — indicates a mis-assignment) |
| 3 | Override OK | Explicit approved exception (e.g., Ken on Pre Fin emergency) |

---

## 11. Source code mirrors (keep in sync)

When this matrix changes, update:

### `scripts/schedule-production-jobs.js`

```javascript
const ROUTING = {
  'Res - Face Frame': { 'Engineering': ['Chris'], 'Panel Processing': ['Ken'], 'Benchwork': ['Spencer'], 'Pre Fin Cab Assembly': ['Spencer'], 'Post Fin Cab Assembly': ['Ian', 'Bob'], 'Pack & Ship': ['Paisios'], 'Delivery': ['Paisios'] },
  'Res - Frameless': { 'Engineering': ['Chris'], 'Panel Processing': ['Ken'], 'Benchwork': ['Ian'], 'Pre Fin Cab Assembly': ['Ian'], 'Post Fin Cab Assembly': ['Ian', 'Bob'], 'Pack & Ship': ['Paisios'], 'Delivery': ['Paisios'] },
  'Commercial':      { 'Engineering': ['Jonathan'], 'Panel Processing': ['Ken'], 'Benchwork': ['Ian'], 'Pre Fin Cab Assembly': ['Ian'], 'Post Fin Cab Assembly': ['Ian', 'Bob'], 'Pack & Ship': ['Paisios'], 'Delivery': ['Paisios'] },
  'Countertop/Surface': { 'Engineering': ['Jonathan'], 'Panel Processing': ['Ken'], 'Benchwork': ['Ian'], 'Pre Fin Cab Assembly': ['Ian'], 'Post Fin Cab Assembly': ['Ian', 'Bob'], 'Pack & Ship': ['Paisios'], 'Delivery': ['Paisios'] },
  'Mixed':           { 'Engineering': ['Chris'], 'Panel Processing': ['Ken'], 'Benchwork': ['Spencer'], 'Pre Fin Cab Assembly': ['Spencer'], 'Post Fin Cab Assembly': ['Ian', 'Bob'], 'Pack & Ship': ['Paisios'], 'Delivery': ['Paisios'] },
};
```

### `scripts/rebalance-schedule.js`

Uses both `ROUTING` (above) and `SECONDARY`:

```javascript
const SECONDARY = {
  'Res - Face Frame': {
    'Engineering': ['Paisios', 'Jonathan'],
    'Benchwork': ['Ian', 'Bob', 'Paisios'],
    'Pre Fin Cab Assembly': ['Ian', 'Bob', 'Paisios'],
    'Post Fin Cab Assembly': ['Spencer', 'Paisios'],
  },
  'Res - Frameless': {
    'Engineering': ['Paisios', 'Jonathan'],
    'Benchwork': ['Spencer', 'Bob', 'Paisios'],
    'Pre Fin Cab Assembly': ['Spencer', 'Bob', 'Paisios'],
    'Post Fin Cab Assembly': ['Spencer', 'Paisios'],
    'Panel Processing': ['Ian', 'Bob'],
  },
  'Commercial': {
    'Benchwork': ['Spencer', 'Bob', 'Paisios'],
    'Pre Fin Cab Assembly': ['Spencer', 'Bob', 'Paisios', 'Ken'],
    'Post Fin Cab Assembly': ['Spencer', 'Paisios', 'Ken'],
    'Panel Processing': ['Ian', 'Bob'],
  },
  'Countertop/Surface': {
    'Benchwork': ['Bob', 'Spencer'],
    'Post Fin Cab Assembly': ['Spencer', 'Paisios'],
    'Panel Processing': ['Bob'],
  },
  'Mixed': {
    'Engineering': ['Paisios', 'Jonathan'],
    'Benchwork': ['Ian', 'Bob', 'Paisios'],
    'Pre Fin Cab Assembly': ['Ian', 'Bob', 'Paisios'],
    'Post Fin Cab Assembly': ['Spencer', 'Paisios'],
  },
};
```

### `scripts/validate-cross-training.js`

Uses a combined MATRIX with Primary / Secondary flags — if this doc changes, propagate there too.

---

## 12. Change Log

| Date | Change | Reason |
|---|---|---|
| 2026-04-22 | Initial matrix created | System deployment |
| 2026-04-23 | Added parallel CU Post Fin note for Roster 5 P2 | Chris confirmed CU post-fin can overlap bench tail |
| 2026-04-23 | Clarified Ken Post Fin = Commercial only | Previously ambiguous |
| 2026-04-23 | Added Paisios paternity + Ian field work as availability notes | Operational reality |
| 2026-04-23 | Documented Bob subcontract (4/27 Mon-Wed) vs employee (5/18+) split | Bob bridging period |
| 2026-04-23 | Added Hard Rules section | Previously implicit — making explicit |
| 2026-04-23 | Added Res-FL Engineering priority ladder | Critical-path edge case |
| 2026-04-24 | Removed Ken from PreFin Secondary lists for Res-FF, Res-FL, and Mixed | Internal inconsistency — Hard Rule #6 and Ken's profile both specify Commercial-only for PreFin, but the Secondary tables for non-Commercial subtypes incorrectly listed Ken as a fallback. Hard rule wins; tables now match. Updated SECONDARY object in source-code mirror to match. |

---

*End of authoritative matrix doc. Paste this into new Claude chats for full context on crew capabilities and routing logic.*
