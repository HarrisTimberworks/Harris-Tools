import pytest
from estimating import library


def test_create_then_load_roundtrip(tmp_path):
    p = tmp_path / "lib.xlsx"
    library.create_library(p)
    rows = [
        library.FactorRow(subject="DRW - Solid Maple", line="R",
                          category="CASE & FF", unit="EA",
                          raw_cost=125.00, status="active",
                          source="tool preset harvest",
                          source_date="2026-06-10", notes=""),
    ]
    library.write_factors(p, rows)
    loaded = library.load_factors(p)
    assert len(loaded) == 1
    assert loaded[0].subject == "DRW - Solid Maple"
    assert loaded[0].raw_cost == 125.00
    assert loaded[0].status == "active"


def test_validate_rejects_duplicate_subjects(tmp_path):
    rows = [
        library.FactorRow("A", "R", "X", "EA", 1.0, "active", "", "", ""),
        library.FactorRow("A", "C", "Y", "LF", 2.0, "active", "", "", ""),
    ]
    with pytest.raises(ValueError, match="duplicate"):
        library.validate(rows)


def test_validate_rejects_bad_status():
    rows = [library.FactorRow("A", "R", "X", "EA", 1.0, "maybe", "", "", "")]
    with pytest.raises(ValueError, match="status"):
        library.validate(rows)


def test_changelog_appends(tmp_path):
    p = tmp_path / "lib.xlsx"
    library.create_library(p)
    library.append_changelog(p, version="v1", author="test",
                             change="seeded", date="2026-06-10")
    assert library.latest_version(p) == "v1"
