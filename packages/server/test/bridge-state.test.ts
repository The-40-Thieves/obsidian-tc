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

  // THE-922: a TLS trust failure means the companion IS answering — the reload-the-plugin advice
  // can never fix a cert the client does not trust, so it must win over the enabled-but-unreachable
  // branch (GH #860: the reporter hit this with a 69ms companion response and a missing
  // NODE_EXTRA_CA_CERTS).
  it("classifies a TLS trust cause as companion-untrusted-cert, beating the enabled-on-disk hint", () => {
    const s = bridgeState(
      snap({ companion: "unreachable", unreachableCause: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      { restApiOnDisk: "enabled" },
    );
    expect(s.state).toBe("degraded");
    expect(s.reason).toBe("companion-untrusted-cert");
    expect(s.remediation).toMatch(/NODE_EXTRA_CA_CERTS/);
    expect(s.remediation).not.toMatch(/reload/i);
    expect(s.causeCode).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
  });

  it.each([
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
  ])("classifies %s as a trust failure too", (code) => {
    const s = bridgeState(snap({ companion: "unreachable", unreachableCause: code }), {
      restApiOnDisk: "enabled",
    });
    expect(s.reason).toBe("companion-untrusted-cert");
  });

  // THE-922 review fix: a TLS handshake only proves something is listening with a cert on that
  // host:port (a stale process, a port squatter, an intercepting proxy) — it says nothing about
  // whether the LRA plugin is even installed. An absent/disabled on-disk hint must still win and
  // tell the operator to install/enable the plugin, not send them hunting for a companion cert.
  it("keeps the install remediation for a TLS code when onDisk is absent, but still surfaces the code", () => {
    const s = bridgeState(
      snap({ companion: "unreachable", unreachableCause: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      { restApiOnDisk: "absent" },
    );
    expect(s.reason).toBe("plugin-not-installed");
    expect(s.remediation).toMatch(/install/i);
    expect(s.causeCode).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
  });

  it("keeps the enable remediation for a TLS code when onDisk is disabled, but still surfaces the code", () => {
    const s = bridgeState(
      snap({ companion: "unreachable", unreachableCause: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      { restApiOnDisk: "disabled" },
    );
    expect(s.reason).toBe("plugin-disabled");
    expect(s.remediation).toMatch(/enable/i);
    expect(s.causeCode).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
  });

  it("keeps the reload remediation for ECONNREFUSED with an enabled on-disk hint, and surfaces the code", () => {
    const s = bridgeState(snap({ companion: "unreachable", unreachableCause: "ECONNREFUSED" }), {
      restApiOnDisk: "enabled",
    });
    expect(s.reason).toBe("enabled-but-unreachable");
    expect(s.remediation).toMatch(/reload/i);
    expect(s.causeCode).toBe("ECONNREFUSED");
  });

  it("leaves ABORT_ERR and unrecognized codes on existing behavior, but still surfaces the code", () => {
    const aborted = bridgeState(snap({ companion: "unreachable", unreachableCause: "ABORT_ERR" }));
    expect(aborted.reason).toBe("companion-unreachable");
    expect(aborted.causeCode).toBe("ABORT_ERR");

    const unknown = bridgeState(
      snap({ companion: "unreachable", unreachableCause: "SOME_WEIRD_CODE" }),
    );
    expect(unknown.reason).toBe("companion-unreachable");
    expect(unknown.causeCode).toBe("SOME_WEIRD_CODE");
  });

  it("omits causeCode when no cause was available", () => {
    const s = bridgeState(snap({ companion: "unreachable" }));
    expect(s.causeCode).toBeUndefined();
  });
});
