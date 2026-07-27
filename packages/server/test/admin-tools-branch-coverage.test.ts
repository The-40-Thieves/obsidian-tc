// THE-602: targeted branch coverage for src/tools/m6/admin-tools.ts's remaining nullish-fallback
// and vault-filter legs (get_server_config's no-ACL default, get_metrics' malformed-row labels,
// and its per-vault rate-limiter filter). Additive to test/m6-admin.test.ts — that file's fixtures
// and assertions are untouched.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolRegistry } from "../src/mcp/registry";
import { RateLimiter } from "../src/throttle";
import { buildAdminTools } from "../src/tools/m6/admin-tools";
import type { M6Deps } from "../src/tools/m6/shared";
import { type M6Vault, makeM6Vault } from "./m6-helpers";

const register = (r: ToolRegistry, d: M6Deps) => {
  for (const t of buildAdminTools(d)) r.register(t);
};

function data<T = Record<string, unknown>>(r: ToolResult): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
}

let v: M6Vault | undefined;
afterEach(() => v?.cleanup());

describe("get_server_config / inspect_acl without an ACL on the context", () => {
  it("defaults read_only to false when ctx.acl is absent", async () => {
    v = makeM6Vault({ register });
    const cfg = data<{ read_only: boolean }>(
      await v.call("get_server_config", {}, { acl: undefined }),
    );
    expect(cfg.read_only).toBe(false);
  });

  it("defaults effective_scopes to [] when ctx.acl is absent", async () => {
    v = makeM6Vault({ register });
    const out = data<{ allowed: boolean; effective_scopes: string[] }>(
      await v.call(
        "inspect_acl",
        { vault: "test", path: "a.md", op: "read", scopes: ["read:notes"] },
        { acl: undefined },
      ),
    );
    // No ACL means evaluatePathAcl/pathScopesSatisfied both no-op to "allowed"; scopesForPath has
    // nothing to consult without an acl instance, so effective_scopes is the [] fallback.
    expect(out.allowed).toBe(true);
    expect(out.effective_scopes).toEqual([]);
  });
});

describe("get_metrics malformed event_log rows (nullish label/value fallbacks)", () => {
  it("falls back ingest counter value to 0 when SUM(result_size) is NULL", async () => {
    v = makeM6Vault({ register });
    v.db
      .prepare(
        "INSERT INTO event_log (ts, vault_id, tool_name, caller, duration_ms, result_size, status, error_code, args_hash, event_type) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(Date.now(), "v1", null, null, null, null, "ok", null, null, "ingest_secrets_skipped");
    const out = data<{ metrics: { name: string; value: number }[] }>(
      await v.call("get_metrics", {}),
    );
    expect(
      out.metrics.find((m) => m.name === "obsidian_tc_ingest_secrets_skipped_total")?.value,
    ).toBe(0);
  });

  it("falls back an ingest counter's vault label to '' when vault_id is NULL", async () => {
    v = makeM6Vault({ register });
    v.db
      .prepare(
        "INSERT INTO event_log (ts, vault_id, tool_name, caller, duration_ms, result_size, status, error_code, args_hash, event_type) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(Date.now(), null, null, null, null, 4, "ok", null, null, "ingest_dedup_skipped");
    const out = data<{ metrics: { name: string; labels: Record<string, string> }[] }>(
      await v.call("get_metrics", {}),
    );
    const m = out.metrics.find((x) => x.name === "obsidian_tc_ingest_dedup_skipped_total");
    expect(m?.labels.vault).toBe("");
  });

  it("falls back a tool-call row's tool/vault labels to '' when NULL on a tool_invocation row", async () => {
    v = makeM6Vault({ register });
    v.db
      .prepare(
        "INSERT INTO event_log (ts, vault_id, tool_name, caller, duration_ms, result_size, status, error_code, args_hash, event_type) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(Date.now(), null, null, null, null, null, "ok", null, null, "tool_invocation");
    const out = data<{ metrics: { name: string; labels: Record<string, string> }[] }>(
      await v.call("get_metrics", {}),
    );
    const m = out.metrics.find((x) => x.name === "obsidian_tc_tool_calls_total");
    expect(m).toBeDefined();
    expect(m?.labels.tool).toBe("");
    expect(m?.labels.vault).toBe("");
  });
});

describe("get_metrics rate-limiter vault filter", () => {
  // Two separate vaults (each its own RateLimiter): the admin tier's own burst is 1
  // (src/throttle.ts DEFAULT_THROTTLE_TIERS), so a single test instance can only make ONE
  // get_metrics call before self-throttling — each scenario below gets its own fixture.
  it("excludes another vault's rate-limit hits when a vault filter is supplied", async () => {
    v = makeM6Vault({ register, rateLimiter: new RateLimiter() });
    // Exhaust the bulk burst (default tiers) for two distinct vaults so each records a real hit.
    for (let i = 0; i < 4; i++) v.rateLimiter.check("keyA", "bulk", "test", 0);
    for (let i = 0; i < 4; i++) v.rateLimiter.check("keyB", "bulk", "other-vault", 0);

    const filtered = data<{ metrics: { name: string; labels: Record<string, string> }[] }>(
      await v.call("get_metrics", { vault: "test" }),
    );
    const hits = filtered.metrics.filter((m) => m.name === "obsidian_tc_rate_limit_hits_total");
    expect(hits.every((m) => m.labels.vault === "test")).toBe(true);
    expect(hits.some((m) => m.labels.vault === "other-vault")).toBe(false);
  });

  it("includes every vault's rate-limit hits when no vault filter is supplied", async () => {
    v = makeM6Vault({ register, rateLimiter: new RateLimiter() });
    for (let i = 0; i < 4; i++) v.rateLimiter.check("keyA", "bulk", "test", 0);
    for (let i = 0; i < 4; i++) v.rateLimiter.check("keyB", "bulk", "other-vault", 0);

    const unfiltered = data<{ metrics: { name: string; labels: Record<string, string> }[] }>(
      await v.call("get_metrics", {}),
    );
    const allVaults = new Set(
      unfiltered.metrics
        .filter((m) => m.name === "obsidian_tc_rate_limit_hits_total")
        .map((m) => m.labels.vault),
    );
    expect(allVaults.has("test")).toBe(true);
    expect(allVaults.has("other-vault")).toBe(true);
  });
});
