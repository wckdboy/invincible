# An edit of the bench's board through KiCad's API (kipy 0.6.0, KiCad 9.0.8's) on the board editor open on the desktop,
# as an agent is told to edit one: every track to the width given (mm), as one step of its undo, saved to its file.
#   python3 edit.py <width mm>   one JSON line: the tracks, their width, how long it took
#   python3 edit.py --ping       exit 0 once KiCad answers, with a board open
import json, sys, time
from kipy import KiCad
from kipy.errors import ApiError, ConnectionError as NotListening

t = time.time()
kicad = KiCad()
if sys.argv[1:] == ["--ping"]:
    try:
        kicad.ping()
        kicad.get_board()
    except (NotListening, ApiError) as error:
        print(json.dumps({"ready": False, "why": str(error)[:200]}))
        sys.exit(1)
    print(json.dumps({"ready": True}))
    sys.exit(0)
width = float(sys.argv[1])
board = kicad.get_board()
tracks = board.get_tracks()
commit = board.begin_commit()
for track in tracks:
    track.width = round(width * 1_000_000)
board.update_items(tracks)
board.push_commit(commit, "every track to %g mm" % width)
board.save()
print(json.dumps({"tracks": len(tracks), "width": width, "ms": round((time.time() - t) * 1000)}))
