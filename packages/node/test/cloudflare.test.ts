import { describe, expect, test } from "bun:test";
import { CATALOG, type ConnectorResult } from "@galahad/brain";
import { type BuiltRequest, buildCall, ConnectorManifest } from "@galahad/core";
import { cloudflareNatives } from "../src/cloudflare.ts";

/*
 * Cloudflare's token check (cloudflare.ts), against a stand-in for its API. An API token is a user's or an account's,
 * and Cloudflare checks each at its own address: the user's is asked first, then each account the token can see. The
 * account and token ids here are made up.
 */

const cloudflare = ConnectorManifest.parse(CATALOG.cloudflare!.manifest);
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const refused = { status: 401, json: { success: false, errors: [{ code: 1000, message: "Invalid API Token" }], messages: [], result: null } };
const active = (id: string) => ({ status: 200, json: { success: true, errors: [], messages: [], result: { id, status: "active", expires_on: "2027-01-01T00:00:00Z" } } });

/** A stand-in Cloudflare: each GET answered by its path (and query), every one kept. */
function service(answers: Record<string, { status: number; json: unknown }>) {
  const asked: string[] = [];
  const send = async (req: BuiltRequest): Promise<ConnectorResult> => {
    const url = new URL(req.url);
    asked.push(`${req.method} ${url.pathname}${url.search}`);
    const answer = answers[`${url.pathname}${url.search}`] ?? { status: 404, json: { success: false, errors: [{ code: 7003, message: "Could not route" }] } };
    return { ok: answer.status < 300, status: answer.status, contentType: "application/json", body: JSON.stringify(answer.json), truncated: false, durationMs: 1 };
  };
  return { send, asked };
}

const verify = (send: (req: BuiltRequest) => Promise<ConnectorResult>) => {
  const built = buildCall(cloudflare, "token.verify", {});
  if (built.kind !== "native") throw new Error("token.verify isn't carried out by the node");
  return cloudflareNatives["cloudflare.verify"](cloudflare, built.args, send);
};
const result = (r: ConnectorResult) => ({ status: r.status, value: JSON.parse(r.body) });

describe("a Cloudflare token, checked whoever owns it", () => {
  test("a user's token is checked at the user's address, and only there", async () => {
    const cf = service({ "/client/v4/user/tokens/verify": active("tok-user") });
    expect(result(await verify(cf.send))).toEqual({ status: 200, value: { owner: "user", id: "tok-user", status: "active", expires: "2027-01-01T00:00:00Z" } });
    expect(cf.asked).toEqual(["GET /client/v4/user/tokens/verify"]);
  });

  test("an account's token, refused at the user's address, is checked at the account's: the answer says whose", async () => {
    const cf = service({
      "/client/v4/user/tokens/verify": refused,
      "/client/v4/accounts?per_page=50": { status: 200, json: { success: true, result: [{ id: OTHER, name: "Elsewhere" }, { id: ACCOUNT, name: "Camelot" }] } },
      [`/client/v4/accounts/${OTHER}/tokens/verify`]: refused,
      [`/client/v4/accounts/${ACCOUNT}/tokens/verify`]: active("tok-account"),
    });
    expect(result(await verify(cf.send))).toEqual({
      status: 200,
      value: { owner: "account", account: { id: ACCOUNT, name: "Camelot" }, id: "tok-account", status: "active", expires: "2027-01-01T00:00:00Z" },
    });
    expect(cf.asked).toEqual([
      "GET /client/v4/user/tokens/verify",
      "GET /client/v4/accounts?per_page=50",
      `GET /client/v4/accounts/${OTHER}/tokens/verify`,
      `GET /client/v4/accounts/${ACCOUNT}/tokens/verify`,
    ]);
  });

  test("a token Cloudflare knows neither way is refused, with what it said at the user's address", async () => {
    const cf = service({ "/client/v4/user/tokens/verify": refused, "/client/v4/accounts?per_page=50": refused });
    const answer = result(await verify(cf.send));
    expect(answer.status).toBe(401);
    expect(answer.value.error).toBe("Cloudflare knows this token neither as a user's nor as one of an account it can see");
    expect(answer.value.said).toEqual([{ code: 1000, message: "Invalid API Token" }]);
  });

  test("an account id that isn't one is never put into an address", async () => {
    const cf = service({
      "/client/v4/user/tokens/verify": refused,
      "/client/v4/accounts?per_page=50": { status: 200, json: { success: true, result: [{ id: "../../user/tokens", name: "odd" }] } },
    });
    expect((await verify(cf.send)).status).toBe(401);
    expect(cf.asked).toEqual(["GET /client/v4/user/tokens/verify", "GET /client/v4/accounts?per_page=50"]);
  });

  test("the catalog says a token may be either kind", () => {
    expect(CATALOG.cloudflare!.keyHelp).toContain("Account API Tokens");
    expect(cloudflare.tools["token.verify"]).toMatchObject({ native: "cloudflare.verify", class: "read" });
  });
});
