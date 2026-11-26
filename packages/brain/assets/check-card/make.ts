/*
 * Makes the check card: card.html drawn by a headless Chrome at 1280 by 800, as card.jpg, and each target's box
 * and centre as the page itself measures them, in card.json. Run once, and again only when card.html changes:
 *   bun packages/brain/assets/check-card/make.ts [path to Chrome]
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.argv[2] ?? process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const here = fileURLToPath(new URL(".", import.meta.url));
const profile = mkdtempSync(join(tmpdir(), "check-card-"));
const chrome = Bun.spawn([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stderr: "pipe", stdout: "ignore" });
try {
  // Chrome says where its DevTools listen on its standard error.
  let port = "";
  const reader = chrome.stderr.getReader();
  for (let seen = ""; !port; ) {
    const { value, done } = await reader.read();
    if (done) throw new Error("Chrome ended before it said where its DevTools listen");
    seen += new TextDecoder().decode(value);
    port = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(seen)?.[1] ?? "";
  }
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const ws = new WebSocket(pages.find((p) => p.type === "page")!.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  let id = 0;
  const pending = new Map<number, (result: any) => void>();
  ws.addEventListener("message", (m) => {
    const reply = JSON.parse(String(m.data));
    pending.get(reply.id)?.(reply.result);
  });
  const send = (method: string, params: object = {}) => new Promise<any>((resolve) => { pending.set(++id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Page.enable");
  await send("Page.navigate", { url: `file://${join(here, "card.html")}` });
  await Bun.sleep(1500);
  const measured = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `JSON.stringify(Object.fromEntries([["ships","the Ships link in the top bar"],["crew","the Crew link in the top bar"],["export","the Export CSV button"],["archive","the Archive button"],["share","the Share with crew button"],["search","the Search ships field"],["anchored","the Include anchored ships checkbox"],["privacy","the Privacy link at the bottom"]].map(([id, name]) => { const r = document.getElementById(id).getBoundingClientRect(); return [id, { name, box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], centre: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] }]; })))`,
  });
  const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 82, clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 } });
  writeFileSync(join(here, "card.jpg"), Buffer.from(shot.data, "base64"));
  writeFileSync(join(here, "card.json"), `${JSON.stringify({ width: 1280, height: 800, heading: "Quarterly harbour ledger", targets: JSON.parse(measured.result.value) }, null, 2)}\n`);
  ws.close();
  console.log(`card.jpg (${Buffer.from(shot.data, "base64").length} bytes) and card.json written`);
} finally {
  chrome.kill();
  rmSync(profile, { recursive: true, force: true });
}
