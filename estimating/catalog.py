"""Generate tool_catalog.json — the registry Claude places markups from."""
import glob
import json
import os
from datetime import date

from . import btx


def build(chest_dir, rows, out_path, version=None):
    lib = {r.subject: r for r in rows}
    tools = []
    pattern = os.path.join(str(chest_dir), btx.CHEST_GLOB)
    for path in sorted(glob.glob(pattern)):
        ts = btx.read_toolset(path)
        for tool in ts.tools:
            row = lib.get(tool.subject)
            tools.append({
                "subject": tool.subject,
                "chest": ts.title,
                "category": row.category if row else None,
                "measurement": tool.unit,
                "layer": tool.layer,
                "raw_cost": float(row.raw_cost) if row else None,
                "status": row.status if row else "missing-from-library",
            })
    payload = {"version": version or date.today().isoformat(),
               "tools": tools}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=1)
    return payload
