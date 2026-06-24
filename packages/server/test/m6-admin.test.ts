// M6 Domain 28 admin tools through real dispatch (THE-182): get_server_config,
// inspect_acl, get_metrics. Proves the admin surface is complete, leaks no secrets,
// faithfully mirrors ACL enforcement, and snapshots real event_log + limiter data.
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

/** Recursively collect every object key, to assert no secret-bearing field leaks. */
function allKeys(o: unknown, acc: string[] = []): string[] {
  if (Array.isArray(o)) for (const x of o) allKeys(x, acc);
  else if (o && typeof o === "object")
    for (const [k, val] of Object.entries(o)) {
      acc.push(k);
      allKeys(val, acc);
    }
  return acc;
}

let v: M6Vault | undefined;
afterEach(() => v?.cleanup());

describe("get_server_config", () => {
  it("reports non-secret config including the bulk throttle limits", async () => {
    v = makeM6Vault({
      authMode: "jwt",
      observability: { otel: true, prometheus: false, morgiana: true },
      capabilities: () => ({
        companion: "reachable",
        plugins: { dataview: { installed: true, version: "0.5.64" }, ghost: { installed: false } },
      }),
      register,
    });
    const cfg = data<{
      version: string;
      auth_mode: string;
      read_only: boolean;
      embeddings_provider: string;
      vaults_summary: { id: string }[];
      limits: Record<string, number>;
      observability: Record<string, boolean>;
      plugins_detected: Record<string, string[]>;
    }>(await v.call("get_server_config", {}));

    expect(cfg.auth_mode).toBe("jwt");
    expect(cfg.read_only).toBe(false);
    expect(cfg.embeddings_provider).toBe("ollama");
    expect(cfg.vaults_summary[0]).toEqual({ id: "test" });
    expect(cfg.limits).toMatchObject({
      max_concurrent_writes_per_vault: 16,
      max_operations_per_minute: 10,
      max_operations_per_second: 3,
    });
    expect(cfg.observability).toEqual({
      otlp_enabled: true,
      prometheus_enabled: false,
      morgiana_enabled: true,
    });
    expect(cfg.plugins_detected.test).toEqual(["dataview"]); // installed names only, no versions
  });

  it("leaks no secret-bearing fields", async () => {
    v = makeM6Vault({ authMode: "jwt", register });
    const cfg = data(await v.call("get_server_config", {}));
    const keys = allKeys(cfg).map((k) => k.toLowerCase());
    for (const k of keys) {
      expect(k).not.toContain("secret");
      expect(k).not.toContain("apikey");
      expect(k).not.toContain("token");
      expect(k).not.toContain("password");
    }
    // and no secret-shaped values
    expect(JSON.stringify(cfg).toLowerCase()).not.toContain("bearer");
  });

  it("runs under a read-only ACL (admin is non-mutating)", async () => {
    v = makeM6Vault({ acl: { readOnly: true }, register });
    const cfg = data<{ read_only: boolean }>(await v.call("get_server_config", {}));
    expect(cfg.read_only).toBe(true);
  });
});

