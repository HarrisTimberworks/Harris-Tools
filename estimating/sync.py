"""Push library raw costs into chest tool presets (verify-then-write)."""
import glob
import os

from . import btx

CHEST_GLOB = "HTW-[RC] [0-9][0-9] *.btx"


def sync_presets(chest_dir, rows):
    """Returns list of (subject, old, new) actually changed.
    Skips retired rows and tools not in the library."""
    rates = {r.subject: f"{float(r.raw_cost):.2f}"
             for r in rows if r.status != "retired"}
    changed = []
    pattern = os.path.join(str(chest_dir), CHEST_GLOB)
    for path in sorted(glob.glob(pattern)):
        ts = btx.read_toolset(path)
        dirty = False
        for tool in ts.tools:
            new = rates.get(tool.subject)
            old = tool.preset_unit_cost
            if new is None or old == new:
                continue
            btx.set_preset_unit_cost(tool, new)
            changed.append((tool.subject, old, new))
            dirty = True
        if dirty:
            btx.write_toolset(ts, path)
            verify = btx.read_toolset(path)   # verify-then-write pattern
            for tool in verify.tools:
                expected = rates.get(tool.subject)
                if expected is not None and \
                        tool.preset_unit_cost != expected:
                    raise RuntimeError(
                        f"post-write verification failed for "
                        f"{tool.subject!r} in {path}")
    return changed
