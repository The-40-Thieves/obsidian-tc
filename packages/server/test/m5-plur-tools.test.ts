// Domain 24 — plur read-API proxy, end-to-end through dispatch (THE-181). Driven
// entirely by the deterministic fake plur transport — no live plur. Covers each tool's
// route + body, the bearer-header send with no token leak, the unconfigured degrade
// (plugin_missing, NO network call), the configured-but-down degrade (plugin_unreachable),
// the engram-not-found passthrough (invalid_input), and read:plur scope enforcement.
import { describe, expect, it } from "vitest";
import { PLUR_TOKEN, makeM5Vault } from "./m5-helpers";

describe("plur proxy — happy paths", () => {
  it("plur_recall proxies to /recall and returns the result with the bearer header", async () => {
    const v = makeM5Vault({
      plurRoutes: {
        "POST /recall": {
          body: { ok: true, result: { items: [{ engram_id: "e1", score: 0.9 }] } },
        },
      },
    });
    try {
      const r = await v.call("plur_recall", { query: "hello", k: 5, scope: "global" });
      expect(r.ok).toBe(true);
      if (r.ok)
        expect((r.data as { items: unknown[] }).items).toEqual([{ engram_id: "e1", score: 0.9 }]);
      const req = v.plurRequests[0];
      expect(req?.url.endsWith("/recall")).toBe(true);
      expect(req?.headers.authorization).toBe(`Bearer ${PLUR_TOKEN}`);
      expect(JSON.parse(req?.body ?? "{}")).toMatchObject({
        query: "hello",
        k: 5,
        scope: "global",
      });
    } finally {
      v.cleanup();
    }
  });

  it("routes each tool to its endpoint", async () => {
    const v = makeM5Vault({
      plurRoutes: {
        "POST /recall_hybrid": { body: { ok: true, result: { items: [] } } },
        "POST /similarity_search": { body: { ok: true, result: { items: [] } } },
        "POST /get": { body: { ok: true, result: { engram_id: "e1", content: "x" } } },
      },
    });
    try {
      expect((await v.call("plur_recall_hybrid", { query: "q", bm25_weight: 0.3 })).ok).toBe(true);
      expect((await v.call("plur_similarity_search", { query: "q", min_score: 0.2 })).ok).toBe(
        true,
      );
      const got = await v.call("plur_get", { engram_id: "e1" });
      expect(got.ok).toBe(true);
      if (got.ok) expect((got.data as { engram_id: string }).engram_id).toBe("e1");
      expect(v.plurRequests.map((r) => new URL(r.url).pathname)).toEqual([
        "/recall_hybrid",
        "/similarity_search",
        "/get",
      ]);
    } finally {
      v.cleanup();
    }
  });
});

describe("plur proxy — degradation + errors", () => {
  it("degrades to plugin_missing with NO network call when plur is unconfigured", async () => {
    const v = makeM5Vault(); // no plur wired
    try {
      const r = await v.call("plur_recall", { query: "x" });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("plugin_missing");
        expect(r.error.details).toEqual({ plugin: "plur" });
      }
      expect(v.plurRequests).toHaveLength(0);
    } finally {
      v.cleanup();
    }
  });

  it("maps a transport failure to plugin_unreachable without leaking the token", async () => {
    const v = makeM5Vault({ plurRoutes: { "POST /recall": { networkError: true } } });
    try {
      const r = await v.call("plur_recall", { query: "x" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("plugin_unreachable");
      expect(JSON.stringify(r)).not.toContain(PLUR_TOKEN);
    } finally {
      v.cleanup();
    }
  });

  it("passes an engram-not-found (invalid_input) envelope through verbatim", async () => {
    const v = makeM5Vault({
      plurRoutes: {
        "POST /get": { body: { ok: false, code: "invalid_input", message: "engram not found" } },
      },
    });
    try {
      const r = await v.call("plur_get", { engram_id: "nope" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("requires the read:plur scope", async () => {
    const v = makeM5Vault({ plurRoutes: { "POST /recall": { body: { ok: true, result: {} } } } });
    try {
      const r = await v.call(
        "plur_recall",
        { query: "x" },
        { grantedScopes: new Set(["read:notes"]) },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
      expect(v.plurRequests).toHaveLength(0);
    } finally {
      v.cleanup();
    }
  });
});
