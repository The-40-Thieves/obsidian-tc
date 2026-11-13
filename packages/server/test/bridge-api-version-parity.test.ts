// The bridge API major exists in three places that cannot import each other: the companion
// plugin's API_VERSION (what /probe reports), the server's EXPECTED_COMPANION_API (what the probe
// is compared against) and SUPPORTED_BRIDGE.expectedApi (what the handshake message names). A bump
// to one without the others makes every live companion read as incompatible, or a real skew read
// as compatible. The plugin side is read as source text: the plugin package cannot be imported here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXPECTED_COMPANION_API } from "../src/bridge/capabilities";
import { SUPPORTED_BRIDGE } from "../src/bridge/version";

const PLUGIN_PROBE = new URL("../../plugin/src/routes/probe.ts", import.meta.url);

describe("bridge API version parity (server <-> companion plugin)", () => {
  it("the plugin's API_VERSION equals the server's EXPECTED_COMPANION_API", () => {
    const src = readFileSync(PLUGIN_PROBE, "utf8");
    const m = /const API_VERSION = "([^"]+)";/.exec(src);
    expect(
      m,
      "API_VERSION literal not found in packages/plugin/src/routes/probe.ts",
    ).not.toBeNull();
    expect(m?.[1]).toBe(EXPECTED_COMPANION_API);
  });

  it("SUPPORTED_BRIDGE.expectedApi equals EXPECTED_COMPANION_API", () => {
    expect(SUPPORTED_BRIDGE.expectedApi).toBe(EXPECTED_COMPANION_API);
  });
});
