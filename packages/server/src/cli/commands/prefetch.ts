import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../db/open";
import { createEmbeddingProvider } from "../../embeddings";
import { ToolRegistry } from "../../mcp/registry";
import { readGeneration } from "../../search/generation";
import { callerAclFingerprint, prewarmPathFor, writePrewarm } from "../../search/prefetch";
import { DEFAULT_MEMORY_FOLDER } from "../../tools/m5";
import { registerM7Tools } from "../../tools/m7";
import { VaultRegistry } from "../../vault/registry";
import { type Cmd, resolveOrUsageExit } from "../shared";

export async function run_prefetch(cmd: Cmd<"prefetch">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  mkdirSync(cfg.cacheDir, { recursive: true });
  const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
  const provider = createEmbeddingProvider(cfg.embeddings);
  const pfVaultRegistry = new VaultRegistry(cfg.vaults);
  const memByVault = new Map<string, string>();
  for (const v of cfg.vaults) if (v.memory) memByVault.set(v.id, v.memory.folder);
  const pfRegistry = new ToolRegistry({});
  registerM7Tools(pfRegistry, {
    vaultRegistry: pfVaultRegistry,
    embeddingProvider: provider,
    reranker: null,
    roles: null,
    retrieval: cfg.retrieval,
    ranking: cfg.ranking,
    classRouter: cfg.retrieval.classRouter,
    memoryFolder: (vaultId) => memByVault.get(vaultId) ?? DEFAULT_MEMORY_FOLDER,
  });
  const ttlHours = cmd.ttlHours ?? 6;
  const targets = cmd.vault ? cfg.vaults.filter((v) => v.id === cmd.vault) : cfg.vaults;
  if (cmd.vault && targets.length === 0) {
    process.stderr.write(`prefetch: unknown vault ${cmd.vault}\n`);
    process.exit(2);
  }
  try {
    for (const v of targets) {
      const res = (await pfRegistry.dispatch(
        "vault_context",
        { vault: v.id },
        {
          caller: "prefetch-worker",
          authenticated: true,
          grantedScopes: new Set(["read:notes"]),
          vaultId: v.id,
          db: cacheDb,
        },
      )) as {
        ok: boolean;
        data?: Record<string, unknown> & {
          signal?: string;
          signal_hash?: string;
          stats?: { chunks_packed?: number };
        };
        error?: { message?: string };
      };
      if (!res.ok || !res.data) {
        process.stdout.write(
          `prefetch ${v.id}: skipped (${res.error?.message ?? "no signal note"})\n`,
        );
        continue;
      }
      const now = Date.now();
      // THE-136 floor: a prefetch that packs nothing writes an empty marker, never a wrong
      // bundle (RRF scores are positional, so emptiness is the enforceable relevance floor).
      const empty = (res.data.stats?.chunks_packed ?? 0) === 0;
      // THE-543: this dispatch ran with no ctx.acl (the trusted CLI context sees every vault
      // path) — callerAclFingerprint's "no-acl" sentinel records that identity so a live
      // caller bound to a narrower ACL can never inherit this unrestricted bundle.
      const aclFingerprint = callerAclFingerprint(undefined, new Set(["read:notes"]));
      writePrewarm(prewarmPathFor(cfg.cacheDir, v.id, aclFingerprint), {
        generated_at: now,
        expires_at: now + ttlHours * 3_600_000,
        signal: String(res.data.signal ?? ""),
        signal_hash: String(res.data.signal_hash ?? ""),
        empty,
        acl_fingerprint: aclFingerprint,
        vault_generation: readGeneration(cacheDb, v.id),
        ...(empty ? {} : { bundle: res.data }),
      });
      process.stdout.write(
        `prefetch ${v.id}: ${empty ? "empty (floor)" : `${res.data.stats?.chunks_packed} chunk(s)`} ttl=${ttlHours}h\n`,
      );
    }
  } finally {
    cacheDb.close?.();
  }
  return;
}
