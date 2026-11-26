import { describe, expect, test } from "bun:test";
import { b64u, findSecrets, newNodeIdentity, randomBytes, redact } from "../src/index.ts";

describe("secret scanning", () => {
  const keys = [
    "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "sk-orca-1234567890abcdefABCDEF",
    "sk-or-v1-0123456789abcdef0123456789abcdef",
    "sk-5f3c2a1b9d8e7f6a5b4c3d2e1f0a9b8c", // DeepSeek-style
    "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
    "AKIAIOSFODNN7EXAMPLE",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    `gw_${b64u(randomBytes(32))}`,
    "Xq7vB2mK9pL4wR8tZ3nC6yH1sD5fG0jQ", // unknown provider, high entropy
    "sk-kimi-Zq8Lw3Vn6Tb1Xc9Rk4Jh7Mp2Fd5Gs0Ya", // a Kimi Code membership key
    "sk-sp-Zq8Lw3Vn6Tb1Xc9Rk4Jh7Mp2Fd5Gs0Ya", // an Alibaba Coding Plan key
    "tp-7f3a9c1e5b2d8f406a1c3e5b7d9f2a4c", // a Xiaomi MiMo Token Plan key, even with a body too plain to look random
    "ttp-7f3a9c1e5b2d8f406a1c3e5b7d9f2a4c", // a MiMo Token Plan team key
    "7f3a9c1e5b2d8f406a1c3e5b7d9f2a4c.Qw8ErT2yUi5oPa7S", // Zhipu / Z.ai: an id, a dot, a secret
    "sk-ant-oat01-Zq8Lw3Vn6Tb1Xc9Rk4Jh7Mp2Fd5Gs0Ya8Ue3Io6Pq", // a Claude subscription's sign-in
  ];

  test.each(keys)("catches %s", (key) => {
    expect(findSecrets(`here is my key: ${key} thanks`).length).toBeGreaterThan(0);
  });

  test("leaves ordinary text, hashes and public device ids alone", () => {
    const ordinary = [
      "Please refactor the sync engine and add tests for the vault rotation.",
      "commit 0f6a77a3c9e1b2d4f5a6b7c8d9e0f1a2b3c4d5e6 fixed it", // git sha: hex only
      `my laptop is ${newNodeIdentity().id}`,
      "https://github.com/amiriteorg/galahad/blob/main/docs/ARCHITECTURE.md",
      "bundle 7f3a9c1e5b2d8f406a1c3e5b7d9f2a4c.min.js is the one the page loads", // a hashed file name
      "see 7f3a9c1e5b2d8f406a1c3e5b7d9f2a4c.d41d8cd98f00b204e9800998ecf8427e for both digests",
      "put tp-your-key in its place, as on a TP-Link router's page; http-proxy-middleware-configuration is a name", // MiMo's placeholder; tp- inside a word
    ];
    for (const text of ordinary) expect(findSecrets(text)).toEqual([]);
  });

  // A credential's name with a value that is one: still refused (narrowing the guard must not open it).
  const assignments = [
    "password=hunter2hunter2",
    "password: correct-horse-battery",
    'token: "8f2a91c4d7e3b605"',
    "api_key = 'q8Zp3LmW7rT2xK9v'",
    "export API_KEY=9f8e7d6c5b4a3210",
    'secret: "correct horse battery staple"',
    "DB_PASSWORD=Summer.2024!",
    "token=abcdefgh",
    "password = hunter(2)!x9",
    "passwd: john.smith1",
    "secret = <hunter2hunter2>",
    "password: ${DB_PASSWORD:-hunter2hunter2}",
    '{ "password": "hunter2hunter2" }',
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY",
  ];
  test.each(assignments)("refuses an assignment whose value is a secret: %s", (text) => {
    expect(findSecrets(`set it like this: ${text}`).map((f) => f.kind)).toContain("password assignment");
  });

  // Found by the review of the narrowing (November 2026): each was refused before it and let
  // through by it. A reference with a literal beside it holds the credential, and a password
  // can look like a reference. The values are fake, shaped like real ones.
  const disguised = [
    // A literal default after the reference, where the value was cut at the space.
    'password = os.getenv("PW", "Tr0ub4dor&3xyz")',
    'password = os.getenv("PW","Tr0ub4dor&3xyz")',
    'const password = process.env.DB_PASSWORD || "Winter2024hunter";',
    'const apiKey = process.env.API_KEY ?? "a8F3kL9mQ2xR7vB1";',
    "token = os.environ.get('GITHUB_TOKEN', 'Winter2024hunter')",
    "`password = process.env.DB_PASSWORD || 'Winter2024hunter'`",
    // A call that isn't a lookup, with the credential as its argument.
    'password = hash("Tr0ub4dor&3xyz")',
    // Passwords that look like a reference or a placeholder.
    "password=$uperman1234",
    "my password: $ecretPa55word",
    "password: config.Tr0ub4dor3x",
    "password=Summer2024.Secret",
    "token=[REDACTED]realtoken12345",
    "token: [redacted]realtoken12345",
  ];
  test.each(disguised)("refuses a credential dressed as a reference: %s", (text) => {
    expect(findSecrets(text).map((f) => f.kind)).toContain("password assignment");
  });

  test("redaction (connector answers, logs) hides a literal default too", () => {
    const line = 'const password = process.env.DB_PASSWORD || "Winter2024hunter";';
    expect(redact(line)).not.toContain("Winter2024hunter");
    expect(redact('password = os.getenv("PW", "Tr0ub4dor&3xyz")')).not.toContain("Tr0ub4dor");
  });

  // Ordinary engineering text that names a credential without holding one (it blocked every later
  // message of a temporary chat once Galahad wrote such a line himself, since the history is resent).
  const harmless = [
    "const token = request.headers.get(\"authorization\");",
    "const token = request.headers.get(...)",
    "export API_KEY=<your-key-here>",
    "password: ${DB_PASSWORD}",
    "token: $GITHUB_TOKEN",
    "set password=%DB_PASSWORD% first",
    "apiKey: process.env.ANTHROPIC_API_KEY,",
    "token = os.environ[\"GITHUB_TOKEN\"]",
    'api_key: "{{ api_key }}"',
    "password: ********",
    "token: [redacted Anthropic API key]",
    "token: undefined",
    "in your shell: `export API_KEY=<your-key-here>`; in compose: `password: ${DB_PASSWORD}`.",
    '{ "token": "${GITHUB_TOKEN}", "max_tokens": 4096 }',
    '"integrity": "sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+Tl/aTnqYuEzbJyb4gGkLGsKyE5rUY1oAv8HJTw=="',
    "integrity sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC",
    // A name looked up is not a literal default, and the expression ends where its statement does.
    'token = os.environ.get("GITHUB_TOKEN")',
    "const token = localStorage.getItem('session_token') ?? null;",
    'const token = request.headers.get("authorization"); // then "verify the signature"',
    '{ apiKey: process.env.ANTHROPIC_API_KEY, model: "claude-opus-4-5" }',
    'Set `apiKey: process.env.ANTHROPIC_API_KEY` and `model: "claude-opus-4-5"`.',
    "token: $GITHUB_TOKEN (it isn't kept in the repository)",
    "const password = creds.password;",
    "apiKey: config.oauth2Token,",
  ];
  test.each(harmless)("lets through: %s", (text) => {
    expect(findSecrets(text)).toEqual([]);
  });

  test("an id the caller knows is public (an event in the mind) isn't a secret; the same shape otherwise is", () => {
    const eventId = "8SpuaToTVJa71zgvba41gtk83EkAB8nIV4TUfLJurdo";
    const text = `the ledger entry ${eventId} shows the exec`;
    expect(findSecrets(text).map((f) => f.kind)).toEqual(["high-entropy token"]);
    expect(findSecrets(text, { isPublic: (token) => token === eventId })).toEqual([]);
    // Only the token itself is vouched for: a key beside it is still found.
    const both = `${text} and sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`;
    const kinds = findSecrets(both, { isPublic: (token) => token === eventId }).map((f) => f.kind);
    expect(kinds).toContain("Anthropic API key");
    expect(kinds).not.toContain("high-entropy token");
    // An integrity hash of the wrong length for its algorithm is just a token.
    expect(findSecrets("sha512-Xq7vB2mK9pL4wR8tZ3nC6yH1sD5fG0jQ").length).toBe(1);
  });

  test("redaction removes known values and secret-shaped strings", () => {
    const key = "custom-provider-key-value";
    const out = redact(`401: invalid key ${key}; also sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv`, [key]);
    expect(out).not.toContain(key);
    expect(out).not.toContain("sk-ant-");
    expect(out).toContain("[redacted");
  });

  test("a key that matches two patterns is redacted once, and what follows it stays", () => {
    // An Anthropic key is also an sk-… key: overlapping findings must not eat the rest of the text.
    expect(redact("before sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE after")).toBe("before [redacted Anthropic API key] after");
  });
});
