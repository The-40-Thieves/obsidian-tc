// The `doctor --probe` index probes that need config-derived inputs (ACL, exclusion state, the
// embedding width). Lifted out of doctor.ts, which sits against biome's 700-line ceiling; the probes
// themselves live in doctor/index-coverage.ts and doctor/embedding-integrity.ts.
import { makeIndexReadable } from "../../acl";
import { probeEmbeddingIntegrity } from "../../doctor/embedding-integrity";
import { probeIndexCoverage } from "../../doctor/index-coverage";
import { buildAcls } from "../../runtime/acl-build";
import { exclusionStatePath, loadVaultExclusion } from "../../search/index-exclusion";
import { canonicalizeVaultRoot } from "../../vault/registry";
import type { ResolvedServeConfig } from "../resolve-config";

type DoctorConfig = ResolvedServeConfig["config"];

export function probeIndexCoverageFor(config: DoctorConfig, busyTimeoutMs: number) {
  const { acl, aclByVault } = buildAcls(config.acl, config.vaults);
  const indexReadableFor = makeIndexReadable(acl, aclByVault);
  return probeIndexCoverage(
    config.cacheDir,
    config.vaults.map((v) => ({
      id: v.id,
      root: canonicalizeVaultRoot(v.path),
      isReadable: indexReadableFor(v.id),
      exclusion: loadVaultExclusion(
        canonicalizeVaultRoot(v.path),
        v.index?.excludePaths,
        exclusionStatePath(config.cacheDir, canonicalizeVaultRoot(v.path)),
      ),
    })),
    busyTimeoutMs,
  );
}

/** GH #1160: the width is the config's AFTER sticky resolution (doctor.ts applies it first). */
export function probeEmbeddingIntegrityFor(config: DoctorConfig, busyTimeoutMs: number) {
  return probeEmbeddingIntegrity(config.cacheDir, config.embeddings.dimensions, busyTimeoutMs);
}
