import { describe, expect, it } from "vitest";
import {
  CapabilityCache,
  type CapabilitySnapshot,
  applyOverrides,
  pluginStatus,
} from "../src/bridge/capabilities";
import { type FakeRoute, fakeBridgeTransport } from "../src/bridge/fake";
import { buildVaultCapabilities, probeCompanion } from "../src/bridge/probe";
import { createBridgeClient } from "../src/bridge/transport";

const BASE = "http://127.0.0.1:27124";
const PROBE = "GET /obsidian-tc/v1/probe";

function clientWith(routes: Record<string, FakeRoute>, onReq?: () => void) {
  const fetchFn = fakeBridgeTransport({ routes, onRequest: onReq ? () => onReq() : undefined });
  return createBridgeClient({ baseUrl: BASE, apiKey: "k", fetchFn });
}

describe("companion auto-probe", () => {
  it("parses the capability map on a reachable probe (single request)", async () => {
    let calls = 0;
    const client = clientWith(
      {
        [PROBE]: {
          body: {
            ok: true,
            result: {
              plugin_version: "0.1.0",
              obsidian_version: "1.7.4",
              obsidianTcApiVersion: "1",
              vault_path: "/v",
              capabilities: {
                dataview: { installed: true, version: "0.5.66" },
                quickadd: { installed: false },
              },
            },
          },
        },
      },
      () => {
        calls++;
      },
    );
    const snap = await probeCompanion(client);
    expect(calls).toBe(1);
    expect(snap.companion).toBe("reachable");
    expect(snap.plugins.dataview).toEqual({ installed: true, version: "0.5.66" });
    expect(snap.plugins.quickadd).toEqual({ installed: false });
    expect(snap.apiVersion).toBe("1");
    expect(snap.vaultPath).toBe("/v");
  });

  it("treats a 404 (no companion) as missing, with no retry", async () => {
    let calls = 0;
    const client = clientWith({ [PROBE]: { status: 404, body: {} } }, () => {
      calls++;
    });
    const snap = await probeCompanion(client);
    expect(snap.companion).toBe("missing");
    expect(calls).toBe(1);
  });

  it("treats an explicit plugin_missing envelope as missing", async () => {
    const client = clientWith({
      [PROBE]: { body: { ok: false, code: "plugin_missing", message: "no companion" } },
    });
    expect((await probeCompanion(client)).companion).toBe("missing");
  });

  it("retries once then reports unreachable on a network failure", async () => {
    let calls = 0;
    const client = clientWith({ [PROBE]: { networkError: true } }, () => {
      calls++;
    });
    const snap = await probeCompanion(client);
    expect(snap.companion).toBe("unreachable");
    expect(calls).toBe(2);
  });

  it("retries once then reports unreachable on a timeout (abort)", async () => {
    let calls = 0;
    const client = clientWith({ [PROBE]: { abort: true } }, () => {
      calls++;
    });
    const snap = await probeCompanion(client);
    expect(snap.companion).toBe("unreachable");
    expect(calls).toBe(2);
  });
});

describe("buildVaultCapabilities config overrides", () => {
  it("probe_skip skips the probe and uses force_enabled as the source of truth", async () => {
    let calls = 0;
    const client = clientWith({ [PROBE]: { networkError: true } }, () => {
      calls++;
    });
    const snap = await buildVaultCapabilities(client, {
      probeSkip: true,
      forceEnabled: ["dataview", "templater"],
      forceDisabled: ["quickadd"],
    });
    expect(calls).toBe(0);
    expect(snap.companion).toBe("reachable");
    expect(snap.plugins.dataview?.installed).toBe(true);
    expect(snap.plugins.quickadd?.installed).toBe(false);
  });

  it("force_disabled overrides a probe that reported a plugin installed", async () => {
    const client = clientWith({
      [PROBE]: {
        body: { ok: true, result: { capabilities: { dataview: { installed: true } } } },
      },
    });
    const snap = await buildVaultCapabilities(client, { forceDisabled: ["dataview"] });
    expect(snap.companion).toBe("reachable");
    expect(snap.plugins.dataview?.installed).toBe(false);
  });

  it("degrades to companion-missing when no bridge client is configured", async () => {
    const snap = await buildVaultCapabilities(undefined, { forceEnabled: ["dataview"] });
    expect(snap.companion).toBe("missing");
  });
});

describe("pluginStatus + applyOverrides + CapabilityCache", () => {
  const reachable: CapabilitySnapshot = {
    companion: "reachable",
    plugins: { dataview: { installed: true, version: "1.0" }, tasks: { installed: false } },
  };

  it("reports available for an installed plugin", () => {
    expect(pluginStatus(reachable, "dataview")).toEqual({ kind: "available", version: "1.0" });
  });

  it("reports plugin_missing for an absent or not-installed plugin", () => {
    expect(pluginStatus(reachable, "tasks")).toEqual({
      kind: "plugin_missing",
      reason: "plugin_not_installed",
    });
    expect(pluginStatus(reachable, "make-md")).toEqual({
      kind: "plugin_missing",
      reason: "plugin_not_installed",
    });
  });

  it("reports companion-level degradation", () => {
    expect(pluginStatus({ companion: "missing", plugins: {} }, "dataview")).toEqual({
      kind: "plugin_missing",
      reason: "companion_missing",
    });
    expect(pluginStatus({ companion: "unreachable", plugins: {} }, "dataview")).toEqual({
      kind: "plugin_unreachable",
    });
  });

  it("applyOverrides flips installed flags", () => {
    const out = applyOverrides(reachable, { forceEnabled: ["tasks"], forceDisabled: ["dataview"] });
    expect(out.plugins.tasks?.installed).toBe(true);
    expect(out.plugins.dataview?.installed).toBe(false);
  });

  it("cache returns a stored snapshot and degrades unknown vaults as missing", () => {
    const cache = new CapabilityCache();
    cache.set("v1", reachable);
    expect(cache.get("v1").companion).toBe("reachable");
    expect(cache.has("v1")).toBe(true);
    expect(cache.get("nope").companion).toBe("missing");
  });
});
