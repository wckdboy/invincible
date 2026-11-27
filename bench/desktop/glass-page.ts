import { bitsOf, STRIP } from "./glass-clock.ts";

/*
 * The page the glass-to-glass harness opens on the agent's screen (C1 step 9.3): its own time and its clicks, drawn as
 * the strip glass-clock.ts reads.
 * - While it runs (g pressed), the strip is drawn on each of the browser's frames, so the stream carries it at its own
 *   pace. While it is still (s, as it opens), it holds the last, so the stream sends nothing but its beats.
 * - A click anywhere counts, at once, and turns the panel below the strip to its other colour: what you see of a click.
 * - `?t=<ms>&c=<clicks>` draws that once and nothing more: the strip checked through H.264 without a clock.
 * The rest of the page is mid-grey, which the reader takes for no block at all.
 */

/** The page's HTML, whole (no file beside it): opened from the VM's own disk. */
export function glassPage(): string {
  const width = STRIP.x * 2 + STRIP.bits * STRIP.block;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Glass clock</title><style>
html,body{margin:0;height:100%;background:#808080;overflow:hidden;cursor:default}
canvas{position:absolute;left:0;top:0}
p{position:absolute;left:${STRIP.x}px;top:${STRIP.y + STRIP.block + 8}px;margin:0;font:600 15px system-ui,sans-serif;color:#fff}
#panel{position:absolute;left:${STRIP.x}px;right:${STRIP.x}px;top:${STRIP.y + STRIP.block + 40}px;bottom:${STRIP.x}px;background:#1f6feb}
#panel.other{background:#e5534b}
</style></head><body><canvas id="strip" width="${width}" height="${STRIP.y + STRIP.block}"></canvas><p id="state">Still</p><div id="panel"></div><script>
const STRIP = ${JSON.stringify(STRIP)};
${bitsOf.toString()}
const strip = document.getElementById("strip").getContext("2d");
const state = document.getElementById("state");
const panel = document.getElementById("panel");
const fixed = new URLSearchParams(location.search);
let clicks = 0;
let running = false;
function draw(time) {
  bitsOf(time, clicks).forEach((bit, i) => {
    strip.fillStyle = bit ? "#ffffff" : "#000000";
    strip.fillRect(STRIP.x + i * STRIP.block, STRIP.y, STRIP.block, STRIP.block);
  });
}
function frame() {
  if (!running) return;
  draw(Date.now());
  requestAnimationFrame(frame);
}
if (fixed.has("t")) {
  clicks = Number(fixed.get("c") ?? 0);
  draw(Number(fixed.get("t")));
} else {
  draw(Date.now());
  addEventListener("keydown", (event) => {
    if (event.key === "g" && !running) {
      running = true;
      state.textContent = "Running";
      requestAnimationFrame(frame);
    } else if (event.key === "s") {
      running = false;
      state.textContent = "Still";
    }
  });
  addEventListener("mousedown", () => {
    clicks += 1;
    panel.classList.toggle("other");
    draw(Date.now());
  });
}
</script></body></html>`;
}
