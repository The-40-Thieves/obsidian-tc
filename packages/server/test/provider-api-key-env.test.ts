import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveApiKey } from "../src/embeddings/provider";

// Save/restore rather than a blind delete: vitest's default thread-pool isolation resets the
// module registry per file, not process.env, so a bare `delete` here could still leak into (or
// stomp) another file's OPENAI_API_KEY sharing the same worker.
let prevGatewayKey: string | undefined;
let prevOpenAiKey: string | undefined;

beforeEach(() => {
  prevGatewayKey = process.env.MY_GATEWAY_KEY;
  prevOpenAiKey = process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (prevGatewayKey === undefined) Reflect.deleteProperty(process.env, "MY_GATEWAY_KEY");
  else process.env.MY_GATEWAY_KEY = prevGatewayKey;
  if (prevOpenAiKey === undefined) Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
  else process.env.OPENAI_API_KEY = prevOpenAiKey;
});

describe("resolveApiKey with apiKeyEnv", () => {
  it("reads the named environment variable", () => {
    process.env.MY_GATEWAY_KEY = "sk-from-env";
    expect(resolveApiKey("openai-compatible", undefined, "MY_GATEWAY_KEY")).toBe("sk-from-env");
  });
  it("prefers an inline apiKey", () => {
    process.env.MY_GATEWAY_KEY = "sk-from-env";
    expect(resolveApiKey("openai-compatible", "sk-inline", "MY_GATEWAY_KEY")).toBe("sk-inline");
  });
  it("falls back to the built-in map", () => {
    process.env.OPENAI_API_KEY = "sk-builtin";
    expect(resolveApiKey("openai", undefined, undefined)).toBe("sk-builtin");
  });
  it("returns undefined for an unknown provider with no apiKeyEnv", () => {
    expect(resolveApiKey("openai-compatible", undefined, undefined)).toBeUndefined();
  });
});
