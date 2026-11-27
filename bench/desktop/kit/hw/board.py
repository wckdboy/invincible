# The bench's board (C0's example, 26 November 2026), made by KiCad's own Python module (pcbnew, SWIG): a 30 x 20 mm
# outline, one two-pad part, one track. Fixture only: the cases themselves work it as an agent is told to.
#   python3 board.py <board.kicad_pcb>   prints one JSON line: what it saved
import json, sys
import pcbnew

b = pcbnew.BOARD()
mm = pcbnew.FromMM


def pt(x, y):
    return pcbnew.VECTOR2I(mm(x), mm(y))


for (x1, y1, x2, y2) in [(0, 0, 30, 0), (30, 0, 30, 20), (30, 20, 0, 20), (0, 20, 0, 0)]:
    s = pcbnew.PCB_SHAPE(b)
    s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetLayer(pcbnew.Edge_Cuts)
    s.SetStart(pt(x1, y1))
    s.SetEnd(pt(x2, y2))
    s.SetWidth(mm(0.1))
    b.Add(s)
fp = pcbnew.FOOTPRINT(b)
fp.SetReference("R1")
fp.SetValue("10k")
b.Add(fp)
fp.SetPosition(pt(15, 10))
for i, dx in enumerate([-1.0, 1.0]):
    p = pcbnew.PAD(fp)
    p.SetNumber(str(i + 1))
    p.SetShape(pcbnew.PAD_SHAPE_RECT)
    p.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
    p.SetLayerSet(pcbnew.PAD.SMDMask())
    p.SetSize(pt(1.0, 1.2))
    p.SetPosition(pt(15 + dx, 10))
    fp.Add(p)
t = pcbnew.PCB_TRACK(b)
t.SetStart(pt(5, 10))
t.SetEnd(pt(14, 10))
t.SetWidth(mm(0.25))
t.SetLayer(pcbnew.F_Cu)
b.Add(t)
pcbnew.SaveBoard(sys.argv[1], b)
print(json.dumps({"saved": sys.argv[1], "footprints": len(b.GetFootprints()), "tracks": len(b.GetTracks())}))
