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
        "color": "#0080FF",
        "params": None,
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


def test_catalog_version_flows_through_and_dupes_detected(make_chest,
                                                          tmp_path):
    make_chest("HTW-R 01 AAA", [{"subject": "X", "unit": "EA",
                                 "uc": "1.00"}])
    make_chest("HTW-R 02 BBB", [{"subject": "X", "unit": "EA",
                                 "uc": "2.00"}])
    out = tmp_path / "tool_catalog.json"
    data = catalog.build(tmp_path, [], out, version="v-test")
    assert data["version"] == "v-test"
    assert data["duplicate_subjects"] == ["X"]
    assert len(data["tools"]) == 2


def test_catalog_no_dupes_is_empty_list(make_chest, tmp_path):
    make_chest("HTW-R 01 AAA", [{"subject": "X", "unit": "EA",
                                 "uc": "1.00"}])
    out = tmp_path / "tool_catalog.json"
    data = catalog.build(tmp_path, [], out, version="v")
    assert data["duplicate_subjects"] == []


def test_catalog_includes_asm_params(tmp_path):
    from estimating import asm_chest
    asm_chest.build(tmp_path)
    out = tmp_path / "tool_catalog.json"
    data = catalog.build(tmp_path, [], out, version="v")
    by_subject = {t["subject"]: t for t in data["tools"]}
    assert by_subject["ASM - Open Interior - EA"]["params"] == \
        ["W", "H", "D", "SH"]
    assert by_subject["ASM - Closet Run - EA"]["params"] == ["D", "P"]
