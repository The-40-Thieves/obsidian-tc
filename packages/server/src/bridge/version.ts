// THE-523 — the server↔plugin version handshake.
//
// The plugin declares its version and reports Obsidian's apiVersion over the bridge, but nothing
// checked either: a version skew produced divergent behaviour at whichever route changed, silently.
// This module turns that into a specific, actionable finding on two axes — the companion API major
// (already computed as snapshot.apiCompat, THE-282) and the plugin's own version against a floor.
import type { CapabilitySnapshot } from "./capabilities";

/** The bridge contract this server speaks — the single source both the handshake and the published
 *  compatibility matrix read from. minPluginVersion is the oldest companion whose routes this server
 *  trusts; minObsidianVersion mirrors the plugin manifest's minAppVersion for the matrix. */
export const SUPPORTED_BRIDGE = {
  minPluginVersion: "1.7.0",
  minObsidianVersion: "1.7.0",
  expectedApi: "1",
} as const;

/** Parse a version to [major, minor, patch], tolerating a leading `v` and a missing patch/minor. */
function parse(v: string): [number, number, number] {
  const cleaned = v.trim().replace(/^v/i, "");
  const [maj = "0", min = "0", pat = "0"] = cleaned.split(".");
  const n = (s: string) => {
    const parsed = Number.parseInt(s, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [n(maj), n(min), n(pat)];
}

/** Compare two versions numerically by major, then minor, then patch. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] as number) - (pb[i] as number);
  }
  return 0;
}

export type BridgeCompatIssueKind = "api-major-skew" | "plugin-too-old" | "plugin-version-unknown";

export interface BridgeCompatIssue {
  kind: BridgeCompatIssueKind;
  /** Hard incompatibility (true) vs a soft warning (false). Only hard issues flip `compatible`. */
  breaking: boolean;
  message: string;
}

export interface BridgeCompatResult {
  compatible: boolean;
  issues: BridgeCompatIssue[];
}

/**
 * Compare a probed snapshot against the supported bridge contract. Returns concrete issues, each
 * naming what is wrong and (via message) what to do. A not-reachable companion has nothing to
 * handshake with, so it produces no issues here — its degradation is bridge STATE, not version skew.
 */
export function checkBridgeCompat(
  snap: CapabilitySnapshot,
  supported: { minPluginVersion: string } = SUPPORTED_BRIDGE,
): BridgeCompatResult {
  if (snap.companion !== "reachable") return { compatible: true, issues: [] };

  const issues: BridgeCompatIssue[] = [];

  if (snap.apiCompat === "incompatible") {
    issues.push({
      kind: "api-major-skew",
      breaking: true,
      message: `companion API major ${snap.apiVersion ?? "?"} does not match the server's expected ${SUPPORTED_BRIDGE.expectedApi}; update the companion plugin so its API major matches, or downgrade the server.`,
    });
  }

  if (snap.pluginVersion === undefined) {
    issues.push({
      kind: "plugin-version-unknown",
      breaking: false,
      message:
        "companion did not report a version (it predates version reporting); cannot confirm it meets the supported floor — consider updating it.",
    });
  } else if (compareVersions(snap.pluginVersion, supported.minPluginVersion) < 0) {
    issues.push({
      kind: "plugin-too-old",
      breaking: true,
      message: `companion plugin ${snap.pluginVersion} is older than the supported minimum ${supported.minPluginVersion}; update the companion plugin inside Obsidian.`,
    });
  }

  return { compatible: !issues.some((i) => i.breaking), issues };
}

/** One-line summary of the breaking issues, for the single startup warn on skew. */
export function formatCompatWarning(vaultId: string, result: BridgeCompatResult): string {
  const parts = result.issues.map((i) => i.message);
  return `bridge version skew on vault "${vaultId}": ${parts.join(" | ")}`;
}
