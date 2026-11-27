# A STEP file's volume, as FreeCAD reads it back (the gate of the window's export).
#   BENCH_STEP=<file.step> freecadcmd -c "exec(open('volume.py').read())"   one JSON line
import json, os
import Part

print("BENCH " + json.dumps({"volume": round(Part.read(os.environ["BENCH_STEP"]).Volume, 2)}))
