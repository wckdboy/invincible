/*
 * What the fixture Galahad home (fixture/, made by make-fixture.ts) holds, for the generator to put in and the tests to
 * look for. All of it is made up: the keys of its node are the SHA-256 of these phrases, so they are nobody's, and every
 * value in its vault is spelled FAKE.
 */

export const PHRASES = {
  sign: "the importer's fixture node signs with this; it is not a secret",
  box: "the importer's fixture node opens boxes with this; it is not a secret",
  phone: "the importer's fixture phone signs with this; it is not a secret",
  telegram: "the importer's fixture chat gateway signs with this; it is not a secret",
} as const;

/** The vault's values that come across, by name. */
export const COMING = {
  anthropic: "sk-ant-FAKE-fixture-key-000000000000",
  deepseek: "sk-FAKE-deepseek-fixture-000000000000",
  "zai-coding": "FAKE-zai-plan-key-00000000.fixture",
  github: "FAKE-github-token-for-the-fixture-000",
  gmail: JSON.stringify({ client: "FAKE-client.apps.example", secret: "FAKE-client-secret-000", refresh: "FAKE-refresh-token-000000", account: "owner@example.com", v: 1 }),
  weather: "FAKE-weather-key-00000000000",
  "search-api": "FAKE-search-api-key-000000000",
  pin: "FAKE-pin",
} as const;

/** The vault's values that stay behind, by name: its chat app's bot and gateway, its old app's push key, a loop's webhook. */
export const STAYING = {
  "telegram:bot": "000000:FAKE-telegram-bot-token-0000",
  "apple-push": `${JSON.stringify({ teamId: "FAKETEAM00", topic: "org.example.fixture", key: "FAKE-p8-key-material" })}\nFAKEKEY000`,
  "loop-hook:nightly": "FAKE-webhook-secret-0000000",
} as const;
