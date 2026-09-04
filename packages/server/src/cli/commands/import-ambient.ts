// THE-175 — `obsidian-tc import-ambient`. Pulls passive screen observations from a configured
// ambient-capture backend (Pensieve first: capture/pensieve.ts) and stages them in capture_queue
// via `ingestAmbient` (capture/ambient-import.ts), source: "ambient" — the same staged-content,
// human-review-before-vault-write path every capture_queue producer uses (THE-855's poison scan
// runs on every enqueue regardless of caller; ambient-import.ts additionally redacts secret-shaped
// substrings BEFORE enqueue — see that file's header).
//
// SHIPS INERT: no `pensieve.baseUrl` configured means this command no-ops with NO network call,
// exit 0 — the same degradation contract `readwise.token`/import-highlights.ts already establishes
// (which in turn modelled `plur`/PlurClientConfig). A deployment that never sets a baseUrl never
// notices this command exists.
//
// Same untrusted-input classification as import-highlights.ts (see this file's cli.ts THE-605
// comment): a remote backend's captured screen content is external input landing outside
// `registry.dispatch`, so this writes `audit_events` directly via `writeEvent` rather than relying
// on `runDispatch`.
import { mkdirSync } from "node:fs";
import { version as VERSION } from "../../../package.json";
import type { AuditEvent } from "../../audit";
import { writeEvent } from "../../audit";
import { ingestAmbient } from "../../capture/ambient-import";
import { fetchPensieveObservations, PensieveApiError } from "../../capture/pensieve";
import { openConfiguredDatabase } from "../../db/open";
import { provisionCacheDb } from "../../db/provision";
import type { Database } from "../../db/types";
import { argsHash } from "../../hash";
import { type Cmd, resolveOrUsageExit } from "../shared";

function auditImportAmbientEvent(
  cacheDb: Database,
  vaultId: string,
  durationMs: number,
  resultSize: number,
): void {
  try {
    const e: AuditEvent = {
      ts: Date.now(),
      vault_id: vaultId,
      tool_name: "import-ambient",
      caller: "cli-operator",
      duration_ms: durationMs,
      result_size: resultSize,
      status: "ok",
      error_code: null,
      args_hash: argsHash("import-ambient", { vault: vaultId }),
      event_type: "tool_invocation",
    };
    writeEvent(cacheDb, e);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `warning: import-ambient completed, but the audit_events row could not be written (${msg}).\n`,
    );
  }
}

/** `--machine` falls back to the configured baseUrl's hostname — Pensieve has no self-identifying
 *  endpoint, and a URL an operator already typed once is a better default than requiring a second,
 *  redundant flag on every invocation. Still overridable (multiple Pensieve instances behind one
 *  hostname, a friendlier label, etc). */
function defaultMachineLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

export async function run_import_ambient(cmd: Cmd<"import-ambient">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.configPath);

  const baseUrl = cfg.pensieve?.baseUrl;
  if (!baseUrl) {
    // INERT by design (THE-175 scope): no config, no network call, exit 0 — not an error. An
    // operator who has never heard of this feature must never see it fail.
    process.stdout.write(
      "import-ambient: no pensieve.baseUrl configured — nothing to do (no network call made)\n",
    );
    return;
  }

  if (!cmd.vault) {
    process.stderr.write(
      "import-ambient: --vault <id> is required (observations from one backend have no source-side vault to infer)\n",
    );
    process.exit(2);
  }
  const vault = cfg.vaults.find((v) => v.id === cmd.vault);
  if (!vault) {
    process.stderr.write(`import-ambient: unknown vault ${cmd.vault}\n`);
    process.exit(2);
  }

  const machine = cmd.machine ?? defaultMachineLabel(baseUrl);

  let items: Awaited<ReturnType<typeof fetchPensieveObservations>>;
  try {
    items = await fetchPensieveObservations(baseUrl, { machine, since: cmd.since });
  } catch (err) {
    const msg =
      err instanceof PensieveApiError
        ? `Pensieve search failed (HTTP ${err.status}): ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    process.stderr.write(`import-ambient: ${msg}\n`);
    process.exit(1);
  }

  mkdirSync(cfg.cacheDir, { recursive: true });
  const cacheDb = await openConfiguredDatabase(cfg, "cache.db");
  const t0 = Date.now();
  try {
    // Provisioned defensively, like `import-highlights` (cli/commands/import-highlights.ts): an
    // operator may reach for this before ever running `serve`.
    provisionCacheDb(cacheDb, { version: VERSION });
    const result = ingestAmbient(cacheDb, vault.id, items, t0, { dryRun: !!cmd.dryRun });
    const label = cmd.dryRun ? "would enqueue" : "enqueued";
    process.stdout.write(
      `import-ambient${cmd.dryRun ? " --dry-run" : ""} [${vault.id}] from ${machine}: ${result.enqueued} ${label}, ` +
        `${result.skipped_duplicate} already staged (deduplicated), ${result.redacted} secret(s) redacted\n`,
    );
    if (!cmd.dryRun && result.enqueued > 0) {
      auditImportAmbientEvent(cacheDb, vault.id, Date.now() - t0, result.enqueued);
    }
  } finally {
    cacheDb.close?.();
  }
}
