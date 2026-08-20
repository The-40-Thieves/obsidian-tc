// THE-650 — `obsidian-tc import-highlights`. Pulls highlights from a configured read-later
// source (Readwise first: capture/readwise.ts) and stages them in capture_queue via
// `ingestHighlights` (capture/highlight-import.ts), source: "import" — the same staged-content,
// human-review-before-vault-write path every capture_queue producer uses (THE-855's poison scan
// runs on every enqueue regardless of caller).
//
// SHIPS INERT: no `readwise.token` configured means this command no-ops with NO network call,
// exit 0 — the same degradation contract `plur` (PlurClientConfig) already establishes for an
// optional external integration. A deployment that never sets the token never notices this
// command exists.
//
// Modelled on cli/commands/context-import.ts for the audit-writing shape: this is an
// UNTRUSTED-INPUT surface (an external account's content, landing outside `registry.dispatch`),
// the same classification cli.ts's THE-605 comment gives context-export/context-import/forget —
// see that comment for why those three write `audit_events` directly via `writeEvent` rather than
// relying on `runDispatch`.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { version as VERSION } from "../../../package.json";
import type { AuditEvent } from "../../audit";
import { writeEvent } from "../../audit";
import { ingestHighlights } from "../../capture/highlight-import";
import { fetchReadwiseHighlights, ReadwiseApiError } from "../../capture/readwise";
import { openDatabase } from "../../db/open";
import { provisionCacheDb } from "../../db/provision";
import type { Database } from "../../db/types";
import { argsHash } from "../../hash";
import { type Cmd, resolveOrUsageExit } from "../shared";

function auditImportHighlightsEvent(
  cacheDb: Database,
  vaultId: string,
  durationMs: number,
  resultSize: number,
): void {
  try {
    const e: AuditEvent = {
      ts: Date.now(),
      vault_id: vaultId,
      tool_name: "import-highlights",
      caller: "cli-operator",
      duration_ms: durationMs,
      result_size: resultSize,
      status: "ok",
      error_code: null,
      args_hash: argsHash("import-highlights", { vault: vaultId }),
      event_type: "tool_invocation",
    };
    writeEvent(cacheDb, e);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `warning: import-highlights completed, but the audit_events row could not be written (${msg}).\n`,
    );
  }
}

export async function run_import_highlights(cmd: Cmd<"import-highlights">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.configPath);

  const token = cfg.readwise?.token;
  if (!token) {
    // INERT by design (THE-650 scope): no config, no network call, exit 0 — not an error. An
    // operator who has never heard of this feature must never see it fail.
    process.stdout.write(
      "import-highlights: no readwise.token configured — nothing to do (no network call made)\n",
    );
    return;
  }

  if (!cmd.vault) {
    process.stderr.write(
      "import-highlights: --vault <id> is required (highlights from one account have no source-side vault to infer)\n",
    );
    process.exit(2);
  }
  const vault = cfg.vaults.find((v) => v.id === cmd.vault);
  if (!vault) {
    process.stderr.write(`import-highlights: unknown vault ${cmd.vault}\n`);
    process.exit(2);
  }

  let items: Awaited<ReturnType<typeof fetchReadwiseHighlights>>;
  try {
    items = await fetchReadwiseHighlights(token, { updatedAfter: cmd.since });
  } catch (err) {
    const msg =
      err instanceof ReadwiseApiError
        ? `Readwise export failed (HTTP ${err.status}): ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    process.stderr.write(`import-highlights: ${msg}\n`);
    process.exit(1);
  }

  mkdirSync(cfg.cacheDir, { recursive: true });
  const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
  const t0 = Date.now();
  try {
    // Provisioned defensively, like `index` (cli/commands/index.ts): an operator may reach for
    // this before ever running `serve`.
    provisionCacheDb(cacheDb, { version: VERSION });
    const result = ingestHighlights(cacheDb, vault.id, items, t0, { dryRun: !!cmd.dryRun });
    const label = cmd.dryRun ? "would enqueue" : "enqueued";
    process.stdout.write(
      `import-highlights${cmd.dryRun ? " --dry-run" : ""} [${vault.id}]: ${result.enqueued} ${label}, ` +
        `${result.skipped_duplicate} already staged (deduplicated)\n`,
    );
    if (!cmd.dryRun && result.enqueued > 0) {
      auditImportHighlightsEvent(cacheDb, vault.id, Date.now() - t0, result.enqueued);
    }
  } finally {
    cacheDb.close?.();
  }
}
