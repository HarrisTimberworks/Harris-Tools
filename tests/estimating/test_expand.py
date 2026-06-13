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
