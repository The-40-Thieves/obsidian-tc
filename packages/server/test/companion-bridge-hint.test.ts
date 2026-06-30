import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import type { CapabilityCache } from "../src/bridge";
import { type M4Deps, openCompanionBridge } from "../src/tools/m4/shared";

function deps(companion: "missing" | "unreachable"): M4Deps {
  return {
    vaultRegistry: {} as M4Deps["vaultRegistry"],
    capabilities: { get: () => ({ companion, plugins: {} }) } as unknown as CapabilityCache,
    bridgeFor: () => undefined,
  };
}

function thrownBy(fn: () => void): ObsidianTcError {
  try {
    fn();
  } catch (e) {
    return e as ObsidianTcError;
  }
  throw new Error("expected a throw");
}

describe("openCompanionBridge degradation hint", () => {
  it("points a missing companion at the plugin install command", () => {
    const e = thrownBy(() => openCompanionBridge(deps("missing"), "main"));
    expect(e).toBeInstanceOf(ObsidianTcError);
    expect(e.code).toBe("plugin_unreachable");
    expect(e.details?.companion).toBe("missing");
    expect(String(e.details?.hint)).toMatch(/plugin install/);
  });

  it("explains an unreachable companion differently (no install hint)", () => {
    const e = thrownBy(() => openCompanionBridge(deps("unreachable"), "main"));
    expect(e.details?.companion).toBe("unreachable");
    expect(String(e.details?.hint)).toMatch(/unreachable/);
    expect(String(e.details?.hint)).not.toMatch(/plugin install/);
  });
});
