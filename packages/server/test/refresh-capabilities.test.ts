// THE-527: refresh_plugin_capabilities — re-probe the companion for a vault and swap the cached
// capability snapshot WITHOUT restarting the server. reload_vault re-reads the config file but does
// not re-probe, so installing/enabling a plugin or upgrading the companion mid-session required a
// full restart even though the bridge was up and would answer a probe immediately.
//
// The Done-when this file drives: the tool exists, is admin-scoped, replaces the snapshot atomically,
// a CHANGED probe result takes effect without restart, and it reports WHAT changed — not a bare ok.
import { describe, expect, it } from "vitest";
import type { CapabilitySnapshot } from "../src/bridge/capabilities";
import { diffSnapshots } from "../src/tools/m4/capability-tools";

const snap = (over: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot => ({
  companion: "reachable",
  plugins: {},
  ...over,
});

describe("THE-527 diffSnapshots", () => {
  it("reports nothing when the snapshots are identical", () => {
    const s = snap({ plugins: { dataview: { installed: true } }, pluginVersion: "1.10.0" });
    expect(diffSnapshots(s, s)).toEqual([]);
  });

  it("reports a companion-state transition", () => {
    const changes = diffSnapshots(snap({ companion: "missing" }), snap({ companion: "reachable" }));
    expect(
      changes.some(
        (c) => c.field === "companion" && c.before === "missing" && c.after === "reachable",
      ),
    ).toBe(true);
  });

  it("reports a newly installed plugin", () => {
    const changes = diffSnapshots(snap(), snap({ plugins: { templater: { installed: true } } }));
    expect(changes.some((c) => c.field === "plugin:templater" && c.after === "installed")).toBe(
      true,
    );
  });

  it("reports a removed plugin", () => {
    const changes = diffSnapshots(snap({ plugins: { templater: { installed: true } } }), snap());
    expect(changes.some((c) => c.field === "plugin:templater" && c.after === "absent")).toBe(true);
  });

  it("reports a plugin version change", () => {
    const before = snap({ plugins: { dataview: { installed: true, version: "0.5.0" } } });
    const after = snap({ plugins: { dataview: { installed: true, version: "0.6.0" } } });
    const changes = diffSnapshots(before, after);
    expect(
      changes.some(
        (c) =>
          c.field === "plugin:dataview" && c.before.includes("0.5.0") && c.after.includes("0.6.0"),
      ),
    ).toBe(true);
  });

  it("reports a companion plugin-version upgrade", () => {
    const changes = diffSnapshots(
      snap({ pluginVersion: "1.9.0" }),
      snap({ pluginVersion: "1.10.0" }),
    );
    expect(changes.some((c) => c.field === "pluginVersion")).toBe(true);
  });
});

// Tool-level: build a minimal registry with the capability tool and a fake reprobe, dispatch it,
// and assert the cache is swapped and the response names the change.
import { CapabilityCache } from "../src/bridge";
import { elicitVerifier } from "../src/elicit";
import { ToolRegistry } from "../src/mcp/registry";
import { buildCapabilityTools } from "../src/tools/m4/capability-tools";

function harness(
  initial: CapabilitySnapshot,
  reprobed: CapabilitySnapshot | (() => Promise<CapabilitySnapshot>),
) {
  const capabilities = new CapabilityCache();
  capabilities.set("main", initial);
  const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
  for (const t of buildCapabilityTools({
    vaultRegistry: { list: () => [{ id: "main", path: "/v" }] } as never,
    capabilities,
    bridgeFor: () => undefined,
    reprobe: async () => (typeof reprobed === "function" ? reprobed() : reprobed),
  })) {
    registry.register(t);
  }
  return { capabilities, registry };
}

const ctx = () => ({
  caller: "test",
  authenticated: true,
  grantedScopes: new Set(["*"]),
  vaultId: "main",
  db: undefined as never,
  acl: undefined as never,
});

describe("THE-527 refresh_plugin_capabilities tool", () => {
  interface RefreshData {
    vault: string;
    changed: boolean;
    companion: string;
    changes: { field: string; before: string; after: string }[];
  }

  it("swaps the cached snapshot so a changed probe takes effect without restart, and reports the change", async () => {
    const { capabilities, registry } = harness(
      snap({ companion: "missing" }),
      snap({
        companion: "reachable",
        plugins: { templater: { installed: true } },
        pluginVersion: "1.10.0",
      }),
    );

    const res = await registry.dispatch("refresh_plugin_capabilities", { vault: "main" }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const data = res.data as RefreshData;

    // took effect in the live cache — no restart
    expect(capabilities.get("main").companion).toBe("reachable");
    expect(capabilities.get("main").plugins.templater?.installed).toBe(true);
    // reported what changed, not a bare ok
    expect(data.changed).toBe(true);
    expect(data.companion).toBe("reachable");
    expect(data.changes.some((c) => c.field === "companion")).toBe(true);
    expect(data.changes.some((c) => c.field === "plugin:templater")).toBe(true);
  });

  it("reports changed:false when the probe result is identical", async () => {
    const same = snap({ companion: "reachable", plugins: { dataview: { installed: true } } });
    const { registry } = harness(same, same);
    const res = await registry.dispatch("refresh_plugin_capabilities", { vault: "main" }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const data = res.data as RefreshData;
    expect(data.changed).toBe(false);
    expect(data.changes).toEqual([]);
  });

  it("denies a caller lacking the admin:vault scope", async () => {
    const same = snap();
    const { registry } = harness(same, same);
    const res = await registry.dispatch(
      "refresh_plugin_capabilities",
      { vault: "main" },
      { ...ctx(), grantedScopes: new Set(["read:notes"]) },
    );
    expect(res.ok).toBe(false);
  });

  it("surfaces a probe that reports the companion now unreachable rather than failing", async () => {
    const { capabilities, registry } = harness(
      snap({ companion: "reachable" }),
      snap({ companion: "unreachable" }),
    );
    const res = await registry.dispatch("refresh_plugin_capabilities", { vault: "main" }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const data = res.data as RefreshData;
    expect(data.companion).toBe("unreachable");
    expect(capabilities.get("main").companion).toBe("unreachable");
    expect(data.changed).toBe(true);
  });

  it("returns a clear error (not ok) when reprobe is not wired", async () => {
    const capabilities = new CapabilityCache();
    capabilities.set("main", snap());
    const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
    for (const t of buildCapabilityTools({
      vaultRegistry: { list: () => [{ id: "main", path: "/v" }] } as never,
      capabilities,
      bridgeFor: () => undefined,
    })) {
      registry.register(t);
    }
    const res = await registry.dispatch("refresh_plugin_capabilities", { vault: "main" }, ctx());
    expect(res.ok).toBe(false);
  });
});
