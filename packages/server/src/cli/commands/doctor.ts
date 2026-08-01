import {
  bridgeState,
  buildVaultCapabilities,
  createBridgeClient,
  type RestApiOnDisk,
} from "../../bridge";
import { resolveCapabilityProfile } from "../../capability";
import { assembleDoctorReport, renderText } from "../../doctor";
import { type Cmd, resolveOrUsageExit } from "../shared";

// THE-523: derive the Local REST API plugin's on-disk state for a vault from the THE-522 capability
// profile — absent / disabled / enabled — so bridgeState can distinguish "cannot" from "will not".
// Returns undefined when the vault was not detected on disk (nothing to say).
function restApiOnDisk(
  profile: Awaited<ReturnType<typeof resolveCapabilityProfile>>,
  vaultPath: string,
): RestApiOnDisk | undefined {
  const vault = profile.obsidian.vaults.find((v) => v.path === vaultPath);
  if (!vault) return undefined;
  const plugin = vault.plugins.installed.find((p) => p.id === "obsidian-local-rest-api");
  if (!plugin) return "absent";
  return plugin.enabled ? "enabled" : "disabled";
}

// THE-521 — runtime health probe. Loads config, detects the environment (THE-522), runs the default
// check set, and emits either the versioned JSON envelope or human text rendered from it. Exits
// non-zero when any check fails, so scripts and CI can gate on health — a warning does not fail.
export async function run_doctor(cmd: Cmd<"doctor">): Promise<void> {
  const config = resolveOrUsageExit(cmd.configPath);
  // Include the configured vault paths so they appear even when the desktop registry is absent
  // (headless/server boxes), which is exactly where doctor is most useful.
  const profile = await resolveCapabilityProfile({
    extraVaultPaths: config.vaults.map((v) => v.path),
  });

  // THE-523 bridge.state: probe each vault's companion live, then resolve state using the THE-522
  // on-disk detection so "cannot vs will not" is distinguished (absent / disabled / enabled-but-
  // unreachable). Probing never throws — a vault with no endpoint resolves to headless.
  const bridgeReports = await Promise.all(
    config.vaults.map(async (v) => {
      const client = v.restApiUrl
        ? createBridgeClient({
            baseUrl: v.restApiUrl,
            apiKey: v.restApiKey,
            timeoutMs: v.bridges?.timeoutMs,
          })
        : undefined;
      const snap = await buildVaultCapabilities(client, {
        probeSkip: v.plugins?.probeSkip,
        forceEnabled: v.plugins?.forceEnabled,
        forceDisabled: v.plugins?.forceDisabled,
        timeoutMs: v.bridges?.probeTimeoutMs,
      });
      return {
        vaultId: v.id,
        report: bridgeState(snap, { restApiOnDisk: restApiOnDisk(profile, v.path) }),
      };
    }),
  );

  const report = await assembleDoctorReport({
    config: {
      auth: {
        mode: config.auth.mode,
        tokenTtlSeconds: config.auth.tokenTtlSeconds,
        readOnly: config.acl.readOnly,
      },
      // #16: retrieval-head readiness. The sparse/ColBERT streams only emit when the provider
      // produces the multi-vector heads (bge-m3, or model-tier with modelTier.full configured).
      retrieval: {
        denseProvider: config.embeddings.provider,
        denseModel: config.embeddings.model,
        denseDimensions: config.embeddings.dimensions,
        multiVector:
          config.embeddings.provider === "bge-m3" ||
          (config.embeddings.provider === "model-tier" &&
            config.embeddings.modelTier?.full !== undefined),
        // A provider name no longer implies a capability set: a generic provider may well point at
        // a bge-m3 endpoint. Report what is CONFIGURED rather than inferring from the name.
        rerankerConfigured: config.reranker?.provider,
        sparseEnabled: config.retrieval.sparse,
        colbertEnabled: config.retrieval.colbert,
      },
      // THE-648: snapshots default to enabled; surface the effective posture either way.
      snapshots: { enabled: config.snapshots.enabled, retention: config.snapshots.retention },
    },
    profile,
    bridgeReports,
    ...(cmd.token !== undefined ? { token: cmd.token } : {}),
  });

  process.stdout.write(
    cmd.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report)}\n`,
  );
  if (report.overallStatus === "fail") process.exit(1);
}
