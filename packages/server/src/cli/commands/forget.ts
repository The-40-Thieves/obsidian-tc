import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MEMORY_FOLDER } from "@the-40-thieves/obsidian-tc-shared";
import { version as VERSION } from "../../../package.json";
import { type AuditEvent, writeEvent } from "../../audit";
import { provisionExperientialDb } from "../../db/experiential";
import { openDatabase } from "../../db/open";
import type { Database } from "../../db/types";
import {
  type EpisodeForgetResult,
  forgetEpisode,
  forgetNote,
  type NoteForgetResult,
  verifyForgetLog,
} from "../../experiential/forget";
import { argsHash } from "../../hash";
import { USAGE } from "../args";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "../shared";

// THE-605: `forget --erase` destroys note/episode content with no `audit_events` (event_log)
// row — the CLI's only vault-write path (of 18 `cli/commands/`, 7 are read-only/display, ~9
// recompute RECOMPUTABLE derived state, `prefetch` dispatches properly through
// `registry.dispatch`; `forget` is the one file with real vault-write calls). Its MCP sibling
// `work_forget` gets an audit row for free via `registry.dispatch`'s `recordOutcome`
// (mcp/registry.ts:603); the CLI path never goes through dispatch, so it never got one.
//
// Decision (owner, ticket THE-605): write `audit_events` directly via `writeEvent`, not by
// routing through `runDispatch`. Doing the latter would require manufacturing an operator
// `CallerContext` (which scopes? which ACL? `vaultBound` or not?) for a caller that dispatch was
// never designed to authorize — an operator with shell access already outranks the ACL; the
// thing actually missing is the RECORD, not the enforcement. The accepted cost is a second
// `audit_events` producer (the duplication pattern THE-600/THE-514 both exist to reduce) —
// bounded by pinning both writers to the same shape in dispatch-parity.test.ts (THE-605 item 4).
//
// This row is written EVERY TIME alongside `forget_log` (THE-239), not instead of it: they answer
// different questions. `forget_log` is the tamper-evident hash-chained deletion ledger (per-vault
// experiential.db); `audit_events` is "an operation ran" (per-machine cache.db, exposed the same
// way every other tool invocation's audit row is). THE-600 established that having one is not
// having the other.
function auditForgetEvent(
  cacheDb: Database,
  vaultId: string,
  kind: "episode" | "note",
  target: string,
  erase: boolean,
  durationMs: number,
  resultSize: number,
): void {
  try {
    // Same 10 AuditEvent fields recordOutcome (mcp/registry.ts:660) produces — no new envelope.
    // args_hash mirrors recordOutcome's own field literally: a hash of the identifying arguments,
    // not the raw path. It is reconstructable the same way recordOutcome's is — recompute it from
    // the paired forget_log row's (kind, target, mode) columns, which every audited call here
    // always writes in the same operation.
    const e: AuditEvent = {
      ts: Date.now(),
      vault_id: vaultId,
      tool_name: "forget",
      caller: "cli-operator",
      duration_ms: durationMs,
      result_size: resultSize,
      status: "ok",
      error_code: null,
      args_hash: argsHash("forget", { kind, target, erase }),
      event_type: "tool_invocation",
    };
    writeEvent(cacheDb, e);
  } catch (err) {
    // Fail-open, but NOT silent. recordOutcome's own fail-open catch (registry.ts:670) is paired
    // with a metric AND onAuditFailure (registry.ts:364-367, THE-457) specifically so an operator
    // watching server_health sees the audit trail going lossy rather than reading a clean board.
    // The CLI has no metrics sink and no operator watching a dashboard — it has an operator
    // standing at the terminal instead, so the report goes there instead of a new sink: a stderr
    // warning naming what happened AND what survived. Silence here would be a smaller instance of
    // the exact defect this ticket exists to close — a destructive operation nobody can tell was
    // unaudited.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `warning: forget completed, but the audit_events row could not be written (${msg}).\n` +
        `         The forget_log entry in experiential.db was written and is unaffected.\n`,
    );
  }
}

