"""Phase 2 live run: backup chests, apply layers, fix SHIPPING subject,
generate ASSEMBLIES chest, merge ASM library rows, regenerate catalog.

WRITES to the live chests — coordinate with Chris (Revu closed or chests
not checked out) before running."""
import glob
import os
import shutil
import sys
from datetime import date

from . import asm_chest, catalog, drift, harvest, layers, library, rename

BASE = (r"G:\Shared drives\Harris Timberworks\BlueBeam Templates & Config")
CHESTS = os.path.join(BASE, "HTW Estimating Tool Chest & Custom Columns")
LIB = os.path.join(BASE, "HTW Factor Library.xlsx")
CATALOG = os.path.join(BASE, "tool_catalog.json")


def main():
    today = date.today().isoformat()
    backup = os.path.join(CHESTS, f"backup-{today}")

    if os.path.exists(backup):
        print(f"REFUSING: backup dir {backup} already exists "
              f"(was phase 2 already run today?)")
        sys.exit(2)
    os.makedirs(backup)
    for p in glob.glob(os.path.join(CHESTS, "*.btx")):
        shutil.copy2(p, backup)
    print(f"backed up {len(os.listdir(backup))} chest files -> {backup}")

    changed = layers.apply(CHESTS)
    print(f"layers: {len(changed)} tool assignments rewritten")

    result = rename.rename_everywhere(CHESTS, LIB, "SHIPPING ", "SHIPPING")
    print(f"SHIPPING rename: {result}")

    asm_path = asm_chest.build(CHESTS)
    print(f"ASSEMBLIES chest written -> {asm_path}")

    rows = library.load_factors(LIB)
    existing_subjects = {r.subject for r in rows}
    new_rows = [r for r in asm_chest.library_rows(source_date=today)
                if r.subject not in existing_subjects]
    library.write_factors(LIB, rows + new_rows)
    library.append_changelog(LIB, version=f"phase2-{today}",
                             author="phase 2 runner",
                             change=f"layers applied, SHIPPING renamed, "
                                    f"{len(new_rows)} ASM rows added",
                             date=today)
    print(f"library: {len(new_rows)} ASM rows added")

    rows = library.load_factors(LIB)
    report = drift.check(CHESTS, rows)
    print(f"drift clean: {report.clean}")
    if not report.clean:
        print("  mismatches:", report.price_mismatches)
        print("  tools missing:", report.tools_missing_from_library)
        print("  lib missing:", report.library_missing_from_chests)
        sys.exit(1)

    catalog.build(CHESTS, rows, CATALOG, version=f"phase2-{today}")
    print(f"catalog regenerated -> {CATALOG}")


if __name__ == "__main__":
    main()
