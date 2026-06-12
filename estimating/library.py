"""HTW Factor Library xlsx: canonical Subject-keyed raw-cost rates."""
from dataclasses import dataclass, astuple

import openpyxl

FACTOR_HEADERS = ["Subject", "Line", "Category", "Unit", "Raw Cost",
                  "Status", "Source", "Source Date", "Notes"]
VENDOR_HEADERS = ["Vendor", "Preferred Source", "Discount Multiplier",
                  "Notes"]
CHANGELOG_HEADERS = ["Date", "Version", "Author", "Change"]
VALID_STATUS = {"active", "provisional", "retired"}
VALID_LINE = {"R", "C", "Both"}


@dataclass
class FactorRow:
    subject: str
    line: str
    category: str
    unit: str
    raw_cost: float
    status: str
    source: str
    source_date: str
    notes: str


def create_library(path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Factors"
    ws.append(FACTOR_HEADERS)
    wb.create_sheet("Vendors").append(VENDOR_HEADERS)
    wb.create_sheet("Changelog").append(CHANGELOG_HEADERS)
    wb.save(path)


def validate(rows):
    seen = set()
    for r in rows:
        if r.subject in seen:
            raise ValueError(f"duplicate subject: {r.subject!r}")
        seen.add(r.subject)
        if r.status not in VALID_STATUS:
            raise ValueError(f"bad status {r.status!r} on {r.subject!r}")
        if r.line not in VALID_LINE:
            raise ValueError(f"bad line {r.line!r} on {r.subject!r}")


def write_factors(path, rows):
    validate(rows)
    wb = openpyxl.load_workbook(path)
    ws = wb["Factors"]
    ws.delete_rows(2, ws.max_row)
    for r in rows:
        ws.append(astuple(r))
    wb.save(path)


def load_factors(path):
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb["Factors"]
    rows = []
    for vals in ws.iter_rows(min_row=2, values_only=True):
        if vals[0] is None:
            continue
        rows.append(FactorRow(*[
            v if v is not None else "" for v in vals[:9]]))
    wb.close()
    return rows


def append_changelog(path, *, version, author, change, date):
    wb = openpyxl.load_workbook(path)
    wb["Changelog"].append([date, version, author, change])
    wb.save(path)


def latest_version(path):
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb["Changelog"]
    version = None
    for vals in ws.iter_rows(min_row=2, values_only=True):
        if vals[1] is not None:
            version = vals[1]
    wb.close()
    return version
