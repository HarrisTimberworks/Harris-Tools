from estimating import btx, library, rename


def test_rename_updates_chest_and_library(make_chest, tmp_path):
    p = make_chest("HTW-R 10 SPECIALTY & MISC",
                   [{"subject": "SHIPPING ", "unit": "EA", "uc": "0.00"}])
    lib = tmp_path / "lib.xlsx"
    library.create_library(lib)
    library.write_factors(lib, [library.FactorRow(
        "SHIPPING ", "R", "SPECIALTY & MISC", "EA", 0.0, "active",
        "harvest", "2026-06-11", "")])
    result = rename.rename_everywhere(tmp_path, lib, "SHIPPING ", "SHIPPING")
    assert result == {"chest_tools": 1, "library_rows": 1}
    assert btx.read_toolset(p).tools[0].subject == "SHIPPING"
    assert library.load_factors(lib)[0].subject == "SHIPPING"


def test_rename_errors_when_subject_not_found(make_chest, tmp_path):
    make_chest("HTW-R 09 LED", [{"subject": "A", "unit": "EA",
                                 "uc": "1.00"}])
    lib = tmp_path / "lib.xlsx"
    library.create_library(lib)
    import pytest
    with pytest.raises(ValueError, match="not found"):
        rename.rename_everywhere(tmp_path, lib, "NOPE", "X")
