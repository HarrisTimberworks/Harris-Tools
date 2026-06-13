"""Dart reconciliation harness — sanity checks for expansion engine against
historical takeoffs. The Andrea Dart archive is pre-ASM markup data; we extract
finish-related markups and print them alongside illustrative engine outputs
so estimators can eyeball whether the formulas produce reasonable numbers."""

import json
from pathlib import Path
from . import expand, library as libmod


def load_dart_archive(archive_path):
    """Load the Dart JSON archive — dict of markupId -> {subject, ...}."""
    with open(archive_path) as f:
        return json.load(f)


def find_finish_markups(archive):
    """Filter archive to markups likely related to finish (subject contains 'FIN'
    or indicates a measurement context). Pre-ASM, so no ASM markers present."""
    finish_related = []
    for markup_id, markup_data in archive.items():
        subject = markup_data.get("subject", "")
        # Include any markup with 'FIN' in subject, or with a Measurement value
        if "FIN" in subject.upper() or markup_data.get("Measurement"):
            finish_related.append({
                "id": markup_id,
                "subject": subject,
                "measurement": markup_data.get("Measurement"),
            })
    return finish_related


def illustrative_expansions():
    """Generate sample engine outputs for representative cabinet dimensions."""
    # Sample rates: must match RULEBOOK.md examples
    factors = {
        "FIN - Stain (1 Sided)": 2.0,
        "DOOR - Slab - Paint Grade": 18.0,
        "Panels - Paint Grade": 9.0,
        "FF FinEnds - Flush": 35.0,
        "FF FinEnds - FF FE (*Add Door Sf)": 60.0,
    }
    job = {
        "finish_subject": "FIN - Stain (1 Sided)",
        "door_subject": "DOOR - Slab - Paint Grade",
        "panel_subject": "Panels - Paint Grade",
    }

    cases = [
        ("Base Open Interior", "ASM - Open Interior - EA", "W=36 H=34.5 D=24 SH=2"),
        ("Upper Open Interior", "ASM - Open Interior - EA", "W=30 H=42 D=12 SH=3"),
        ("Finished End (Frameless)", "ASM - Finished End (Frameless) - EA", "D=24 H=84"),
    ]

    results = []
    for label, subject, params_str in cases:
        try:
            items = expand.expand_marker(subject, params_str, factors, job)
            total = sum(item.raw_total for item in items)
            results.append({
                "label": label,
                "params": params_str,
                "items": items,
                "total": total,
            })
        except Exception as e:
            results.append({
                "label": label,
                "params": params_str,
                "error": str(e),
            })
    return results


def main():
    """Load archive, extract finish markups, print sanity tables."""
    print("=" * 70)
    print("Dart Reconciliation Harness — Expansion Engine Sanity Check")
    print("=" * 70)
    print()

    # Load archive
    archive_path = Path(__file__).parent.parent / ".claude" / "tmp" / "dart_cull" / \
                   "andrea_dart_16col_pre_cull_archive.json"
    if not archive_path.exists():
        print(f"ERROR: Archive not found at {archive_path}")
        return

    archive = load_dart_archive(archive_path)
    print(f"Loaded {len(archive)} markups from Andrea Dart archive.")
    print()

    # Extract finish-related markups
    finish_markups = find_finish_markups(archive)
    print(f"Found {len(finish_markups)} finish-related markups (contains 'FIN' or has Measurement):")
    print()

    # Print a sample table (limit to 20 for readability)
    print("Sample Finish-Related Markups:")
    print("-" * 70)
    print(f"{'ID':<25} {'Subject':<30} {'Measurement':<10}")
    print("-" * 70)
    for markup in finish_markups[:20]:
        measurement = markup["measurement"] or "-"
        print(f"{markup['id']:<25} {markup['subject']:<30} {str(measurement):<10}")
    if len(finish_markups) > 20:
        print(f"... and {len(finish_markups) - 20} more")
    print()

    # Generate and print illustrative expansions
    print("=" * 70)
    print("Illustrative Engine Outputs (Sample Rates)")
    print("=" * 70)
    print("Rates: FIN $2/SF, Door $18/SF, Panel $9/SF, FF Flush $35/EA, FF FE $60/EA")
    print()

    expansions = illustrative_expansions()
    for exp in expansions:
        print("-" * 70)
        print(f"Case: {exp['label']}")
        print(f"Params: {exp['params']}")
        if "error" in exp:
            print(f"ERROR: {exp['error']}")
        else:
            print()
            for item in exp["items"]:
                print(f"  {item.component:<35} {item.qty:>10.4f} {item.unit:<3}  "
                      f"@ ${item.raw_unit:>7.2f}  =  ${item.raw_total:>10.2f}")
            print(f"  {'TOTAL':<35} {'':<10} {'':<3}  "
                  f"{'':>7}     ${exp['total']:>10.2f}")
        print()

    # Summary note
    print("=" * 70)
    print("SANITY HARNESS — NO HARD PASS/FAIL")
    print("=" * 70)
    print()
    print("This harness is illustrative: it shows that the engine works end-to-end")
    print("and produces reasonable numbers for representative cabinet dimensions.")
    print()
    print("It extracts finish-related markups from the Dart archive (pre-ASM, so no")
    print("automatic expansion), allowing estimators to eyeball the formulas against")
    print("historical judgment.")
    print()
    print("The real golden test comes in Phase 4, once ASM markers are present on")
    print("measured residential jobs and can be expanded end-to-end with the engine.")
    print()


if __name__ == "__main__":
    main()
