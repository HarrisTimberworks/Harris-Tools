import pytest

from estimating import harvest, library


def test_harvest_builds_rows_from_chests(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF", [
        {"subject": "CASE - A", "unit": "SF", "uc": "26.94"},
        {"subject": "DRW - B", "unit": "EA", "uc": "125.00"},
    ])
    make_chest("HTW-R 09 LED", [
        {"subject": "LED - C", "unit": "LF", "uc": "7.00"},
    ])
    rows = harvest.harvest_chests(tmp_path, line="R",
                                  source_date="2026-06-10")
    assert [r.subject for r in rows] == ["CASE - A", "DRW - B", "LED - C"]
    assert rows[0].category == "CASE & FF"
    assert rows[0].unit == "SF"
    assert rows[0].raw_cost == 26.94
    assert rows[0].status == "active"
    assert rows[2].category == "LED"


def test_harvest_flags_missing_preset_as_provisional_zero(make_chest,
                                                          tmp_path):
    make_chest("HTW-R 01 CASE & FF", [
        {"subject": "NO PRICE", "unit": "EA", "uc": None},
    ])
    rows = harvest.harvest_chests(tmp_path, line="R",
                                  source_date="2026-06-10")
    assert rows[0].raw_cost == 0.0
    assert rows[0].status == "provisional"


def test_end_to_end_harvest_to_xlsx(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF",
               [{"subject": "A", "unit": "EA", "uc": "1.50"}])
    lib = tmp_path / "lib.xlsx"
    library.create_library(lib)
    harvest.harvest_to_library(tmp_path, lib, line="R",
                               source_date="2026-06-10")
    loaded = library.load_factors(lib)
    assert loaded[0].subject == "A"
    assert library.latest_version(lib) == "harvest-2026-06-10"


def test_harvest_names_file_on_parse_failure(make_chest, tmp_path):
    bad = tmp_path / "HTW-R 02 BAD.btx"
    bad.write_bytes(b"\xef\xbb\xbfnot xml at all")
    with pytest.raises(RuntimeError, match="HTW-R 02 BAD"):
        harvest.harvest_chests(tmp_path, line="R", source_date="2026-06-10")


def test_harvest_preserves_other_lines(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF",
               [{"subject": "R1", "unit": "EA", "uc": "1.00"}])
    lib = tmp_path / "lib.xlsx"
    library.create_library(lib)
    commercial = library.FactorRow("C1", "C", "CASE", "LF", 9.0, "active",
                                   "deep dive", "2026-06-12", "")
    library.write_factors(lib, [commercial])
    harvest.harvest_to_library(tmp_path, lib, line="R",
                               source_date="2026-06-12")
    loaded = {r.subject: r for r in library.load_factors(lib)}
    assert set(loaded) == {"C1", "R1"}          # C row survived
    assert loaded["C1"].line == "C"
