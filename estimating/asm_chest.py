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

# ---------------------------------------------------------------------------
# Real appearance resource cloned from a live Count tool in HTW-R 09 LED.btx.
# RES_ID_HEX  — zlib-compressed ID string "XVBBLLRKXOKRTMUX"
# RES_DATA_HEX — zlib-compressed XObject appearance stream (228 bytes decoded)
# AP_FRAGMENT  — /AP entry for the annotation dict referencing the same ID
# All six ASM markers share this one resource; sharing one valid resource is
# far better than six fake ones that Revu may reject.
# ---------------------------------------------------------------------------
RES_ID_HEX = (
    "789c8b087372f2f109f28ef0f70e0af10d8d000029b904fa"
)
RES_DATA_HEX = (
    "789c554ecb0e823010bcf72bf60bfa124849080762f0a291800713c201b08246"
    "a82925e2dfdbc2c93d4c7666323b1b45e428c7cef4200272f9be25b99e9ba76c"
    "0d29e6c6389e2a3dace05c602449d45252a0c03dec0be105c039f62b92cb49cd"
    "ba95933d9969d516d29424dba7551c93536df4632919b8dc8a564593d1b21e90"
    "65d8a72c0ca8b05e7eb0f607fe45dd01e398871edf01133080ada676985be005"
    "9c62babeb2d11eee80901c6f5bc30fa8823d68"
)
AP_FRAGMENT = "/AP<</N/BBObjPtr_XVBBLLRKXOKRTMUX>>"


def _escape(s):
    return s.replace("(", "\\(").replace(")", "\\)")


def _marker_raw(subject, template):
    return (
        "<</Version 1"
        f"{AP_FRAGMENT}"
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
        ET.SubElement(res, "ID").text = RES_ID_HEX
        ET.SubElement(res, "Data").text = RES_DATA_HEX
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
