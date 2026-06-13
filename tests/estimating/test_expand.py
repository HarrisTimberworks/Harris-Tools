import pytest
from estimating import expand


def test_parse_scalar_params():
    assert expand.parse_params("W=36 H=84 D=24 SH=3") == {
        "W": 36.0, "H": 84.0, "D": 24.0, "SH": 3.0, "panels": []}


def test_parse_decimals_and_extra_space():
    assert expand.parse_params("D=24.5   H=34.5") == {
        "D": 24.5, "H": 34.5, "panels": []}


def test_parse_closet_panels():
    p = expand.parse_params("D=14 P=84x24 P=84x18")
    assert p["D"] == 14.0
    assert p["panels"] == [(84.0, 24.0), (84.0, 18.0)]


def test_parse_empty_is_empty():
    assert expand.parse_params("") == {"panels": []}
    assert expand.parse_params(None) == {"panels": []}


def test_parse_rejects_malformed_token():
    with pytest.raises(ValueError, match="cannot parse"):
        expand.parse_params("W=36 GARBAGE H=84")


def test_interior_sf_worked_example():
    # W=36 H=84 D=24 SH=3:
    # back 36*84=3024 + sides 2*24*84=4032 + top 36*24=864 + bottom 864
    # + shelves 3*36*24*2=5184  => 13968 in^2 / 144 = 97.0 SF
    assert expand.interior_one_sided_sf(36, 84, 24, 3) == pytest.approx(97.0)


def test_interior_sf_zero_shelves():
    # back 3024 + sides 4032 + top 864 + bottom 864 = 8784 /144 = 61.0
    assert expand.interior_one_sided_sf(36, 84, 24, 0) == pytest.approx(61.0)


def test_finished_end_sf():
    # D=24 H=84 -> 2016 in^2 /144 = 14.0 SF
    assert expand.finished_end_sf(24, 84) == pytest.approx(14.0)


def test_faux_door_sf():
    # FF FE: (24-3)*(84-3) = 21*81 = 1701 /144 = 11.8125 SF
    assert expand.faux_door_sf(24, 84) == pytest.approx(11.8125)


def test_parse_rejects_truncated_panel():
    with pytest.raises(ValueError, match="panel token"):
        expand.parse_params("D=14 P=84")


def test_parse_rejects_unknown_key():
    with pytest.raises(ValueError, match="unknown param key"):
        expand.parse_params("W=36 SN=3")


def test_faux_door_rejects_tiny_dims():
    with pytest.raises(ValueError):
        expand.faux_door_sf(2, 84)   # D<=3 -> would be negative


def test_finished_end_rejects_nonpositive():
    with pytest.raises(ValueError):
        expand.finished_end_sf(0, 84)


def test_interior_rejects_nonpositive_but_allows_zero_shelves():
    expand.interior_one_sided_sf(36, 84, 24, 0)   # ok
    with pytest.raises(ValueError):
        expand.interior_one_sided_sf(0, 84, 24, 2)


FACTORS = {
    "FF FinEnds - Flush": 35.0,
    "FF FinEnds - FF FE (*Add Door Sf)": 60.0,
    "FIN - Stain (1 Sided)": 2.0,
    "DOOR - Slab - Paint Grade": 18.0,
    "Panels - Paint Grade": 9.0,
}
JOB = {"finish_subject": "FIN - Stain (1 Sided)",
       "door_subject": "DOOR - Slab - Paint Grade",
       "panel_subject": "Panels - Paint Grade"}


def _by_subject(items):
    return {i.subject: i for i in items}


def test_expand_frameless_end():
    items = expand.expand_frameless_end({"D": 24, "H": 84}, FACTORS, JOB)
    assert len(items) == 1
    fin = items[0]
    assert fin.subject == "FIN - Stain (1 Sided)"
    assert fin.qty == pytest.approx(14.0)
    assert fin.unit == "SF"
    assert fin.raw_total == pytest.approx(28.0)


def test_expand_ff_flush_end():
    items = expand.expand_ff_flush_end({"D": 24, "H": 84}, FACTORS, JOB)
    bs = _by_subject(items)
    assert bs["FF FinEnds - Flush"].qty == 1
    assert bs["FF FinEnds - Flush"].unit == "EA"
    assert bs["FF FinEnds - Flush"].raw_total == pytest.approx(35.0)
    assert bs["FIN - Stain (1 Sided)"].raw_total == pytest.approx(28.0)


def test_expand_ff_fe_end():
    items = expand.expand_ff_fe_end({"D": 24, "H": 84}, FACTORS, JOB)
    bs = _by_subject(items)
    assert bs["FF FinEnds - FF FE (*Add Door Sf)"].raw_total == pytest.approx(60.0)
    door = bs["DOOR - Slab - Paint Grade"]
    assert door.qty == pytest.approx(11.8125)
    assert door.raw_total == pytest.approx(212.625)
    assert "FIN - Stain (1 Sided)" not in bs


def test_expand_open_interior():
    items = expand.expand_interior({"W": 36, "H": 84, "D": 24, "SH": 3},
                                   FACTORS, JOB)
    assert len(items) == 1
    assert items[0].subject == "FIN - Stain (1 Sided)"
    assert items[0].qty == pytest.approx(97.0)
    assert items[0].raw_total == pytest.approx(194.0)


def test_expand_closet_run_material():
    items = expand.expand_closet_run(
        {"D": 14, "panels": [(84, 24), (84, 18)]}, FACTORS, JOB)
    bs_panel = [i for i in items if i.subject == "Panels - Paint Grade"]
    total_panel_sf = sum(i.qty for i in bs_panel)
    assert total_panel_sf == pytest.approx(24.5)


def test_missing_factor_raises():
    with pytest.raises(KeyError, match="not in factor library"):
        expand.expand_frameless_end({"D": 24, "H": 84}, {}, JOB)


def test_dispatch_routes_each_subject():
    cases = {
        "ASM - Finished End (Frameless) - EA": "D=24 H=84",
        "ASM - Finished End (FF Flush) - EA": "D=24 H=84",
        "ASM - Finished End (FF FE) - EA": "D=24 H=84",
        "ASM - Open Interior - EA": "W=36 H=84 D=24 SH=3",
        "ASM - Glass Door Interior - EA": "W=36 H=84 D=24 SH=3",
        "ASM - Closet Run - EA": "D=14 P=84x24",
    }
    for subject, params in cases.items():
        items = expand.expand_marker(subject, params, FACTORS, JOB)
        assert items and all(i.raw_total >= 0 for i in items)


def test_dispatch_unknown_subject_raises():
    with pytest.raises(ValueError, match="no expander"):
        expand.expand_marker("ASM - Mystery - EA", "D=1 H=1", FACTORS, JOB)


def test_glass_equals_open():
    a = expand.expand_marker("ASM - Open Interior - EA",
                             "W=36 H=84 D=24 SH=3", FACTORS, JOB)
    b = expand.expand_marker("ASM - Glass Door Interior - EA",
                             "W=36 H=84 D=24 SH=3", FACTORS, JOB)
    assert a[0].raw_total == b[0].raw_total
