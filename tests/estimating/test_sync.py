from estimating import btx, drift, library, sync


def _row(subject, cost):
    return library.FactorRow(subject, "R", "X", "EA", cost, "active",
                             "", "", "")


def test_sync_rewrites_presets_to_match_library(make_chest, tmp_path):
    p = make_chest("HTW-R 01 CASE & FF", [
        {"subject": "A", "unit": "EA", "uc": "10.00"},
        {"subject": "B", "unit": "EA", "uc": "5.00"},
    ])
    changed = sync.sync_presets(tmp_path, [_row("A", 12.00), _row("B", 5.00)])
    assert changed == [("A", "10.00", "12.00")]
    ts = btx.read_toolset(p)
    assert ts.tools[0].preset_unit_cost == "12.00"
    assert ts.tools[1].preset_unit_cost == "5.00"
    assert drift.check(tmp_path, [_row("A", 12.00), _row("B", 5.00)]).clean


def test_sync_skips_retired_and_unknown(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF",
               [{"subject": "A", "unit": "EA", "uc": "10.00"}])
    rows = [library.FactorRow("A", "R", "X", "EA", 99.0, "retired",
                              "", "", "")]
    changed = sync.sync_presets(tmp_path, rows)
    assert changed == []
