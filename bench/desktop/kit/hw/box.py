# The bench's part (C0's example, 26 November 2026), made by FreeCAD's Python with no window (freecadcmd): a 20 x 10 x 5
# mm block with a 3 mm hole through it, exported as STEP and read back, its volume checked (1000 - pi * 1.5^2 * 5 =
# 964.66 mm^3). With BENCH_FCSTD, saved as FreeCAD's own file too (what the window's case opens).
#   BENCH_STEP=<out.step> [BENCH_FCSTD=<box.FCStd>] freecadcmd -c "exec(open('box.py').read())"   one JSON line
import json, math, os, time
import FreeCAD, Part

t = time.time()
out = os.environ["BENCH_STEP"]
doc = FreeCAD.newDocument("box")
shape = Part.makeBox(20, 10, 5).cut(Part.makeCylinder(1.5, 5, FreeCAD.Vector(10, 5, 0)))
block = doc.addObject("Part::Feature", "Block")
block.Shape = shape
doc.recompute()
if os.environ.get("BENCH_FCSTD"):
    doc.saveAs(os.environ["BENCH_FCSTD"])
shape.exportStep(out)
back = Part.read(out)
want = 1000 - math.pi * 1.5 ** 2 * 5
print("BENCH " + json.dumps({"volume": round(back.Volume, 2), "want": round(want, 2), "ok": abs(back.Volume - want) < 0.01, "ms": round((time.time() - t) * 1000)}))
