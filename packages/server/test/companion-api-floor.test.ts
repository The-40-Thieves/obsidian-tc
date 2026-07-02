// THE-282 — companion API-version floor.
import { describe, expect, it } from "vitest";
import { makeM4Vault } from "./m4-helpers";

describe("companion API-version floor (THE-282)", () => {
  it("an incompatible companion degrades bridge tools with non-retryable plugin_incompatible", async () => {
    const v = makeM4Vault({
      snapshot: {
        companion: "reachable",
        plugins: { templater: { installed: true } },
        apiVersion: "2",
        apiCompat: "incompatible",
      },
    });
    try {
      const r = await v.call("list_templates", { vault: "test" });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("plugin_incompatible");
        expect(r.error.retryable).toBe(false);
        expect((r.error.details as { expected_api?: string }).expected_api).toBe("1");
      }
      expect(v.bridgeRequests).toHaveLength(0); // degraded BEFORE any network call
    } finally {
      v.cleanup();
    }
  });

  it("a compatible (or pre-versioning) companion passes the gate", async () => {
    const v = makeM4Vault({
      snapshot: {
        companion: "reachable",
        plugins: { templater: { installed: true } },
        apiVersion: "1",
        apiCompat: "compatible",
      },
      routes: {
        "POST /obsidian-tc/v1/templater/list": { body: { ok: true, result: { items: [] } } },
      },
    });
    try {
      const r = await v.call("list_templates", { vault: "test" });
      expect(r.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});
