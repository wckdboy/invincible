import { describe, expect, test } from "bun:test";
import { sameModel } from "../src/index.ts";

describe("sameModel", () => {
  test("two refs are one model when the part after the last / is the same, lowercased, with . and _ read as -", () => {
    // One model under three providers (the provider/route prefix is ignored).
    expect(sameModel("deepseek/deepseek-v4-pro", "opencode-go/deepseek-v4-pro")).toBe(true);
    expect(sameModel("deepseek/deepseek-v4-pro", "cloudflare-ai/deepseek/deepseek-v4-pro")).toBe(true);
    expect(sameModel("opencode-go/deepseek-v4-pro", "cloudflare-ai/deepseek/deepseek-v4-pro")).toBe(true);
    // One model where "." and "_" are the same separator as "-".
    expect(sameModel("anthropic/claude-opus-5-5", "orcarouter/anthropic/claude-opus-5.5")).toBe(true);
    // Case-insensitive.
    expect(sameModel("DeepSeek/DeepSeek-V4-Pro", "deepseek/deepseek-v4-pro")).toBe(true);
    expect(sameModel("openai/GPT-6.2_astra", "openai/gpt-6.2-astra")).toBe(true);
  });

  test("different model names are not one model, whatever the provider", () => {
    expect(sameModel("anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5")).toBe(false);
    expect(sameModel("deepseek/deepseek-v4-pro", "deepseek/deepseek-flash")).toBe(false);
    expect(sameModel("anthropic/claude-opus-5-5", "anthropic/claude-haiku-5-5")).toBe(false);
  });
});