/** forgetEpisode + THE-605's audit_events row, gated on `found` — mirrors the `changes > 0`
 *  discipline THE-600 established for `work_forget`: a repeat/foreign/unknown id is a no-op and
 *  must not write a spurious audit row alongside the real ones. */
export function forgetEpisodeAudited(
  edb: Database,
  cacheDb: Database,
  vaultId: string,
  id: string,
  opts: { nowMs: number; erase?: boolean },
): EpisodeForgetResult {
  const t0 = Date.now();
  const r = forgetEpisode(edb, id, opts);
  if (r.found) {
    auditForgetEvent(
      cacheDb,
      vaultId,
      "episode",
      id,
      !!opts.erase,
      Date.now() - t0,
      Buffer.byteLength(JSON.stringify(r), "utf8"),
    );
  }
  return r;
}

/**
 * forgetNote + THE-605's audit_events row, written UNCONDITIONALLY.
 *
 * THE-609 decision: the two audit surfaces record the same events. This used to be gated on
 * `chunk_ids.length > 0`, on the rationale that "an unknown path (never indexed) touches nothing
 * and must not write a spurious audit row". That rationale does not hold — a run against a
 * never-indexed path is not a no-op:
 *
 *   * `forgetNote` appends to `forget_log` unconditionally (THE-239's tamper-evident hash chain);
 *     the append sits outside its own `chunk_ids` guard, inside the transaction that always commits.
 *   * it may `rmSync` prewarm cache files (experiential/forget.ts), likewise ungated by chunk_ids.
 *
 * So the operation had effects and left a permanent record on one surface while the other showed
 * nothing. THE-605 item 2 was explicit that the audit row "must be written even when the CLI path
 * already writes forget_log", and THE-600 established that having one is not having the other —
 * keeping the asymmetry would have inverted both. The alternative reading ("audit_events records
 * EFFECTS, forget_log records INVOCATIONS") is coherent, but it is the opposite of where THE-600
 * landed, so it is not adopted silently here.
 *
 * THE RULE, stated once for both writers: **audit_events mirrors forget_log.** An audit row is
 * written exactly when a hash-chain row is appended, and never otherwise. That is why
 * `forgetEpisodeAudited` below keeps its `r.found` gate and is NOT inconsistent with this: a
 * missing episode returns before `forgetEpisode` opens its transaction, so no forget_log row is
 * appended either. Note and episode differ because their forget_log behaviour differs, not because
 * their audit policy does.
 *
 * A no-op now writes a row whose `resultSize` reflects an empty result — honest, and reconstructable
 * from the result shape; the paired forget_log row already carries `chunks: 0` explicitly. Pinned in
 * dispatch-parity.test.ts Section 6 so the next reader finds the decision rather than the
 * discrepancy.
 */
export function forgetNoteAudited(
  edb: Database,
  cacheDb: Database,
  opts: Parameters<typeof forgetNote>[2],
): NoteForgetResult {
  const t0 = Date.now();
  const r = forgetNote(edb, cacheDb, opts);
  auditForgetEvent(
    cacheDb,
    opts.vaultId,
    "note",
    opts.relPath,
    !!opts.erase,
    Date.now() - t0,
    Buffer.byteLength(JSON.stringify(r), "utf8"),
  );
  return r;
}

// THE-600: DEFAULT_MEMORY_FOLDER comes from @the-40-thieves/obsidian-tc-shared (the single
// source of truth, shared with tools/m5 and VaultMemoryConfigSchema's own default) rather than
// a local duplicate. This command's --erase path destroys note content, so a copy of this
// constant that silently drifted from the tool surface's value would resolve a DIFFERENT folder
// on a delete path — not a cosmetic divergence. Importing from `shared` also doesn't cross the
// no-transport-imports-tool boundary (THE-600 extended it to cli/commands/): `shared` isn't a
// tool module, so no exemption is needed here at all.

