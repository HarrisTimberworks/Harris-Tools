import zlib
import xml.etree.ElementTree as ET

from estimating import asm_chest, btx


def test_generated_chest_parses_with_six_markers(tmp_path):
    p = asm_chest.build(tmp_path)
    ts = btx.read_toolset(p)
    assert ts.title == "HTW-R 11 ASSEMBLIES"
    assert [t.subject for t in ts.tools] == [s for s, _ in asm_chest.MARKERS]
    assert all(t.unit == "EA" for t in ts.tools)
    assert all(t.layer == "ASM" for t in ts.tools)
    assert all(t.preset_unit_cost is None for t in ts.tools)
    assert all(len(t.col_tokens) == 6 for t in ts.tools)


def test_markers_carry_param_template_comment(tmp_path):
    p = asm_chest.build(tmp_path)
    ts = btx.read_toolset(p)
    raw = ts.tools[3].raw            # ASM - Open Interior - EA
    assert "/Contents(W__ H__ D__ SH__)" in raw


def test_library_rows_for_markers():
    rows = asm_chest.library_rows(source_date="2026-06-12")
    assert len(rows) == 6
    assert all(r.unit == "EA" and r.line == "R" and r.raw_cost == 0.0
               and r.status == "active" for r in rows)
    assert rows[0].subject == "ASM - Finished End (FF Flush) - EA"


def test_resources_are_valid_zlib_hex(tmp_path):
    p = asm_chest.build(tmp_path)
    root = ET.parse(p).getroot()
    for item in root.findall("ToolChestItem"):
        rid = item.find("Resources/ID").text
        rdata = item.find("Resources/Data").text
        # must be decodable zlib-hex, not literal junk
        zlib.decompress(bytes.fromhex(rid))
        zlib.decompress(bytes.fromhex(rdata))


def test_markers_reference_appearance_pointer(tmp_path):
    p = asm_chest.build(tmp_path)
    ts = btx.read_toolset(p)
    assert all("/AP<</N/BBObjPtr_" in t.raw for t in ts.tools)
