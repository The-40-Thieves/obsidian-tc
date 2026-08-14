// THE-825 / GH #786 — the plane opt-in boot notice. `plane.enabled` flipped from defaulting
// `true` to defaulting `false`, and the failure mode of a silent flip is exactly the shape this
// project keeps filing tickets about: the plane just stops, and "why is nothing being
// consolidated" becomes a support path. `formatPlaneOptInNotice` decides whether a deployment
// gets one loud, actionable stderr line at boot -- see server-runtime.ts's `start()`, which calls
// it with `gatewayConfigured: roles !== null` and the `planeEnabledExplicit` flag threaded all the
// way from `resolveServeConfigWithProvenance` (cli/args.ts).
//
// Pure function, mirroring reconcile-outcome.ts's `applyReconcileOutcome`: assertable without
// booting a real runtime or connecting stdio.
import { describe, expect, it } from "vitest";
import { formatPlaneOptInNotice } from "../src/runtime/plane-opt-in-notice";

describe("formatPlaneOptInNotice (THE-825)", () => {
  it("gateway configured + plane.enabled absent -> emits, naming the config key", () => {
    const notice = formatPlaneOptInNotice({
      gatewayConfigured: true,
      planeEnabledExplicit: false,
    });
    expect(notice).not.toBeNull();
    expect(notice).toContain("plane.enabled");
    // Actionable: names the exact key to add, not just that something changed.
    expect(notice).toContain('"plane": { "enabled": true }');
    expect(notice).toContain("obsidian-tc.config.json");
  });

  it("gateway configured + plane.enabled explicitly false -> does NOT emit (deliberate opt-out)", () => {
    const notice = formatPlaneOptInNotice({
      gatewayConfigured: true,
      planeEnabledExplicit: true,
    });
    expect(notice).toBeNull();
  });

  it("no gateway -> never emits, regardless of planeEnabledExplicit (the setting is inert without one)", () => {
    expect(
      formatPlaneOptInNotice({ gatewayConfigured: false, planeEnabledExplicit: false }),
    ).toBeNull();
    expect(
      formatPlaneOptInNotice({ gatewayConfigured: false, planeEnabledExplicit: true }),
    ).toBeNull();
  });

  it("gateway configured + plane.enabled explicitly true -> does NOT emit (already on)", () => {
    // planeEnabledExplicit is true whether the raw file set true or false -- either way it is a
    // stated fact, not a default, so there is nothing to nag about.
    const notice = formatPlaneOptInNotice({
      gatewayConfigured: true,
      planeEnabledExplicit: true,
    });
    expect(notice).toBeNull();
  });
});