export async function run_forget(cmd: Cmd<"forget">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  if (!cmd.episode && !cmd.note && !cmd.verify) {
    process.stderr.write(
      `forget requires --episode <id>, --note <rel-path>, or --verify\n\n${USAGE}`,
    );
    process.exit(2);
  }
  mkdirSync(cfg.cacheDir, { recursive: true });
  const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
    version: VERSION,
  });
  const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
  try {
    if (cmd.verify) {
      const v = verifyForgetLog(edb);
      process.stdout.write(
        v.ok
          ? `forget-log OK: ${v.entries} entr${v.entries === 1 ? "y" : "ies"}, chain intact\n`
          : `forget-log BROKEN at seq ${v.breakAt} (${v.entries} entries)\n`,
      );
      if (!v.ok) process.exit(1);
      return;
    }
    const vaultId = cmd.vault ?? cfg.vaults[0]?.id ?? "main";
    if (cmd.episode) {
      const r = forgetEpisodeAudited(edb, cacheDb, vaultId, cmd.episode, {
        nowMs: Date.now(),
        ...(cmd.erase ? { erase: true } : {}),
      });
      if (!r.found) {
        process.stderr.write(`forget: episode ${cmd.episode} not found\n`);
        process.exit(1);
      }
      process.stdout.write(
        `forgot episode ${cmd.episode} (${cmd.erase ? "erase" : "tombstone"})${r.already_blocked ? " [was already blocked]" : ""}` +
          `${r.scrubbed_fields > 0 ? " content scrubbed" : ""}` +
          `${r.preference_evidence_mentions > 0 ? `; NOTE: ${r.preference_evidence_mentions} preference-delta evidence mention(s) (append-only, review manually)` : ""}\n`,
      );
      return;
    }
    const rel = (cmd.note as string).replace(/\\/g, "/");
    const vault = cfg.vaults.find((v) => v.id === vaultId);
    const abs = vault ? join(vault.path, rel) : null;
    if (abs && existsSync(abs)) {
      process.stderr.write(
        `forget: ${rel} still exists in the vault — delete the note first (delete_note or file manager), then forget propagates the derived state\n`,
      );
      process.exit(1);
    }
    const memFolder = vault?.memory?.folder ?? DEFAULT_MEMORY_FOLDER;
    const r = forgetNoteAudited(edb, cacheDb, {
      vaultId,
      relPath: rel,
      nowMs: Date.now(),
      ...(cmd.erase ? { erase: true } : {}),
      prewarmDir: cfg.cacheDir,
      ...(vault ? { vaultRoot: vault.path, memoryFolder: memFolder } : {}),
    });
    process.stdout.write(
      `forgot note ${rel} (${cmd.erase ? "erase" : "tombstone"}): ${r.chunk_ids.length} chunk(s), ` +
        `retrievals ${cmd.erase ? `${r.retrieval_rows_deleted} deleted` : `${r.retrieval_rows} kept (audit)`}, ` +
        `${r.activation_rows_deleted} activation row(s) cleared` +
        `${r.prewarm_invalidated ? ", prewarm cache invalidated" : ""}\n`,
    );
    if (r.outdated_reflections.length > 0)
      process.stdout.write(
        `  outdated reflections (review): ${r.outdated_reflections.join(", ")}\n`,
      );
    if (r.syntheses_mentions > 0 || r.contradictions_mentions > 0)
      process.stdout.write(
        `  report-only: ${r.syntheses_mentions} synthesis row(s), ${r.contradictions_mentions} contradiction row(s) mention this path (they regenerate / are lifecycle-owned)\n`,
      );
    if (r.chunk_ids.length > 0)
      process.stdout.write(
        `  note: ${r.chunk_ids.length} chunk(s) still in the search index — run the server (boot reconcile deindexes deleted notes) or index_vault to finish\n`,
      );
  } finally {
    edb.close?.();
    cacheDb.close?.();
  }
  return;
}
