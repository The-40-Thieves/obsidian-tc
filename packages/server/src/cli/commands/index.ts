import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { version as VERSION } from "../../../package.json";
import { openDatabase } from "../../db/open";
import { provisionCacheDb } from "../../db/provision";
import { MetricsRecorder } from "../../metrics/registry";
import { wireIndexResources } from "../../runtime/indexing-wiring";
import { normalizeVaultPath } from "../../vault/paths";
import { type Cmd, resolveOrUsageExit } from "../shared";

/**
 * THE-697 — `obsidian-tc index`. The derived-state job that had no CLI.
 *
 * `rg 'case "' cli.ts` listed twenty commands and not one of them indexed: indexing was reachable
 * only through the `index_vault` MCP tool or the boot reconcile, while every other derived-state
 * job (cluster, activation-recompute, note-quality, gaps) already had a command. That gap was not
 * cosmetic — the tool path CANNOT complete over HTTP. Bun's 10-second default idleTimeout closes
 * the request while the work continues invisibly server-side, so the caller gets
 * `RemoteProtocolError: Server disconnected` on an operation that actually succeeded, with no
 * result payload and no way to distinguish "still running" from "died". Raising idleTimeout
 * (transports/serve.ts) buys headroom but cannot be the whole answer: Bun caps it at 255s and a
 * full 13k-chunk reindex exceeds that. An operator needs a path that does not hold a socket open
 * at all, which is this.
 *
 * Goes through `wireIndexResources` — the SAME composition root boot uses — rather than building a
 * provider and a representation manifest of its own. That is deliberate and load-bearing: the
 * manifest is the identity of the vec_chunks table, and if this command derived a different one,
 * boot and `index` would each DROP and rebuild the table the other just built. index-vault.ts calls
 * that hazard out by name ("an unbounded rebuild loop"). Reusing the one derivation makes the
 * divergence unrepresentable instead of merely tested against.
 *
 * `indexVaultRecorded` (not bare `indexVault`) routes IndexStats to `recordIngestStats`, which
 * writes the Prometheus counters and the durable `event_log` row. THE-590 found the MCP tool path
 * silently skipping exactly that, and `check:ingest-telemetry-wiring` is the gate that now holds
 * every call site to it — including this one.
 */
export async function run_index(cmd: Cmd<"index">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  const configPath = cmd.input ?? process.env.OBSIDIAN_TC_CONFIG;
  mkdirSync(cfg.cacheDir, { recursive: true });

  const vaults = cmd.vault ? cfg.vaults.filter((v) => v.id === cmd.vault) : cfg.vaults;
  if (cmd.vault && vaults.length === 0) {
    process.stderr.write(`index: unknown vault ${cmd.vault}\n`);
    process.exit(2);
  }
  // `--folder` scopes a partial reindex, and a partial reindex of "every vault" is almost never
  // what the operator means — the same relative path under two vaults is two different folders.
  if (cmd.folder && vaults.length > 1) {
    process.stderr.write("index: --folder requires --vault (it is a per-vault path)\n");
    process.exit(2);
  }

  const db = await openDatabase(join(cfg.cacheDir, "cache.db"));
  try {
    // PROVISION, unlike every sibling command here — and deliberately so. metrics, forget,
    // contribution-report et al. open cache.db and assume `serve` already created it, which is fair
    // for a read of derived state. `index` is the one command an operator reaches for BEFORE the
    // server has ever run, and without this it dies on `no such table: schema_migrations` at exactly
    // that moment. Idempotent: runMigrations skips what is already applied, so this is a no-op
    // against a live store.
    provisionCacheDb(db, { version: VERSION });
    // A process-local recorder. Its Prometheus counters are discarded when this process exits —
    // there is no /metrics endpoint on a one-shot CLI — but recordIngestStats ALSO writes
    // event_log rows, and those are durable and are the point.
    const resources = await wireIndexResources({
      db,
      metrics: new MetricsRecorder(),
      embeddings: cfg.embeddings,
      onVecRebuild: (event) =>
        process.stdout.write(`index: vec_chunks rebuilt (${event.reason ?? "representation"})\n`),
      ...(configPath !== undefined ? { configDir: dirname(configPath) } : {}),
      ...(cfg.securityProfile !== undefined ? { securityProfile: cfg.securityProfile } : {}),
    });

    const sub = cmd.folder ? normalizeVaultPath(cmd.folder) : undefined;
    let totalChunks = 0;
    let embedFailed = 0;
    for (const v of vaults) {
      const stats = await resources.indexVaultRecorded({
        db,
        provider: resources.embeddingProvider,
        representation: resources.representation,
        embed: resources.embedConfig,
        chunkContext: cfg.embeddings.chunkContext,
        densify: cfg.retrieval.densify,
        vaultId: v.id,
        root: v.path,
        ...(sub !== undefined ? { sub } : {}),
        // No ACL narrowing: this is an operator-invoked local command, not a scoped agent request.
        // The MCP tool path applies the caller's folder ACL; there is no caller here to scope to.
        isReadable: () => true,
        walk: { streaming: cfg.indexing.streamingWalk },
      });
      totalChunks += stats.chunks_upserted;
      embedFailed += stats.notes_embed_failed;
      process.stdout.write(
        `indexed ${v.id}: ${stats.notes_indexed} note(s), ${stats.chunks_upserted} chunk(s) upserted, ` +
          `${stats.chunks_deleted} deleted, ${stats.secrets_skipped} secret-gated, ` +
          `${stats.notes_embed_failed} embed-failed\n`,
      );
    }
    // THE-697's guardrail, in the output itself: report the COMPLETION signal, not a row count.
    // The near-miss that produced the ticket was reading `count(*) FROM notes` going 1144 -> 1146
    // as success while those notes still had ZERO chunks — listed and unretrievable at the same
    // time, which is indistinguishable from a genuine partial-index failure. chunks_upserted is
    // returned by the pass that wrote them, so it cannot be observed mid-flight.
    process.stdout.write(
      `done: ${totalChunks} chunk(s) upserted across ${vaults.length} vault(s)\n`,
    );
    // notes_embed_failed is a PARTIAL success: the note rows are written and the notes are listed,
    // but they carry no vector this pass, so they are present-and-unretrievable — precisely the
    // state that looked like corruption when read mid-flight. Say so on stderr and exit non-zero,
    // or a scripted reindex reports success for an index that cannot answer.
    if (embedFailed > 0) {
      process.stderr.write(
        `index: ${embedFailed} note(s) failed to embed — indexed but NOT retrievable until a later ` +
          `pass re-embeds them. Check the embeddings provider is reachable (\`doctor --probe\`).\n`,
      );
      process.exit(1);
    }
  } finally {
    db.close?.();
  }
}
