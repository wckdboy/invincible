# A board's track widths, mm, as KiCad's own Python module reads the file back (the gate of an edit).
#   python3 widths.py <board.kicad_pcb>   one JSON line
import json, sys
import pcbnew

board = pcbnew.LoadBoard(sys.argv[1])
print(json.dumps({"widths": sorted({round(pcbnew.ToMM(t.GetWidth()), 3) for t in board.GetTracks()})}))
