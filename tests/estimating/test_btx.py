import pytest

from estimating import btx


def test_read_toolset_parses_title_and_tools(make_chest):
    p = make_chest("HTW-R 01 CASE & FF", [
        {"subject": "CASE - Test - SF", "unit": "SF", "uc": "26.94"},
        {"subject": "DRW - Test - EA", "unit": "EA", "uc": "125.00",
         "layer": "INS"},
    ])
    ts = btx.read_toolset(p)
    assert ts.title == "HTW-R 01 CASE & FF"
    assert [t.subject for t in ts.tools] == ["CASE - Test - SF",
                                             "DRW - Test - EA"]
    assert ts.tools[0].unit == "SF"
    assert ts.tools[1].unit == "EA"
    assert ts.tools[1].layer == "INS"
    assert ts.tools[0].layer is None


def test_presets_read_from_six_slot_array(make_chest):
    p = make_chest("X", [{"subject": "A", "unit": "LF", "uc": "13.20"}])
    t = btx.read_toolset(p).tools[0]
    assert t.preset_unit_cost == "13.20"


def test_empty_preset_reads_as_none(make_chest):
    p = make_chest("X", [{"subject": "A", "unit": "LF", "uc": None}])
    assert btx.read_toolset(p).tools[0].preset_unit_cost is None


def test_set_preset_and_write_roundtrip(make_chest, tmp_path):
    p = make_chest("X", [{"subject": "A", "unit": "LF", "uc": "10.00"},
                         {"subject": "B", "unit": "EA", "uc": "5.00"}])
    ts = btx.read_toolset(p)
    btx.set_preset_unit_cost(ts.tools[0], "12.50")
    out = tmp_path / "out.btx"
    btx.write_toolset(ts, out)
    ts2 = btx.read_toolset(out)
    assert ts2.tools[0].preset_unit_cost == "12.50"
    assert ts2.tools[1].preset_unit_cost == "5.00"   # untouched
    assert ts2.title == "X"
    assert ts2.tools[0].subject == "A"


def test_set_preset_refuses_non_six_slot_array(make_chest):
    p = make_chest("X", [{"subject": "A", "unit": "LF", "uc": "10.00"}])
    ts = btx.read_toolset(p)
    ts.tools[0].col_tokens = ["()"] * 20   # simulate legacy 20-slot tool
    try:
        btx.set_preset_unit_cost(ts.tools[0], "1.00")
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_set_preset_rejects_delimiter_characters(make_chest):
    p = make_chest("X", [{"subject": "A", "unit": "LF", "uc": "10.00"}])
    ts = btx.read_toolset(p)
    with pytest.raises(ValueError, match="delimiters"):
        btx.set_preset_unit_cost(ts.tools[0], "8.50 (material)")
