// THE-523: the server↔plugin version handshake. Today the pieces are half-built — the plugin
// declares its version and reports obsidian apiVersion over the bridge, but NOTHING on the server
// checks either, so a server on 1.10.0 talking to a plugin on 1.6.0 just behaves oddly at whichever
// route diverged. This turns a silent divergence into a SPECIFIC, actionable finding.
//
// Two independent axes: the companion API major (already computed as snapshot.apiCompat, THE-282) and
// the plugin's own semantic version against a declared floor. checkBridgeCompat combines them into a
// list of concrete issues, each naming what is wrong and what to do.
import { describe, expect, it } from "vitest";
import type { CapabilitySnapshot } from "../src/bridge/capabilities";
import { checkBridgeCompat, compareVersions, SUPPORTED_BRIDGE } from "../src/bridge/version";

const snap = (over: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot => ({
  companion: "reachable",
  plugins: {},
  pluginVersion: SUPPORTED_BRIDGE.minPluginVersion,
  apiVersion: "1",
  apiCompat: "compatible",
  ...over,
});

describe("THE-523 compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("1.10.0", "1.6.0")).toBeGreaterThan(0);
    expect(compareVersions("1.6.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.10.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  it("tolerates a leading v and missing patch segment", () => {
    expect(compareVersions("v1.10", "1.10.0")).toBe(0);
    expect(compareVersions("1.7", "1.7.0")).toBe(0);
  });
});

describe("THE-523 checkBridgeCompat", () => {
  it("is compatible when api major matches and plugin meets the floor", () => {
    const r = checkBridgeCompat(snap());
    expect(r.compatible).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("flags an API-major skew with a specific issue", () => {
    const r = checkBridgeCompat(snap({ apiCompat: "incompatible", apiVersion: "2" }));
    expect(r.compatible).toBe(false);
    const issue = r.issues.find((i) => i.kind === "api-major-skew");
    expect(issue).toBeTruthy();
    expect(issue?.message).toMatch(/API/i);
  });

  it("flags a plugin older than the supported floor, naming both versions", () => {
    const r = checkBridgeCompat(snap({ pluginVersion: "1.6.0" }));
    expect(r.compatible).toBe(false);
    const issue = r.issues.find((i) => i.kind === "plugin-too-old");
    expect(issue?.message).toContain("1.6.0");
    expect(issue?.message).toContain(SUPPORTED_BRIDGE.minPluginVersion);
  });

  it("does not flag a plugin NEWER than the server floor", () => {
    const r = checkBridgeCompat(snap({ pluginVersion: "99.0.0" }));
    expect(r.compatible).toBe(true);
  });

  it("notes an unknown plugin version rather than asserting compatibility", () => {
    const { pluginVersion, ...noVersion } = snap();
    const r = checkBridgeCompat(noVersion as CapabilitySnapshot);
    // Missing version is a soft warning, not a hard incompatibility — an old companion predating
    // version reporting still answered the probe.
    expect(r.issues.some((i) => i.kind === "plugin-version-unknown")).toBe(true);
    expect(r.compatible).toBe(true);
  });

  it("returns no issues when the companion is not reachable (nothing to handshake with)", () => {
    const r = checkBridgeCompat(snap({ companion: "missing" }));
    expect(r.issues).toEqual([]);
    expect(r.compatible).toBe(true);
  });
});
