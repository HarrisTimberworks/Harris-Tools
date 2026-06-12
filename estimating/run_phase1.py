"""Phase 1 live run: harvest -> library v1, drift check, catalog.
Read-only against chests (harvest/catalog); does NOT sync presets."""
import sys
from datetime import date

from . import drift, harvest, library, catalog

CHESTS = (r"G:\Shared drives\Harris Timberworks\BlueBeam Templates & Config"
          r"\HTW Estimating Tool Chest & Custom Columns")
LIB = (r"G:\Shared drives\Harris Timberworks\BlueBeam Templates & Config"
       r"\HTW Factor Library.xlsx")
CATALOG = (r"G:\Shared drives\Harris Timberworks\BlueBeam Templates & Config"
           r"\tool_catalog.json")


def main():
    today = date.today().isoformat()
    library.create_library(LIB)
    rows = harvest.harvest_to_library(CHESTS, LIB, line="R",
                                      source_date=today)
    print(f"library seeded: {len(rows)} rows -> {LIB}")
    report = drift.check(CHESTS, rows)
    print(f"drift clean: {report.clean}")
    if not report.clean:
        print("  mismatches:", report.price_mismatches)
        print("  tools missing:", report.tools_missing_from_library)
        print("  lib missing:", report.library_missing_from_chests)
        sys.exit(1)
    catalog.build(CHESTS, rows, CATALOG, version=f"harvest-{today}")
    print(f"catalog written -> {CATALOG}")


if __name__ == "__main__":
    main()
