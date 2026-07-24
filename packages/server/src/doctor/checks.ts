// THE-521 — the individual checks. Each is a factory taking injected inputs and returning a Check,
// so it is unit-testable with no live server, DB, or network.

import type { BridgeStateReport } from "../bridge";
import type { CapabilityProfile } from "../capability";
import type { Check, CheckStatus } from "./types";

/** #16 (audit THE-562): the readiness inputs for the four retrieval heads, derived from
 *  config.embeddings + config.retrieval. The sparse/ColBERT streams only emit when the embeddings
 *  provider produces the multi-vector heads (bge-m3 or model-tier + modelTier.full). */
export interface RetrievalHeadsView {
  denseProvider: string;
  denseModel: string;
  denseDimensions: number;
  /** The embeddings provider emits the multi-vector (sparse/ColBERT) heads. */
  multiVector: boolean;
  sparseEnabled: boolean;
  colbertEnabled: boolean;
}

/** retrieval.heads — dense / sparse / ColBERT / reranker readiness, reported INDEPENDENTLY so an
 *  operator can see which streams are actually live vs enabled-but-inert. A stream enabled in
 *  config.retrieval but unbacked by the provider (no multi-vector head) is a no-op — surfaced as a
 *  warning rather than a silent nothing. */
export function retrievalHeadsCheck(view: RetrievalHeadsView): Check {
  return {
    id: "retrieval.heads",
    category: "retrieval",
    run: () => {
      const details: Record<string, string> = {
        dense: `ready (${view.denseProvider}, ${view.denseModel}, dim ${view.denseDimensions})`,
      };
      const issues: string[] = [];
      const notes: string[] = [];

      const streamStatus = (enabled: boolean, name: string): string => {
        if (!enabled) return `off (opt-in via retrieval.${name})`;
        if (view.multiVector) return `ready (${view.denseProvider} multi-vector head)`;
        issues.push(
          `retrieval.${name} is enabled but the '${view.denseProvider}' embeddings provider emits no multi-vector head — the ${name} stream is a no-op`,
        );
        return `INERT — enabled, but '${view.denseProvider}' emits no multi-vector head`;
      };
      details.sparse = streamStatus(view.sparseEnabled, "sparse");
      details.colbert = streamStatus(view.colbertEnabled, "colbert");

      if (view.multiVector) {
        details.reranker = `model-tier / ColBERT rerank capable (${view.denseProvider}); or the inference gateway /rerank passthrough when configured`;
      } else {
        details.reranker =
          "RRF-only unless the inference gateway is configured for /rerank passthrough";
        notes.push(
          "no model-tier reranker for this provider — reranking depends on the inference gateway (env-configured)",
        );
      }

      const status: CheckStatus = issues.length > 0 ? "warning" : "ok";
      return {
        status,
        summary:
          status === "ok"
            ? "retrieval heads: dense ready; sparse/ColBERT/reranker reported per config"
            : "a retrieval stream is enabled but inert (provider emits no multi-vector head)",
        details,
        ...(issues.length ? { issues } : {}),
        ...(notes.length ? { notes } : {}),
        ...(issues.length
          ? {
              remediation:
                "Set embeddings.provider to bge-m3 or model-tier (with modelTier.full) to activate the sparse/ColBERT streams, or disable retrieval.sparse / retrieval.colbert.",
            }
          : {}),
      };
    },
  };
}

/** runtime.versions — server, runtime and native module, read from the capability profile. */
export function runtimeCheck(profile: CapabilityProfile): Check {
  return {
    id: "runtime.versions",
    category: "runtime",
    run: () => ({
      status: "ok",
      summary: `${profile.serverVersion} on ${profile.runtime.name} ${profile.runtime.version}`,
      details: {
        serverVersion: profile.serverVersion,
        runtime: `${profile.runtime.name} ${profile.runtime.version}`,
        nativeModule: String(profile.runtime.nativeModule),
      },
    }),
  };
}

/** native.availability — a warning (not a failure) when the accelerated module fell back to JS. */
export function nativeCheck(profile: CapabilityProfile): Check {
  return {
    id: "native.availability",
    category: "runtime",
    run: () =>
      profile.runtime.nativeModule
        ? { status: "ok", summary: "native acceleration module loaded" }
        : {
            status: "warning",
            summary: "native module not loaded — running on the JS fallback path",
            remediation:
              "Reinstall so the platform-native module builds, or ignore if the JS path is acceptable for this deployment.",
          },
  };
}

export interface AuthPolicy {
  mode: "none" | "jwt";
  tokenTtlSeconds: number;
  readOnly: boolean;
}

/** auth.policy — the effective auth posture from config. Warns loudly on mode "none". */
export function authPolicyCheck(policy: AuthPolicy): Check {
  return {
    id: "auth.policy",
    category: "auth",
    run: () => {
      const details = {
        mode: policy.mode,
        tokenTtlSeconds: String(policy.tokenTtlSeconds),
        readOnly: String(policy.readOnly),
      };
      if (policy.mode === "none") {
        return {
          status: "warning",
          summary: "auth.mode is none — every request resolves to full wildcard scopes",
          details,
          remediation:
            "Set auth.mode to jwt (with a jwtSecret or JWKS) before exposing this server.",
        };
      }
      return { status: "ok", summary: `auth.mode ${policy.mode}`, details };
    },
  };
}

