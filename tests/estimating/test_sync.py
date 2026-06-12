import pytest

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


def test_sync_skips_provisional_rows(make_chest, tmp_path):
    p = make_chest("HTW-R 01 AAA", [{"subject": "A", "unit": "EA",
                                     "uc": None}])
    rows = [library.FactorRow("A", "R", "X", "EA", 0.0, "provisional",
                              "", "", "")]
    assert sync.sync_presets(tmp_path, rows) == []
    assert btx.read_toolset(p).tools[0].preset_unit_cost is None


def test_sync_reread_failure_raises_sync_verify_error(make_chest, tmp_path,
                                                      monkeypatch):
    import pytest
    make_chest("HTW-R 01 AAA", [{"subject": "A", "unit": "EA",
                                 "uc": "1.00"}])
    real_read = btx.read_toolset
    calls = {"n": 0}

    def flaky_read(path):
        calls["n"] += 1
        if calls["n"] > 1:          # first read OK, verify re-read fails
            raise ValueError("corrupt")
        return real_read(path)

    monkeypatch.setattr(btx, "read_toolset", flaky_read)
    with pytest.raises(sync.SyncVerifyError) as exc:
        sync.sync_presets(tmp_path, [_row("A", 9.00)])
    assert exc.value.verified_changes == []
    assert "AAA" in str(exc.value.failed_path)


def test_sync_failure_carries_verified_changes(make_chest, tmp_path,
                                               monkeypatch):
    make_chest("HTW-R 01 AAA", [{"subject": "A", "unit": "EA",
                                 "uc": "1.00"}])
    make_chest("HTW-R 02 BBB", [{"subject": "B", "unit": "EA",
                                 "uc": "2.00"}])
    real_write = btx.write_toolset

    def flaky_write(ts, path):
        if "BBB" in str(path):
            return   # simulate lost write: file on disk keeps old value
        real_write(ts, path)

    monkeypatch.setattr(btx, "write_toolset", flaky_write)
    with pytest.raises(sync.SyncVerifyError) as exc:
        sync.sync_presets(tmp_path, [_row("A", 9.00), _row("B", 8.00)])
    assert exc.value.verified_changes == [("A", "1.00", "9.00")]
    assert "BBB" in str(exc.value.failed_path)
