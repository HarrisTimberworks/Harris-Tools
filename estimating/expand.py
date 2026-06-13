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
