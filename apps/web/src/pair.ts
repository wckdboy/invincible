import { fromB64u } from "@galahad/core/bytes";
import { approvalProof, decodeInvite, type Invite, pairProof, type PairRequestFields, proofMatches, sasCode, statusProof } from "@galahad/core/pairing";
import { ApiError, apiFor, nodeReachable, pairPost } from "./api.ts";
import { errorMessage } from "./context.ts";
import { type BrowserIdentity, forgetIdentity, runningAsApp, saveIdentity } from "./identity.ts";
import { hero, renderPairFailed, solo, trustStrip } from "./screens.ts";
import { button, callout, sasCode as sasDigits } from "./ui/controls.ts";
import { h, replace } from "./ui/dom.ts";
import { icon } from "./ui/icons.ts";

/*
 * Pairing this browser (loaded on demand as /pair.js; it is the only part of
 * the app that needs the invite schema):
 *  1. prove we hold the invite (HMAC over our public key; the secret never leaves the page)
 *  2. show the 6-digit code derived from (invite secret, fleet, our key)
 *  3. you approve on a node only if it shows the same code
 *  4. we verify the approval is authentic before trusting it
 * Requests go to this page's own origin, never to the invite's tailnet address.
 *
 * It survives a reload (phones discard tabs while you walk to the laptop): the
 * invite stays in the URL until pairing ends, and on load we quietly ask whether
 * this browser already asked or was already approved. Network hiccups retry;
 * only a definite answer (declined, unverifiable, expired) ends it and clears
 * the invite from the URL.
 */

const clearHash = () => history.replaceState(null, "", `${location.pathname}${location.search}`);

interface StatusResult {
  status: string;
  fleet?: string;
  approval?: string;
}

/** A definite "no": stop, clear the invite from the URL, and say why. */
class PairingEnded extends Error {}

