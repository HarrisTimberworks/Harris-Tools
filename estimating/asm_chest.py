"""Generate the HTW-R 11 ASSEMBLIES chest: six count-type ASM markers.

Markers carry NO preset price (expansion engine prices them in Phase 3);
their Comment ships the parameter template the placer fills in."""
import os
import xml.etree.ElementTree as ET
import zlib

from . import library

TITLE = "HTW-R 11 ASSEMBLIES"
COUNT_TYPE = "Bluebeam.PDF.Annotations.AnnotationMeasureCount"
MARKERS = [
    ("ASM - Finished End (FF Flush) - EA", "D__ H__"),
    ("ASM - Finished End (FF FE) - EA", "D__ H__"),
    ("ASM - Finished End (Frameless) - EA", "D__ H__"),
    ("ASM - Open Interior - EA", "W__ H__ D__ SH__"),
    ("ASM - Glass Door Interior - EA", "W__ H__ D__ SH__"),
    ("ASM - Closet Run - EA", "D__ P__x__ P__x__"),
]
IC = "1 0.4392157 0"        # orange — visually distinct review color


def _escape(s):
    return s.replace("(", "\\(").replace(")", "\\)")


def _marker_raw(subject, template):
    return (
        "<</Version 1"
        "/DS(font: Helvetica 12pt; text-align:center; "
        "line-height:13.8pt; color:#FF7000)"
        "/CountStyle/Checkmark/MeasurementTypes 128/NumCounts 1"
        "/IT/PolygonCount"
        "/Vertices[4.5 11.05393 6.538075 13.092 11.05611 8.569456 "
        "20.45741 17.97527 22.5 15.9417 11.06155 4.499999]"
        f"/IC[{IC}]"
        f"/Subj({_escape(subject)})"
        "/BSIColumnData[()()()()()()]"
        "/OC(ASM)"
        f"/Contents({_escape(template)})"
        "/Subtype/Polygon/Rect[0 0 27 22.47527]"
        "/C[1 0.4392157 0]/F 132"
        "/BS<</W 0/Type/Border/S/S>>>>"
    )


def build(out_dir):
    root = ET.Element("BluebeamRevuToolSet", {"Version": "1"})
    title = ET.SubElement(root, "Title")
    title.text = zlib.compress(TITLE.encode("utf-8")).hex()
    for subject, template in MARKERS:
        item = ET.SubElement(root, "ToolChestItem", {"Version": "1"})
        res = ET.SubElement(item, "Resources")
        ET.SubElement(res, "ID").text = "HTWASMMARKER"
        ET.SubElement(res, "Data").text = "00"
        ET.SubElement(item, "Name").text = "HTWASMMARKER"
        ET.SubElement(item, "Type").text = COUNT_TYPE
        raw = _marker_raw(subject, template)
        ET.SubElement(item, "Raw").text = zlib.compress(
            raw.encode("latin-1")).hex()
        ET.SubElement(item, "X").text = "0"
        ET.SubElement(item, "Y").text = "0"
        ET.SubElement(item, "Index").text = "4"
        ET.SubElement(item, "Mode").text = "properties"
    out_path = os.path.join(str(out_dir), f"{TITLE}.btx")
    xml_bytes = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    with open(out_path, "wb") as f:
        f.write(b"\xef\xbb\xbf" + xml_bytes)
    return out_path


def library_rows(*, source_date):
    return [library.FactorRow(
        subject=subject, line="R", category="ASSEMBLIES", unit="EA",
        raw_cost=0.0, status="active", source="asm chest generator",
        source_date=source_date,
        notes="assembly marker — expands via rulebook (spec §6)")
        for subject, _ in MARKERS]
