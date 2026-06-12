from estimating import btx, layers


def test_audit_reports_current_assignments(make_chest, tmp_path):
    make_chest("HTW-R 06 TRIM", [
        {"subject": "T1", "unit": "LF", "uc": "1.00", "layer": "Case"},
        {"subject": "T2", "unit": "LF", "uc": "1.00"},
    ])
    report = layers.audit(tmp_path)
    assert report["HTW-R 06 TRIM"] == {"T1": "Case", "T2": None}


def test_apply_sets_chest_layer_on_every_tool(make_chest, tmp_path):
    p = make_chest("HTW-R 06 TRIM", [
        {"subject": "T1", "unit": "LF", "uc": "1.00", "layer": "Case"},
        {"subject": "T2", "unit": "LF", "uc": "1.00"},
    ])
    changed = layers.apply(tmp_path)
    assert changed == [("HTW-R 06 TRIM", "T1", "Case", "TRIM"),
                      ("HTW-R 06 TRIM", "T2", None, "TRIM")]
    ts = btx.read_toolset(p)
    assert [t.layer for t in ts.tools] == ["TRIM", "TRIM"]


def test_apply_skips_already_correct(make_chest, tmp_path):
    make_chest("HTW-R 09 LED", [
        {"subject": "L1", "unit": "LF", "uc": "1.00", "layer": "LED"},
    ])
    assert layers.apply(tmp_path) == []


def test_apply_refuses_unknown_chest_title(make_chest, tmp_path):
    make_chest("HTW-R 12 MYSTERY", [
        {"subject": "M1", "unit": "EA", "uc": "1.00"},
    ])
    import pytest
    with pytest.raises(KeyError, match="MYSTERY"):
        layers.apply(tmp_path)
