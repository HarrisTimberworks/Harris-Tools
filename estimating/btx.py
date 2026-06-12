"""Read/write Bluebeam .btx tool sets (current 6-column HTW schema)."""
import re
import xml.etree.ElementTree as ET
import zlib
from dataclasses import dataclass, field

SUBJ_RE = re.compile(r'/Subj\(((?:[^()\\]|\\.)*)\)')
COL_RE = re.compile(r'/BSIColumnData\[((?:\((?:[^()\\]|\\.)*\))*)\]')
TOKEN_RE = re.compile(r'\((?:[^()\\]|\\.)*\)')
OC_RE = re.compile(r'/OC\(((?:[^()\\]|\\.)*)\)')

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


def set_preset_unit_cost(tool: Tool, value: str):
    """Rewrite slot 0 (Unit Cost) of the 6-slot array in tool.raw + element."""
    if "(" in value or ")" in value or "\\" in value:
        raise ValueError(
            f"preset value {value!r} contains PDF-string delimiters — "
            f"pass a plain number string like '12.50'")
    if len(tool.col_tokens) != 6:
        raise ValueError(
            f"{tool.subject}: expected 6-slot BSIColumnData, "
            f"found {len(tool.col_tokens)} — refusing (legacy or unknown-schema tool)")
    tool.col_tokens[0] = f"({value})"
    new_block = "/BSIColumnData[" + "".join(tool.col_tokens) + "]"
    tool.raw = COL_RE.sub(lambda m: new_block, tool.raw, count=1)
    tool.element.find("Raw").text = zlib.compress(
        tool.raw.encode("latin-1")).hex()


def write_toolset(ts: ToolSet, path):
    xml_bytes = ET.tostring(ts._tree.getroot(), encoding="utf-8",
                            xml_declaration=True)
    with open(path, "wb") as f:
        f.write(b"\xef\xbb\xbf" + xml_bytes)