const transient = (error: unknown) => error instanceof TypeError || (error instanceof ApiError && (error.status === 0 || error.status >= 500));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function renderPairing(root: HTMLElement, identity: BrowserIdentity, inviteText: string, onPaired: () => void): void {
  document.title = "Join the fleet · Galahad";
  let invite: Invite;
  try {
    invite = decodeInvite(inviteText);
    if (invite.k !== "client") throw new Error("This invite is for a machine. Run `galahad join …` on that machine instead.");
  } catch (error) {
    clearHash();
    renderPairFailed(root, errorMessage(error));
    return;
  }
  const secret = fromB64u(invite.s);
  const expectedSas = sasCode(secret, invite.f, identity.device);
  const statusBody = () => ({ invite: invite.i, device: identity.device, proof: statusProof(secret, invite.i, identity.device) });
  const nameInput = h("input", { class: "input", type: "text", id: "device-name", value: identity.name, maxlength: 64, autocomplete: "off" });
  const status = h("div", { "aria-live": "polite", class: "stack" });
  const join = button("Ask to join", { variant: "primary", type: "submit", size: "lg", block: true });
  const reach = h("div", { "aria-live": "polite" });
  let polling = false;

  /**
   * Say plainly whether this device can reach the node. A page the service worker served
   * from cache looks fine even with no route to the node; this is what tells the difference.
   */
  function unreachable(): HTMLElement {
    return callout("warn", [
      h("p", {}, `This device can't reach ${location.host} right now.`),
      h(
        "p",
        { class: "small" },
        "Your fleet is on your tailnet only. On a phone, open the Tailscale app and check it says Connected (with MagicDNS on); on a computer, check Tailscale is running. Then try again.",
      ),
    ], {
      title: "No connection to your node",
      actions: button("Try again", { size: "sm", onClick: () => void checkReach() }),
    });
  }

  async function checkReach(): Promise<boolean> {
    replace(reach, h("p", { class: "tiny subtle row", style: "justify-content:center" }, h("span", { class: "spinner", "aria-hidden": "true" }), `Checking the connection to ${location.host}…`));
    const ok = await nodeReachable();
    replace(
      reach,
      ok
        ? h("p", { class: "tiny subtle row", style: "justify-content:center" }, icon("link", { size: 14 }), `Connected to ${location.host}`)
        : unreachable(),
    );
    return ok;
  }

  function showCode(name: string, note = "Waiting for your approval…"): void {
    join.hidden = true;
    nameInput.disabled = true;
    replace(
      status,
      h("p", { class: "label", style: "text-align:center" }, "Your code"),
      sasDigits(expectedSas),
      h(
        "p",
        { class: "small muted", style: "text-align:center" },
        "On your node, approve ",
        h("strong", {}, name),
        " only if it shows this exact code: in Galahad's Inbox on another device, or in the terminal running ",
        h("span", { class: "mono" }, "galahad invite"),
        ".",
      ),
      h("div", { class: "row", style: "justify-content:center", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "small muted wait-note" }, note)),
    );
  }

  function ended(message: string): void {
    clearHash();
    join.hidden = true;
    nameInput.disabled = true;
    replace(status, callout("danger", message, { title: "Pairing stopped", actions: h("span", { class: "small" }, "Ask for a fresh invite with ", h("span", { class: "mono" }, "galahad invite --client"), ".") }));
  }

  async function finish(result: StatusResult): Promise<void> {
    const expected = approvalProof(secret, invite.i, identity.device, invite.f);
    if (result.fleet !== invite.f || !result.approval || !proofMatches(expected, result.approval)) {
      throw new PairingEnded("The approval could not be verified. Stopping here, to be safe.");
    }
    identity.enrolled = true;
    await saveIdentity(identity);
    clearHash();
    replace(status, callout("ok", "Approved and verified. Welcome to the fleet.", { icon: "shield-check" }));
    setTimeout(onPaired, 700);
  }

  /** This key is enrolled already (approved earlier, then the tab was lost)? Ask the node with a signed request. */
  async function alreadyEnrolled(): Promise<boolean> {
    try {
      await apiFor(identity).get("/api/whoami");
      return true;
    } catch {
      return false;
    }
  }

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    let failures = 0;
    try {
      for (;;) {
        let result: StatusResult;
        try {
          result = await pairPost<StatusResult>("/link/pair/status", statusBody());
          failures = 0;
        } catch (error) {
          if (!transient(error)) throw error;
          failures++;
          const note = status.querySelector(".wait-note");
          if (note) note.textContent = "Connection lost. Retrying…";
          await sleep(Math.min(10_000, 1500 * 2 ** Math.min(failures, 3)));
          continue;
        }
        const note = status.querySelector(".wait-note");
        if (note) note.textContent = "Waiting for your approval…";
        if (result.status === "rejected") throw new PairingEnded("The pairing was declined on the node.");
        if (result.status === "approved") return await finish(result);
        await sleep(1500);
      }
    } catch (error) {
      if (error instanceof PairingEnded) ended(error.message);
      else if (error instanceof ApiError && (error.status === 404 || error.status === 403)) ended("This invite has expired or is no longer valid.");
      else ended(errorMessage(error));
    } finally {
      polling = false;
    }
  }

  async function request(event: Event): Promise<void> {
    event.preventDefault();
    const name = nameInput.value.trim().slice(0, 64) || identity.name;
    const fields: PairRequestFields = { invite: invite.i, device: identity.device, name, kind: "client" };
    join.disabled = true;
    try {
      const response = await pairPost<{ status: string; sas: string }>("/link/pair/request", { ...fields, proof: pairProof(secret, fields) });
      if (response.sas !== expectedSas) throw new PairingEnded("The node computed a different code. Stopping here, to be safe.");
      identity.name = name;
      showCode(name);
      void poll();
    } catch (error) {
      join.disabled = false;
      if (error instanceof PairingEnded) return ended(error.message);
      if (error instanceof ApiError && error.status === 409 && /already enrolled/.test(error.message)) {
        if (await alreadyEnrolled()) {
          identity.enrolled = true;
          await saveIdentity(identity);
          clearHash();
          onPaired();
          return;
        }
        replace(
          status,
          callout("danger", "This browser's key is already known to the fleet, but the node won't accept it. If it was revoked, forget the key and use a fresh invite.", {
            actions: button("Forget this browser's key", {
              size: "sm",
              onClick: async () => {
                await forgetIdentity();
                location.reload();
              },
            }),
          }),
        );
        return;
      }
      if (error instanceof ApiError && error.status === 409 && /already used/.test(error.message)) {
        // Approved while this tab was away: our status proof will tell.
        showCode(name, "Checking with your node…");
        void poll();
        return;
      }
      if (error instanceof ApiError && error.status === 409) return ended(error.message);
      // No answer at all: nothing is lost (the invite still holds), so say why and let them retry.
      if (error instanceof ApiError && error.status === 0) {
        replace(status);
        replace(reach, unreachable());
        return;
      }
      replace(status, callout("danger", errorMessage(error)));
    }
  }

  replace(
    root,
    solo(
      hero("Join the fleet", `${runningAsApp() ? "This app" : "This browser"} gets its own key. It can sign, but it can never be read out, not even by this page.`),
      h(
        "form",
        { class: "card", onsubmit: (event: Event) => void request(event) },
        h("div", { class: "field" }, h("label", { for: "device-name" }, "Name this device"), nameInput, h("div", { class: "hint" }, "How it appears in your fleet's device list.")),
        join,
        status,
        reach,
      ),
      trustStrip(),
    ),
  );

  void checkReach();

  // Resume quietly if this browser already asked (or was approved) before a reload.
  pairPost<StatusResult>("/link/pair/status", statusBody())
    .then((result) => {
      if (result.status === "pending") {
        showCode(identity.name);
        void poll();
      } else if (result.status === "approved") {
        showCode(identity.name, "Approved. Verifying…");
        void poll();
      } else if (result.status === "rejected") ended("The pairing was declined on the node.");
    })
    .catch(() => {
      /* no earlier request (404) or offline: the form is the way forward */
    });

  nameInput.focus();
  nameInput.select();
}
