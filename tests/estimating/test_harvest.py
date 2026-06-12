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