/** A decoded token's time claims, in seconds since the epoch. */
export interface TokenClaims {
  iat: number;
  exp: number;
}

/**
 * auth.maxAge — THE-520. tokenTtlSeconds caps a token's AGE from `iat`, independently of `exp`. This
 * check makes the distinction explicit: it computes the max-age-derived expiry (iat + ttl) alongside
 * the token's own exp, reports WHICH one binds, and fails/warns when max-age is the earlier bound —
 * the exact silent-killer that read healthy at every other layer.
 *
 * With no token to inspect it degrades to an informational note stating the configured max age, since
 * the failure mode is invisible without a real token's iat.
 */
export function authMaxAgeCheck(
  policy: { tokenTtlSeconds: number },
  token: TokenClaims | undefined,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): Check {
  return {
    id: "auth.maxAge",
    category: "auth",
    run: () => {
      const ttl = policy.tokenTtlSeconds;
      if (!token) {
        return {
          status: "ok",
          summary: "no deployed token to inspect — reporting configured max age only",
          details: { tokenTtlSeconds: String(ttl) },
          notes: [
            "tokenTtlSeconds caps a token's AGE from its iat, independently of exp: a token with a far-future exp is still rejected once older than this. Supply a token to check the deployed credential.",
          ],
        };
      }

      const maxAgeExpiry = token.iat + ttl;
      const binding = maxAgeExpiry < token.exp ? "max-age" : "exp";
      const effectiveExpiry = Math.min(maxAgeExpiry, token.exp);
      const now = nowSeconds();
      const details = {
        bindingConstraint: binding,
        maxAgeExpiry: new Date(maxAgeExpiry * 1000).toISOString(),
        tokenExp: new Date(token.exp * 1000).toISOString(),
        effectiveExpiry: new Date(effectiveExpiry * 1000).toISOString(),
      };

      if (now >= effectiveExpiry) {
        const why =
          binding === "max-age"
            ? "token is past its MAX AGE (iat + tokenTtlSeconds) even though exp is still in the future"
            : "token is past its exp";
        return {
          status: "fail",
          summary: `deployed token is not valid: ${why}`,
          details,
          issues: [why],
          remediation:
            binding === "max-age"
              ? "Re-mint the token, or raise auth.tokenTtlSeconds to match the token's intended lifetime."
              : "Re-mint the token with a later exp.",
        };
      }

      if (binding === "max-age") {
        return {
          status: "warning",
          summary: "token is valid, but its max age will expire it well before its exp",
          details,
          remediation:
            "Raise auth.tokenTtlSeconds to at least the token's exp-minus-iat lifetime, or plan to re-mint before the max age.",
        };
      }

      return { status: "ok", summary: "token is within both its exp and its max age", details };
    },
  };
}

/** bridge.state (THE-523) — per-vault live/headless/degraded with reasons. A degraded vault (version
 *  skew, or the previously-invisible enabled-but-unreachable) is a warning with actionable
 *  remediation; live and headless are both healthy states. */
export function bridgeCheck(reports: { vaultId: string; report: BridgeStateReport }[]): Check {
  return {
    id: "bridge.state",
    category: "bridge",
    run: () => {
      const details: Record<string, string> = {};
      for (const { vaultId, report } of reports) {
        details[vaultId] = `${report.state} (${report.reason})`;
      }
      const degraded = reports.filter((r) => r.report.state === "degraded");
      if (degraded.length > 0) {
        const first = degraded[0];
        return {
          status: "warning",
          summary: `${degraded.length} vault(s) degraded: ${degraded.map((d) => `${d.vaultId} [${d.report.reason}]`).join(", ")}`,
          details,
          ...(first?.report.remediation ? { remediation: first.report.remediation } : {}),
        };
      }
      return {
        status: "ok",
        summary:
          reports.length === 0
            ? "no vaults configured"
            : `${reports.length} vault(s): ${reports.map((r) => `${r.vaultId}=${r.report.state}`).join(", ")}`,
        details,
      };
    },
  };
}

/** obsidian detection — surfaces what THE-522 found. No install is a supported state, not a failure. */
export function obsidianCheck(profile: CapabilityProfile): Check {
  return {
    id: "obsidian.detection",
    category: "obsidian",
    run: () => {
      const { installed, vaults } = profile.obsidian;
      if (!installed && vaults.length === 0) {
        return {
          status: "ok",
          summary: "no Obsidian install detected (headless/server mode)",
          notes: [
            "No Obsidian registry found — this is a supported state. Add vaults explicitly in config.",
          ],
        };
      }
      const names = vaults.map((v) => v.name);
      const withRest = vaults.filter((v) =>
        v.plugins.installed.some((p) => p.id === "obsidian-local-rest-api" && p.enabled),
      ).length;
      return {
        status: "ok",
        summary: `detected ${vaults.length} vault(s): ${names.join(", ")}`,
        details: {
          vaults: String(vaults.length),
          vaultNames: names,
          localRestApiEnabled: `${withRest}/${vaults.length}`,
        },
      };
    },
  };
}
