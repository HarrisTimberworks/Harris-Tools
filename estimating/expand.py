"""Assembly expansion engine — turn ASM markers + params into priced lines.

Pure functions: inject `factors` (subject->raw float) and `job_config`;
no file or Bluebeam access here (see expand_job for the live wrapper).
Params are INCHES; convert in^2 -> SF via /144 before per-SF factors."""
import re
from dataclasses import dataclass


@dataclass
class LineItem:
    component: str
    subject: str
    unit: str
    qty: float
    raw_unit: float
    raw_total: float

_SCALAR = re.compile(r"^([A-Za-z]+)=(\d+(?:\.\d+)?)$")
_PANEL = re.compile(r"^P=(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$")
VALID_KEYS = {"W", "H", "D", "SH"}


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
        # Reject malformed P= tokens (e.g., "P=84" without x dimension)
        if tok.startswith("P="):
            raise ValueError(f"cannot parse panel token {tok!r} — expected P=HxW")
        m = _SCALAR.match(tok)
        if m:
            key = m.group(1)
            if key not in VALID_KEYS:
                raise ValueError(f"unknown param key {key!r} — valid: {sorted(VALID_KEYS)}")
            out[key] = float(m.group(2))
            continue
        raise ValueError(f"cannot parse param token {tok!r}")
    return out


def _sf(*inches_pairs):
    """sum of (a*b) inch-products converted to square feet."""
    return sum(a * b for a, b in inches_pairs) / 144.0


def interior_one_sided_sf(W, H, D, SH):
    """1-sided-equivalent finish SF for a finished interior.
    back + 2 sides + top + bottom + shelves(x2, two-sided)."""
    if W <= 0:
        raise ValueError(f"interior_one_sided_sf: W must be positive, got {W}")
    if H <= 0:
        raise ValueError(f"interior_one_sided_sf: H must be positive, got {H}")
    if D <= 0:
        raise ValueError(f"interior_one_sided_sf: D must be positive, got {D}")
    if SH < 0:
        raise ValueError(f"interior_one_sided_sf: SH must be non-negative, got {SH}")
    return _sf((W, H), (D, H), (D, H), (W, D), (W, D),
               *([(W, D)] * (int(SH) * 2)))


def finished_end_sf(D, H):
    """Exposed end face = depth x height, 1-sided."""
    if D <= 0:
        raise ValueError(f"finished_end_sf: D must be positive, got {D}")
    if H <= 0:
        raise ValueError(f"finished_end_sf: H must be positive, got {H}")
    return _sf((D, H))


def faux_door_sf(D, H):
    """FF FE faux door: cabinet side minus 1.5in reveal all around (=-3in)."""
    if D <= 3:
        raise ValueError(f"faux_door_sf: D must be > 3, got {D}")
    if H <= 3:
        raise ValueError(f"faux_door_sf: H must be > 3, got {H}")
    return _sf((D - 3.0, H - 3.0))


def _rate(factors, subject):
    if subject not in factors:
        raise KeyError(f"{subject!r} not in factor library")
    return float(factors[subject])


def _line(component, subject, unit, qty, factors):
    rate = _rate(factors, subject)
    return LineItem(component, subject, unit, round(qty, 4), rate,
                    round(qty * rate, 4))


FF_FE_PANEL_ALSO_FINISHED = False
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


_DISPATCH = {
    "ASM - Finished End (Frameless) - EA": expand_frameless_end,
    "ASM - Finished End (FF Flush) - EA": expand_ff_flush_end,
    "ASM - Finished End (FF FE) - EA": expand_ff_fe_end,
    "ASM - Open Interior - EA": expand_interior,
    "ASM - Glass Door Interior - EA": expand_interior,
    "ASM - Closet Run - EA": expand_closet_run,
}


def expand_marker(subject, params_str, factors, job):
    fn = _DISPATCH.get(subject)
    if fn is None:
        raise ValueError(f"no expander for subject {subject!r}")
    return fn(parse_params(params_str), factors, job)
