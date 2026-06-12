"""Read/write Bluebeam .btx tool sets (current 6-column HTW schema)."""
import os
import re
import xml.etree.ElementTree as ET
import zlib
from dataclasses import dataclass, field

SUBJ_RE = re.compile(r'/Subj\(((?:[^()\\]|\\.)*)\)')
COL_RE = re.compile(r'/BSIColumnData\[((?:\((?:[^()\\]|\\.)*\))*)\]')
TOKEN_RE = re.compile(r'\((?:[^()\\]|\\.)*\)')
OC_RE = re.compile(r'/OC\(((?:[^()\\]|\\.)*)\)')
IC_RE = re.compile(r'/IC\[([^\]]*)\]')

CHEST_GLOB = "HTW-[RC] [0-9][0-9] *.btx"

UNIT_BY_TYPE = {
    "Bluebeam.PDF.Annotations.AnnotationMeasurePolylength": "LF",
    "Bluebeam.PDF.Annotations.AnnotationMeasureArea": "SF",
    "Bluebeam.PDF.Annotations.AnnotationMeasureCount": "EA",
}


def _unescape(s):
    return s.replace("\\(", "(").replace("\\)", ")")


@dataclass
class Tool:
    subject: str
    unit: str           # LF | SF | EA
    raw: str            # decoded annotation dict (latin-1 text)
    element: ET.Element = field(repr=False)
    layer: str | None = None
    col_tokens: list[str] = field(default_factory=list)  # incl. parens

    @property
    def preset_unit_cost(self):
        if not self.col_tokens:
            return None
        v = self.col_tokens[0][1:-1]
        return _unescape(v) if v else None

    @property
    def color(self):
        m = IC_RE.search(self.raw)
        if not m:
            return None
        parts = m.group(1).split()
        if len(parts) < 3:
            return None
        rgb = [round(float(x) * 255) for x in parts[:3]]
        return "#{:02X}{:02X}{:02X}".format(*rgb)


@dataclass
class ToolSet:
    title: str
    path: str
    tools: list[Tool]
    _tree: ET.ElementTree = field(repr=False)


def _decode_hexzlib(text):
    return zlib.decompress(bytes.fromhex(text)).decode("latin-1")


def read_toolset(path) -> ToolSet:
    tree = ET.parse(path)
    root = tree.getroot()
    title = zlib.decompress(
        bytes.fromhex(root.findtext("Title"))).decode("utf-8")
    tools = []
    for item in root.findall("ToolChestItem"):
        raw = _decode_hexzlib(item.findtext("Raw"))
        subj_m = SUBJ_RE.search(raw)
        col_m = COL_RE.search(raw)
        oc_m = OC_RE.search(raw)
        tools.append(Tool(
            subject=_unescape(subj_m.group(1)) if subj_m else "(no subject)",
            unit=UNIT_BY_TYPE.get(item.findtext("Type"), "?"),
            raw=raw,
            element=item,
            layer=_unescape(oc_m.group(1)) if oc_m else None,
            col_tokens=TOKEN_RE.findall(col_m.group(1)) if col_m else [],
        ))
    return ToolSet(title=title, path=str(path), tools=tools, _tree=tree)


def _reencode(tool: Tool):
    tool.element.find("Raw").text = zlib.compress(
        tool.raw.encode("latin-1")).hex()


def _check_pdf_text(value: str, what: str):
    if "(" in value or ")" in value or "\\" in value:
        raise ValueError(
            f"{what} {value!r} contains PDF-string delimiters")
    try:
        value.encode("latin-1")
    except UnicodeEncodeError:
        raise ValueError(
            f"{what} {value!r} contains non-latin-1 characters")


def set_preset_unit_cost(tool: Tool, value: str):
    """Rewrite slot 0 (Unit Cost) of the 6-slot array in tool.raw + element."""
    _check_pdf_text(value, "preset value")
    if len(tool.col_tokens) != 6:
        raise ValueError(
            f"{tool.subject}: expected 6-slot BSIColumnData, "
            f"found {len(tool.col_tokens)} — refusing (legacy or unknown-schema tool)")
    tool.col_tokens[0] = f"({value})"
    new_block = "/BSIColumnData[" + "".join(tool.col_tokens) + "]"
    tool.raw = COL_RE.sub(lambda m: new_block, tool.raw, count=1)
    _reencode(tool)


def set_layer(tool: Tool, layer: str):
    """Set the markup's layer (/OC). Replaces an existing assignment or
    inserts one when absent."""
    _check_pdf_text(layer, "layer")
    if OC_RE.search(tool.raw):
        tool.raw = OC_RE.sub(lambda m: f"/OC({layer})", tool.raw, count=1)
    else:
        idx = tool.raw.rstrip().rfind(">>")
        if idx == -1:
            raise ValueError(
                f"{tool.subject}: raw has no '>>' close; cannot insert /OC")
        tool.raw = tool.raw[:idx] + f"/OC({layer})" + tool.raw[idx:]
    tool.layer = layer
    _reencode(tool)


def rename_subject(tool: Tool, new_subject: str):
    """Rename the tool's /Subj. The subject is the exact-match key joining
    tools, library rows, and takeoff line items — rename all three together."""
    _check_pdf_text(new_subject, "subject")
    tool.raw = SUBJ_RE.sub(lambda m: f"/Subj({new_subject})", tool.raw,
                           count=1)
    tool.subject = new_subject
    _reencode(tool)


def write_toolset(ts: ToolSet, path):
    """Atomic in-place write: temp file + os.replace, so a crash mid-write
    cannot leave a truncated .btx."""
    xml_bytes = ET.tostring(ts._tree.getroot(), encoding="utf-8",
                            xml_declaration=True)
    tmp = str(path) + ".tmp"
    with open(tmp, "wb") as f:
        f.write(b"\xef\xbb\xbf" + xml_bytes)
    os.replace(tmp, str(path))
