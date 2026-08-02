// THE-521 — assembling and running the default doctor check set.
import type { BridgeStateReport } from "../bridge";
import type { CapabilityProfile } from "../capability";
import { embeddingsProviderNames, rerankerProviderNames } from "../providers/registry";
import type {
  NotesFtsView,
  ProviderRegistrationView,
  RerankerBuildableView,
  RetrievalHeadsView,
  TokenClaims,
} from "./checks";
import {
  authMaxAgeCheck,
  authPolicyCheck,
  bridgeCheck,
  nativeCheck,
  notesFtsIntegrityCheck,
  obsidianCheck,
  providerRegistrationCheck,
  rerankerBuildableCheck,
  retrievalHeadsCheck,
  runtimeCheck,
  snapshotsCheck,
} from "./checks";
import { runDoctor } from "./report";
import type { Check, DoctorReport } from "./types";

/**
 * Decode a JWT's iat/exp claims WITHOUT verifying its signature. Doctor only needs the age math to run
 * auth.maxAge; verification would require the secret and is a different concern. Defensive: any
 * malformed input returns undefined so a garbage --token degrades to "no token", never a throw.
 */
export function decodeTokenClaims(token: string): TokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8"));
    if (typeof payload?.iat === "number" && typeof payload?.exp === "number") {
      return { iat: payload.iat, exp: payload.exp };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface DoctorConfigView {
  auth: { mode: "none" | "jwt"; tokenTtlSeconds: number; readOnly: boolean };
  /** #16: retrieval-head readiness inputs (config.embeddings + config.retrieval). Optional so a
   *  pure profile-only doctor call omits the check rather than reporting a hollow one. */
  retrieval?: RetrievalHeadsView;
  /** THE-648: destructive-write snapshot policy (config.snapshots). Optional, same reasoning as
   *  retrieval above. */
  snapshots?: { enabled: boolean; retention: number };
  /** Final-review blocker 2: the configured provider names to validate against the registry.
   *  Optional, same reasoning as retrieval/snapshots above. */
  providers?: ProviderRegistrationView;
  /** THE-679: enough to answer whether a DECLARED reranker block can be built, offline. */
  rerankerBuildable?: RerankerBuildableView;
  /** THE-696: notes_fts availability, plus an optional integrity probe under `--probe`. Optional,
   *  same reasoning as retrieval/snapshots above. */
  notesFts?: NotesFtsView;
}

export interface AssembleOptions {
  config: DoctorConfigView;
  profile: CapabilityProfile;
  /** Deployed credential to inspect, as a raw JWT string. Optional. */
  token?: string;
  /** Per-vault bridge state (THE-523). When present, adds the bridge.state check. */
  bridgeReports?: { vaultId: string; report: BridgeStateReport }[];
  /** Injected clocks for determinism. */
  now?: () => string;
  nowSeconds?: () => number;
}

/** Build the default check set from config + capability profile (+ optional token) and run it. */
export async function assembleDoctorReport(opts: AssembleOptions): Promise<DoctorReport> {
  const { config, profile } = opts;
  const claims = opts.token ? decodeTokenClaims(opts.token) : undefined;

  const checks: Check[] = [
    runtimeCheck(profile),
    nativeCheck(profile),
    authPolicyCheck(config.auth),
    authMaxAgeCheck({ tokenTtlSeconds: config.auth.tokenTtlSeconds }, claims, opts.nowSeconds),
    obsidianCheck(profile),
  ];
  // #16: retrieval-head readiness, added only when the caller supplied the config-derived view.
  if (config.retrieval) checks.push(retrievalHeadsCheck(config.retrieval));
  // THE-648: snapshot policy, same optional-view reasoning.
  if (config.snapshots) checks.push(snapshotsCheck(config.snapshots));
  // Final-review blocker 2: an unregistered embeddings.provider/reranker.provider name parses
  // cleanly (both are open z.string().min(1) since the drop-in registry shipped) and is only
  // caught by the server's own boot path otherwise — doctor must catch it too, same optional-view
  // reasoning as retrieval/snapshots above.
  if (config.providers) {
    checks.push(
      providerRegistrationCheck(config.providers, {
        embeddings: embeddingsProviderNames(),
        reranker: rerankerProviderNames(),
      }),
    );
  }
  // THE-679: providers.registered above validates NAMES; this validates that a declared block can
  // actually be BUILT. A config naming model-tier without embeddings.modelTier.full hard-fails boot
  // while every name in it is perfectly valid, so doctor reported ok and exited 0.
  if (config.rerankerBuildable) checks.push(rerankerBuildableCheck(config.rerankerBuildable));
  // THE-696: notes_fts soundness. health.fts_enabled reports AVAILABILITY and stayed true while the
  // live index was malformed and silently serving partial answers — the same configured-vs-verified
  // gap THE-688 closed for the embeddings provider.
  if (config.notesFts) checks.push(notesFtsIntegrityCheck(config.notesFts));

  // bridge.state (THE-523) is added only when the caller probed the vaults — doctor's CLI wiring
  // does; a pure profile-only call omits it rather than reporting a hollow "no bridge".
  if (opts.bridgeReports) checks.push(bridgeCheck(opts.bridgeReports));

  return runDoctor(checks, {
    serverVersion: profile.serverVersion,
    ...(opts.now ? { now: opts.now } : {}),
  });
}