describe("inspect_acl", () => {
  it("allows a write when path + scope permit", async () => {
    v = makeM6Vault({ acl: { writePaths: ["notes/**"] }, register });
    const out = data<{ allowed: boolean; matched_rule: string | null }>(
      await v.call("inspect_acl", {
        vault: "test",
        path: "notes/a.md",
        op: "write",
        scopes: ["write:notes"],
      }),
    );
    expect(out.allowed).toBe(true);
    expect(out.matched_rule).toBe("notes/**");
  });

  it("flags the read-only kill switch for a mutating op", async () => {
    v = makeM6Vault({ acl: { readOnly: true }, register });
    const out = data<{ allowed: boolean; denied_by: string; kill_switch: boolean }>(
      await v.call("inspect_acl", { vault: "test", path: "a.md", op: "write", scopes: ["*"] }),
    );
    expect(out).toMatchObject({ allowed: false, denied_by: "read_only", kill_switch: true });
  });

  it("denies a path outside the write whitelist", async () => {
    v = makeM6Vault({ acl: { writePaths: ["notes/**"] }, register });
    const out = data<{ allowed: boolean; denied_by: string }>(
      await v.call("inspect_acl", {
        vault: "test",
        path: "secret/a.md",
        op: "write",
        scopes: ["write:notes"],
      }),
    );
    expect(out).toMatchObject({ allowed: false, denied_by: "write_paths" });
  });

  it("denies when the scopes lack the op family", async () => {
    v = makeM6Vault({ register });
    const out = data<{ allowed: boolean; denied_by: string }>(
      await v.call("inspect_acl", {
        vault: "test",
        path: "a.md",
        op: "write",
        scopes: ["read:notes"],
      }),
    );
    expect(out).toMatchObject({ allowed: false, denied_by: "scope" });
  });

  it("allows reads under a read-only ACL (kill switch is mutating-only)", async () => {
    v = makeM6Vault({ acl: { readOnly: true }, register });
    const out = data<{ allowed: boolean; kill_switch: boolean }>(
      await v.call("inspect_acl", {
        vault: "test",
        path: "a.md",
        op: "read",
        scopes: ["read:notes"],
      }),
    );
    expect(out).toMatchObject({ allowed: true, kill_switch: false });
  });

  it("reports effective_scopes from the rule-based last-match-wins", async () => {
    v = makeM6Vault({
      acl: {
        defaultScopes: ["read:notes"],
        rules: [{ glob: "secret/**", scopes: ["admin:config"] }],
      },
      register,
    });
    const out = data<{ effective_scopes: string[] }>(
      await v.call("inspect_acl", {
        vault: "test",
        path: "secret/x.md",
        op: "read",
        scopes: ["*"],
      }),
    );
    expect(out.effective_scopes).toEqual(["admin:config"]);
  });

  it("errors with vault_not_found for an unknown vault", async () => {
    v = makeM6Vault({ register });
    const r = await v.call("inspect_acl", {
      vault: "nope",
      path: "a.md",
      op: "read",
      scopes: ["*"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("vault_not_found");
  });
});

describe("get_metrics", () => {
  it("aggregates invocation counters from the event_log plus gauges", async () => {
    v = makeM6Vault({ register });
    await v.call("get_server_config", {}); // produces an event_log row
    await v.call("get_server_config", {});

    const out = data<{
      metrics: { name: string; type: string; value: number; labels: Record<string, string> }[];
    }>(await v.call("get_metrics", {}));
    const inv = out.metrics.find(
      (m) => m.name === "obsidian_tc_tool_calls_total" && m.labels.tool === "get_server_config",
    );
    expect(inv?.value).toBe(2);
    expect(out.metrics.find((m) => m.name === "obsidian_tc_vaults_registered")?.value).toBe(1);
    const tools = out.metrics.find((m) => m.name === "obsidian_tc_tools_registered");
    expect((tools?.value ?? 0) > 0).toBe(true);
    expect(out.metrics.some((m) => m.name === "obsidian_tc_uptime_seconds")).toBe(true);
  });

  it("includes live rate-limiter hit counters", async () => {
    v = makeM6Vault({ register, rateLimiter: new RateLimiter() });
    // Exhaust the bulk burst directly to seed a hit (3 ok, 1 throttled).
    for (let i = 0; i < 4; i++) v.rateLimiter.check("c0ffee00", "bulk", "test", 0);
    const out = data<{
      metrics: { name: string; value: number; labels: Record<string, string> }[];
    }>(await v.call("get_metrics", {}));
    const hit = out.metrics.find(
      (m) => m.name === "obsidian_tc_rate_limit_hits_total" && m.labels.scope_class === "bulk",
    );
    expect(hit?.value).toBe(1);
  });
});
