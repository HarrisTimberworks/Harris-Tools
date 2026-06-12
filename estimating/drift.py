"""Compare factor library rows against chest tool presets."""
import glob
import os
from dataclasses import dataclass, field

from . import btx

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
    pattern = os.path.join(str(chest_dir), btx.CHEST_GLOB)
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
