// Verify the provenance chain of an installation from its config: open cache.db read-only, read the
// auth registry's keys (every state: a retired key still vouches for the records it signed), and run
// verifyProvenance. Shared by `obsidian-tc provenance verify` and `doctor`, so the two cannot
// disagree about what "intact" means. Creates and changes nothing.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { probeAuthRegistry } from "../auth/registry-open";
import { openConfiguredDatabase } from "../db/open";
import type { Database } from "../db/types";
import { registryKeyResolver } from "./signer";
import { PROVENANCE_FAULT_EVENT } from "./types";
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
  /** Recording faults still in `event_log` (its retention applies): writes that left no record, and
   *  records written over a head that failed validation. Recording is fail-open, so this is the
   *  only place an omission is visible after the process that hit it is gone. */
  faults: ProvenanceFaults;
  /** Every vault verified and (unless allowUnsigned) every record signed. */
  ok: boolean;
}

export interface ProvenanceFaults {
  omitted: number;
  headUntrusted: number;
}
const NO_FAULTS: ProvenanceFaults = { omitted: 0, headUntrusted: 0 };

function readFaults(db: Database): ProvenanceFaults {
  try {
    const rows = db
      .prepare(
        "SELECT error_code, COUNT(*) AS n FROM event_log WHERE event_type = ? GROUP BY error_code",
      )
      .all(PROVENANCE_FAULT_EVENT) as Array<{ error_code: string | null; n: number }>;
    const n = (code: string) => rows.find((r) => r.error_code === code)?.n ?? 0;
    return { omitted: n("provenance_omitted"), headUntrusted: n("provenance_head_untrusted") };
  } catch {
    return NO_FAULTS; // no event_log table: nothing could have been written to it
  }
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
    return {
      registry,
      signingKeyActive,
      tablePresent: false,
      vaults: [],
      faults: NO_FAULTS,
      ok: true,
    };
  }
  const db = await openConfiguredDatabase(cfg, "cache.db", { readonly: true });
  try {
    const has = db
      .prepare(
        "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'write_provenance'",
      )
      .get();
    if (has === undefined) {
      return {
        registry,
        signingKeyActive,
        tablePresent: false,
        vaults: [],
        faults: NO_FAULTS,
        ok: true,
      };
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
        faults: readFaults(db),
        ok: vaults.every((v) => v.ok),
      };
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close?.();
  }
}
