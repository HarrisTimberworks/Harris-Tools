import xml.etree.ElementTree as ET
import zlib

import pytest

TYPE_MAP = {
    "LF": "Bluebeam.PDF.Annotations.AnnotationMeasurePolylength",
    "SF": "Bluebeam.PDF.Annotations.AnnotationMeasureArea",
    "EA": "Bluebeam.PDF.Annotations.AnnotationMeasureCount",
}


def _raw_dict(subject, uc, em="1.06", md="0.60", layer=None):
    oc = f"/OC({layer})" if layer else ""
    cols = f"({uc})({em})({md})()()()" if uc is not None else "()()()()()()"
    return (
        f"<</Subject 1/Vertices[0 0 1 1]/IC[0 0.5 1]"
        f"/Subj({subject})/BSIColumnData[{cols}]{oc}/Subtype/Polygon>>"
    )


@pytest.fixture
def make_chest(tmp_path):
    """Build a synthetic .btx. tools = list of dicts:
    {subject, unit('LF'|'SF'|'EA'), uc('12.34' or None), layer(optional)}"""

    def _make(name, tools):
        root = ET.Element("BluebeamRevuToolSet", {"Version": "1"})
        title = ET.SubElement(root, "Title")
        title.text = zlib.compress(name.encode("utf-8")).hex()
        for t in tools:
            item = ET.SubElement(root, "ToolChestItem", {"Version": "1"})
            res = ET.SubElement(item, "Resources")
            ET.SubElement(res, "ID").text = "FIXTUREID"
            ET.SubElement(res, "Data").text = "00"
            ET.SubElement(item, "Name").text = "FIXTURENAME"
            ET.SubElement(item, "Type").text = TYPE_MAP[t["unit"]]
            raw = _raw_dict(t["subject"], t.get("uc"), layer=t.get("layer"))
            ET.SubElement(item, "Raw").text = zlib.compress(
                raw.encode("latin-1")).hex()
            ET.SubElement(item, "X").text = "0"
            ET.SubElement(item, "Y").text = "0"
            ET.SubElement(item, "Index").text = "2"
            ET.SubElement(item, "Mode").text = "properties"
        path = tmp_path / f"{name}.btx"
        xml_bytes = ET.tostring(root, encoding="utf-8", xml_declaration=True)
        path.write_bytes(b"\xef\xbb\xbf" + xml_bytes)
        return path

    return _make
