"""Layer taxonomy: one layer per chest, per the approved Phase-2 table."""
import glob
import os

from . import btx


class LayerVerifyError(RuntimeError):
    """Raised when post-write layer verification fails for a chest.

    `verified_changes` holds every (chest, subject, old, new) written and
    re-read successfully before this failure; `failed_path` is the suspect
    chest. Chests after it were not touched."""

    def __init__(self, message, verified_changes, failed_path):
        super().__init__(message)
        self.verified_changes = verified_changes
        self.failed_path = failed_path


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
    verified = []
    for ts in _chests(chest_dir):
        if ts.title not in LAYER_BY_CHEST:
            raise KeyError(f"no layer defined for chest {ts.title!r}")
        target = LAYER_BY_CHEST[ts.title]
        chest_changes = []
        dirty = False
        for tool in ts.tools:
            if tool.layer == target:
                continue
            chest_changes.append((ts.title, tool.subject, tool.layer, target))
            btx.set_layer(tool, target)
            dirty = True
        if dirty:
            btx.write_toolset(ts, ts.path)
            for tool in btx.read_toolset(ts.path).tools:
                if tool.layer != target:
                    raise LayerVerifyError(
                        f"layer verification failed for {tool.subject!r} "
                        f"in {ts.path}",
                        verified_changes=verified, failed_path=ts.path)
            verified.extend(chest_changes)
    return verified
