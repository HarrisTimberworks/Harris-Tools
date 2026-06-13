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
    intake: list = field(default_factory=list)
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
