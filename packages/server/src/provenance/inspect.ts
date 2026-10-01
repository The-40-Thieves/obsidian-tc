// Verify the provenance chain of an installation from its config: open cache.db read-only, read the
// auth registry's keys (every state: a retired key still vouches for the records it signed), and run
// verifyProvenance. Shared by `obsidian-tc provenance verify` and `doctor`, so the two cannot
// disagree about what "intact" means. Creates and changes nothing.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { probeAuthRegistry } from "../auth/registry-open";
import { openConfiguredDatabase } from "../db/open";
import { registryKeyResolver } from "./signer";
import { type VaultVerification, verifyProvenance } from "./verify";

export interface ProvenanceInspection {
  /** The auth registry reading the verification rested on. `lost` means signatures cannot be
   *  checked, so the caller must refuse rather than report a verdict. */
  registry: { state: "uninitialised" | "ok" | "lost"; detail?: string };
  /** An ACTIVE EdDSA key exists, so the next record will be signed. */
  signingKeyActive: boolean;
  /** cache.db exists and carries the write_provenance tables. */
  tablePresent: boolean;
  vaults: VaultVerification[];
  /** Every vault verified and (unless allowUnsigned) every record signed. */
  ok: boolean;
}

export async function inspectProvenance(
  cfg: Pick<ServerConfig, "cacheDir" | "db" | "auth">,
  opts: { vault?: string; allowUnsigned?: boolean } = {},
): Promise<ProvenanceInspection> {
  const probe = await probeAuthRegistry(cfg);
  const keys = probe.keys ?? [];
  const now = Date.now();
  const signingKeyActive = keys.some(
    (k) =>
      k.alg === "EdDSA" &&
      k.state === "active" &&
      (k.retireAfter === null || k.retireAfter > now) &&
      k.publicJwk !== null,
  );
  const registry = {
    state:
      probe.health.state === "lost"
        ? ("lost" as const)
        : probe.health.state === "uninitialised"
          ? ("uninitialised" as const)
          : ("ok" as const),
    ...(probe.health.state === "lost" ? { detail: probe.health.detail } : {}),
  };
  const dbPath = join(cfg.cacheDir, "cache.db");
  if (!existsSync(dbPath)) {
    return { registry, signingKeyActive, tablePresent: false, vaults: [], ok: true };
  }
  const db = await openConfiguredDatabase(cfg, "cache.db", { readonly: true });
  try {
    const has = db
      .prepare(
        "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'write_provenance'",
      )
      .get();
    if (has === undefined) {
      return { registry, signingKeyActive, tablePresent: false, vaults: [], ok: true };
    }
    // One read transaction: the records and the head row must come from the same snapshot, or a
    // write landing between the two reads would look like a removed tail.
    db.exec("BEGIN");
    try {
      const vaults = verifyProvenance(
        db,
        {
          resolveKey: registryKeyResolver(keys),
          ...(opts.allowUnsigned === true ? { allowUnsigned: true } : {}),
        },
        opts.vault,
      );
      return {
        registry,
        signingKeyActive,
        tablePresent: true,
        vaults,
        ok: vaults.every((v) => v.ok),
      };
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close?.();
  }
}
