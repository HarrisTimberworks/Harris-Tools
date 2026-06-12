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


def test_load_tolerates_short_rows_and_text_costs(tmp_path):
    import openpyxl
    p = tmp_path / "lib.xlsx"
    library.create_library(p)
    wb = openpyxl.load_workbook(p)
    ws = wb["Factors"]
    ws.append(["Short Row", "R", "X", "EA", 5])   # only 5 of 9 cells
    wb.save(p)
    loaded = library.load_factors(p)
    assert loaded[0].subject == "Short Row"
    assert loaded[0].raw_cost == 5.0
    assert loaded[0].notes == ""


def test_load_rejects_text_cost_with_clear_error(tmp_path):
    import openpyxl
    p = tmp_path / "lib.xlsx"
    library.create_library(p)
    wb = openpyxl.load_workbook(p)
    wb["Factors"].append(["Bad", "R", "X", "EA", "$125.00",
                          "active", "", "", ""])
    wb.save(p)
    with pytest.raises(ValueError, match="not a number"):
        library.load_factors(p)


def test_validate_rejects_negative_cost_but_allows_zero():
    ok = [library.FactorRow("A", "R", "X", "EA", 0.0, "provisional",
                            "", "", "")]
    library.validate(ok)   # zero is fine (unpriced provisional)
    bad = [library.FactorRow("B", "R", "X", "EA", -1.0, "active",
                             "", "", "")]
    with pytest.raises(ValueError, match="raw_cost"):
        library.validate(bad)


def test_validate_rejects_bad_line():
    rows = [library.FactorRow("A", "Z", "X", "EA", 1.0, "active",
                              "", "", "")]
    with pytest.raises(ValueError, match="line"):
        library.validate(rows)
