// THE-523: bridge.state as a first-class reported value. Today an operator cannot answer "which mode
// am I in, and why?" — the startup line shows capability flags but not bridge provenance, and when
// the desktop app closes the surface silently shrinks to "headless" with no reason.
//
// The key distinction the ticket demands: "cannot" vs "will not". A companion that does not answer
// could be absent, present-but-disabled, or enabled-but-unreachable — three DIFFERENT operator
// actions, currently one indistinguishable "headless". THE-522's on-disk detection supplies that
// missing axis, so bridgeState takes an optional onDisk hint to refine the reason.
import { describe, expect, it } from "vitest";
import type { CapabilitySnapshot } from "../src/bridge/capabilities";
import { bridgeState } from "../src/bridge/state";

const snap = (over: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot => ({
  companion: "reachable",
  plugins: {},
  pluginVersion: "1.10.0",
  apiVersion: "1",
  apiCompat: "compatible",
  ...over,
});

describe("THE-523 bridgeState", () => {
  it("reports live when the companion is reachable and compatible", () => {
    const s = bridgeState(snap());
    expect(s.state).toBe("live");
    expect(s.reason).toBe("companion-reachable");
  });

  it("reports degraded with a version-skew reason when reachable but incompatible", () => {
    const s = bridgeState(snap({ apiCompat: "incompatible", apiVersion: "2" }));
    expect(s.state).toBe("degraded");
    expect(s.reason).toBe("version-skew");
  });

  it("reports headless when the companion is missing", () => {
    const s = bridgeState(snap({ companion: "missing" }));
    expect(s.state).toBe("headless");
  });

  it("reports degraded when the companion is present but unreachable", () => {
    const s = bridgeState(snap({ companion: "unreachable" }));
    expect(s.state).toBe("degraded");
    expect(s.reason).toBe("companion-unreachable");
  });

  // The "cannot vs will not" distinction — same companion=missing, three different operator actions.
  it("distinguishes plugin absent from disk", () => {
    const s = bridgeState(snap({ companion: "missing" }), { restApiOnDisk: "absent" });
    expect(s.reason).toBe("plugin-not-installed");
    expect(s.remediation).toMatch(/install/i);
  });

  it("distinguishes plugin present-but-disabled from disk", () => {
    const s = bridgeState(snap({ companion: "missing" }), { restApiOnDisk: "disabled" });
    expect(s.reason).toBe("plugin-disabled");
    expect(s.remediation).toMatch(/enable/i);
  });

  it("flags the invisible failure: enabled on disk but the probe cannot reach it", () => {
    // This is the currently-invisible case — the plugin is enabled in Obsidian's config but the
    // companion did not answer, which usually means the companion needs reloading inside Obsidian.
    const s = bridgeState(snap({ companion: "unreachable" }), { restApiOnDisk: "enabled" });
    expect(s.state).toBe("degraded");
    expect(s.reason).toBe("enabled-but-unreachable");
    expect(s.remediation).toMatch(/reload|restart/i);
  });

  it("carries the probed versions through for reporting", () => {
    const s = bridgeState(snap());
    expect(s.pluginVersion).toBe("1.10.0");
    expect(s.obsidianApiVersion).toBe("1");
  });
});
