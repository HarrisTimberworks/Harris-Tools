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
