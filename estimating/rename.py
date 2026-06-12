"""Rename a Subject everywhere it is a key: chest tools + library rows."""
import glob
import os
from dataclasses import replace

from . import btx, library


def rename_everywhere(chest_dir, lib_path, old, new):
    """Returns {'chest_tools': n, 'library_rows': n}. Raises ValueError if
    the old subject is found nowhere."""
    tool_hits = 0
    pattern = os.path.join(str(chest_dir), btx.CHEST_GLOB)
    for path in sorted(glob.glob(pattern)):
        ts = btx.read_toolset(path)
        dirty = False
        for tool in ts.tools:
            if tool.subject == old:
                btx.rename_subject(tool, new)
                tool_hits += 1
                dirty = True
        if dirty:
            btx.write_toolset(ts, ts.path)
    rows = library.load_factors(lib_path)
    row_hits = 0
    new_rows = []
    for r in rows:
        if r.subject == old:
            new_rows.append(replace(r, subject=new))
            row_hits += 1
        else:
            new_rows.append(r)
    if row_hits:
        library.write_factors(lib_path, new_rows)
    if tool_hits == 0 and row_hits == 0:
        raise ValueError(f"subject {old!r} not found in chests or library")
    return {"chest_tools": tool_hits, "library_rows": row_hits}
