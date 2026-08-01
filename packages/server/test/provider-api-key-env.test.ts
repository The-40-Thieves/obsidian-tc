import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveApiKey } from "../src/embeddings/provider";

// Save/restore rather than a blind delete. Concurrent test *files* cannot race on process.env —
// each tinypool worker gets its own process.env at spawn (worker_threads doesn't share env without
// Worker.SHARE_ENV, which vitest doesn't pass; forked workers are separate processes entirely).
// The real risks this guards against: a worker being REUSED across files sequentially within a
// run, and a value lingering from this file when an assertion throws before cleanup runs.
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

  describe("fall-through when apiKeyEnv names an unset or empty variable", () => {
    it("falls through to the built-in map when the named variable is unset", () => {
      Reflect.deleteProperty(process.env, "DEFINITELY_UNSET_VAR");
      process.env.OPENAI_API_KEY = "sk-builtin";
      expect(resolveApiKey("openai", undefined, "DEFINITELY_UNSET_VAR")).toBe("sk-builtin");
    });
    it("falls through to the built-in map when the named variable is the empty string", () => {
      // The case a naive `process.env[name] ?? fallback` gets wrong: "" is not nullish.
      process.env.MY_GATEWAY_KEY = "";
      process.env.OPENAI_API_KEY = "sk-builtin";
      expect(resolveApiKey("openai", undefined, "MY_GATEWAY_KEY")).toBe("sk-builtin");
    });
    it("returns undefined when the named variable is unset and the provider has no built-in entry", () => {
      Reflect.deleteProperty(process.env, "DEFINITELY_UNSET_VAR");
      expect(resolveApiKey("openai-compatible", undefined, "DEFINITELY_UNSET_VAR")).toBeUndefined();
    });
  });
});
