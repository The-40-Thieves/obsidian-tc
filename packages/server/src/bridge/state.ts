// THE-523 — bridge.state as a first-class reported value.
//
// Maps a capability snapshot (+ optional on-disk detection from THE-522) to an explicit
// live | headless | degraded state WITH a reason, so an operator can answer "which mode am I in, and
// why?" rather than seeing the surface silently shrink to "headless". The on-disk hint is what turns
// one indistinguishable "headless" into the three distinct operator actions the ticket calls out.
import type { CapabilitySnapshot } from "./capabilities";
import { checkBridgeCompat } from "./version";

export type BridgeMode = "live" | "headless" | "degraded";

export type BridgeReason =
  | "companion-reachable"
  | "version-skew"
  | "companion-unreachable"
  | "plugin-not-installed"
  | "plugin-disabled"
  | "enabled-but-unreachable"
  | "companion-untrusted-cert"
  | "companion-missing";

/** On-disk enabled-state of the Local REST API plugin, from THE-522 detection. */
export type RestApiOnDisk = "absent" | "disabled" | "enabled";

export interface BridgeStateReport {
  state: BridgeMode;
  reason: BridgeReason;
  remediation?: string;
  pluginVersion?: string;
  obsidianApiVersion?: string;
  /** THE-922: the fetch cause code verbatim, when the companion did not answer — surfaced even for
   *  a code this server does not classify, so one line replaces a session of blind diagnosis. */
  causeCode?: string;
}

// THE-922: TLS/trust codes — the companion IS answering, but the client does not trust its
// certificate (the Local REST API plugin serves a self-signed cert by default). Any of these
// means "fix the cert", never "reload the plugin".
const TLS_TRUST_CODES: ReadonlySet<string> = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function isTlsTrustCode(code: string | undefined): boolean {
  if (!code) return false;
  return TLS_TRUST_CODES.has(code) || code.startsWith("CERT_") || code.startsWith("ERR_TLS_");
}

export interface BridgeStateHints {
  /** What THE-522 found on disk for obsidian-local-rest-api, if available. */
  restApiOnDisk?: RestApiOnDisk;
}

function carry(
  snap: CapabilitySnapshot,
  r: Omit<BridgeStateReport, "pluginVersion" | "obsidianApiVersion">,
): BridgeStateReport {
  return {
    ...r,
    ...(snap.pluginVersion ? { pluginVersion: snap.pluginVersion } : {}),
    ...(snap.apiVersion ? { obsidianApiVersion: snap.apiVersion } : {}),
  };
}

/**
 * Resolve the bridge state and reason. The on-disk hint refines the "companion did not answer" cases:
 *   absent   -> plugin-not-installed (install it)
 *   disabled -> plugin-disabled (enable it)
 *   enabled  -> enabled-but-unreachable (reload the companion inside Obsidian — the invisible failure)
 */
export function bridgeState(
  snap: CapabilitySnapshot,
  hints: BridgeStateHints = {},
): BridgeStateReport {
  if (snap.companion === "reachable") {
    const compat = checkBridgeCompat(snap);
    if (!compat.compatible) {
      return carry(snap, {
        state: "degraded",
        reason: "version-skew",
        remediation: compat.issues.find((i) => i.breaking)?.message,
      });
    }
    return carry(snap, { state: "live", reason: "companion-reachable" });
  }

  const onDisk = hints.restApiOnDisk;
  const causeCode = snap.companion === "unreachable" ? snap.unreachableCause : undefined;

  // THE-922: a trusted-cert failure wins over the enabled-but-unreachable branch below — the
  // companion IS answering, so "reload the plugin" can never fix it. But it does NOT win over an
  // absent/disabled on-disk hint: a TLS handshake only proves something is listening with a cert
  // on that host:port (a stale process, a port squatter, an intercepting proxy), never that the
  // LRA plugin itself exists — with onDisk absent/disabled the operator must still be told to
  // install/enable the plugin, not sent hunting for a companion cert.
  if (isTlsTrustCode(causeCode) && onDisk !== "absent" && onDisk !== "disabled") {
    return carry(snap, {
      state: "degraded",
      reason: "companion-untrusted-cert",
      remediation:
        "The companion answered but its certificate is not trusted — the Local REST API plugin serves a self-signed cert by default. Locate/export that cert and set NODE_EXTRA_CA_CERTS to it (an MCP client's env does this automatically; a hand-run CLI does not), then refresh capabilities.",
      ...(causeCode ? { causeCode } : {}),
    });
  }

  // Enabled on disk but no answer: the companion is loaded in Obsidian's config yet not responding —
  // almost always it needs reloading inside Obsidian. This case was previously invisible.
  if (onDisk === "enabled") {
    return carry(snap, {
      state: "degraded",
      reason: "enabled-but-unreachable",
      remediation:
        "The Local REST API plugin is enabled on disk but the companion did not answer — reload the plugin inside Obsidian (or restart Obsidian), then refresh capabilities.",
      ...(causeCode ? { causeCode } : {}),
    });
  }
  if (onDisk === "absent") {
    return carry(snap, {
      state: "headless",
      reason: "plugin-not-installed",
      remediation:
        "Install the Local REST API plugin in this vault and enable it for live-mode tools.",
      ...(causeCode ? { causeCode } : {}),
    });
  }
  if (onDisk === "disabled") {
    return carry(snap, {
      state: "headless",
      reason: "plugin-disabled",
      remediation:
        "The Local REST API plugin is installed but disabled — enable it in Obsidian for live-mode tools.",
      ...(causeCode ? { causeCode } : {}),
    });
  }

  // No on-disk hint: fall back to the snapshot's companion state.
  if (snap.companion === "unreachable") {
    return carry(snap, {
      state: "degraded",
      reason: "companion-unreachable",
      remediation:
        "The companion endpoint is configured but did not answer — check the Local REST API URL, key, and that Obsidian is running.",
      ...(causeCode ? { causeCode } : {}),
    });
  }
  return carry(snap, {
    state: "headless",
    reason: "companion-missing",
    remediation:
      "No companion detected — running headless (direct filesystem). Configure the Local REST API for live-mode tools.",
  });
}
