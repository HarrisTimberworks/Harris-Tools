import json

from estimating import catalog, library


def test_catalog_merges_chests_and_library(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF", [
        {"subject": "A", "unit": "SF", "uc": "26.94", "layer": "CASE"},
    ])
    rows = [library.FactorRow("A", "R", "CASE & FF", "SF", 26.94,
                              "active", "src", "2026-06-10", "")]
    out = tmp_path / "tool_catalog.json"
    catalog.build(tmp_path, rows, out)
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["version"]
    entry = data["tools"][0]
    assert entry == {
        "subject": "A",
        "chest": "HTW-R 01 CASE & FF",
        "category": "CASE & FF",
        "measurement": "SF",
        "layer": "CASE",
        "raw_cost": 26.94,
        "status": "active",
    }


def test_catalog_marks_tools_without_library_rows(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF",
               [{"subject": "ORPHAN", "unit": "EA", "uc": "1.00"}])
    out = tmp_path / "tool_catalog.json"
    catalog.build(tmp_path, [], out)
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["tools"][0]["status"] == "missing-from-library"
