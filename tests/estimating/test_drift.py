from estimating import drift, library


def _row(subject, cost):
    return library.FactorRow(subject, "R", "X", "EA", cost, "active",
                             "", "", "")


def test_drift_reports_mismatch_and_missing(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF", [
        {"subject": "A", "unit": "EA", "uc": "10.00"},
        {"subject": "B", "unit": "EA", "uc": "5.00"},
    ])
    rows = [_row("A", 12.00), _row("C", 3.00)]
    report = drift.check(tmp_path, rows)
    assert ("A", 10.00, 12.00) in report.price_mismatches
    assert "B" in report.tools_missing_from_library
    assert "C" in report.library_missing_from_chests


def test_no_drift_is_clean(make_chest, tmp_path):
    make_chest("HTW-R 01 CASE & FF",
               [{"subject": "A", "unit": "EA", "uc": "10.00"}])
    report = drift.check(tmp_path, [_row("A", 10.00)])
    assert report.clean
