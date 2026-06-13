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
