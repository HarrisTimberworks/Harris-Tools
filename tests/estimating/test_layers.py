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


def test_apply_verify_failure_carries_partial_changes(make_chest, tmp_path,
                                                      monkeypatch):
    import pytest
    from estimating import btx
    make_chest("HTW-R 01 CASE & FF", [{"subject": "A", "unit": "EA",
                                       "uc": "1.00"}])
    make_chest("HTW-R 06 TRIM", [{"subject": "B", "unit": "EA",
                                  "uc": "1.00"}])
    real_read = btx.read_toolset
    calls = {"n": 0}

    def flaky_read(path):
        ts = real_read(path)
        # let the first chest's write+verify pass; corrupt the verify
        # re-read of the SECOND chest by blanking its tool layers
        if "TRIM" in str(path):
            calls["n"] += 1
            if calls["n"] > 1:                  # 1st read = pre-write; 2nd = verify
                for t in ts.tools:
                    t.layer = None
        return ts

    monkeypatch.setattr(btx, "read_toolset", flaky_read)
    with pytest.raises(layers.LayerVerifyError) as exc:
        layers.apply(tmp_path)
    # CASE chest verified before TRIM failed
    assert exc.value.verified_changes == [
        ("HTW-R 01 CASE & FF", "A", None, "CASE")]
    assert "TRIM" in str(exc.value.failed_path)
