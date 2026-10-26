// forget_log handling for the context bundle, split out of context-bundle.ts to stay under the
// 700-line cap. A forget row names its vault only inside `details.vault_id` (forget_log has no
// vault column); legacy rows name none and apply to every vault.
import type { Database } from "../db/types";
import type { ForgetLogRow } from "./context-bundle-schema";
import { appendForgetLog, FORGET_ROW_VAULT_SQL } from "./forget";

/** The vault a forget row names in `details`, or undefined for a legacy, non-object or
 *  unparseable row. */
export function forgetRowVault(row: ForgetLogRow): string | undefined {
  if (row.details === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.details);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const v = (parsed as { vault_id?: unknown }).vault_id;
  return typeof v === "string" ? v : undefined;
}

/** Export rows. With `vaultId`, only that vault's forgets plus legacy rows, matching the rule
 *  recomputeNoteQuality applies. */
export function exportForgetLog(edb: Database, vaultId: string | undefined): ForgetLogRow[] {
  const cols = "SELECT seq, ts, kind, target, mode, details, prev_hash, hash FROM forget_log";
  return (
    vaultId
      ? edb
          .prepare(
            `${cols} WHERE (${FORGET_ROW_VAULT_SQL} = ? OR ${FORGET_ROW_VAULT_SQL} IS NULL) ORDER BY seq ASC`,
          )
          .all(vaultId)
      : edb.prepare(`${cols} ORDER BY seq ASC`).all()
  ) as ForgetLogRow[];
}

/** Re-point a forget row at the target vault. Rows naming no vault are returned unchanged. */
export function remapForgetRow(row: ForgetLogRow, targetVault: string): ForgetLogRow {
  if (forgetRowVault(row) === undefined) return row;
  return {
    ...row,
    details: JSON.stringify({
      ...(JSON.parse(row.details ?? "{}") as Record<string, unknown>),
      vault_id: targetVault,
    }),
  };
}

/** Apply one forget row. Dedups on kind/target/mode/ts AND the row's vault, so the same bundle
 *  imported under two vaults lands each vault's forget. */
export function importForgetRow(
  edb: Database,
  row: ForgetLogRow,
  serverVersion: string,
  dryRun: boolean,
): "imported" | "skipped_duplicate" {
  const vault = forgetRowVault(row) ?? null;
  const exists = edb
    .prepare(
      `SELECT 1 FROM forget_log WHERE kind = ? AND target = ? AND mode = ? AND ts = ? AND ${FORGET_ROW_VAULT_SQL} IS ? LIMIT 1`,
    )
    .get(row.kind, row.target, row.mode, row.ts, vault);
  if (exists) return "skipped_duplicate";
  if (!dryRun) {
    // THE-636 review fix (item c, "minor gap"): mark this row as import-derived, in the
    // EXISTING `details` JSON column — no migration authorized or needed. Without this, a
    // native forget and an imported one are byte-for-byte indistinguishable once appended,
    // which matters for an operator auditing which entries this install itself decided vs.
    // which arrived from elsewhere. `imported_from`/`imported_at` piggyback on the same field
    // `already_blocked`/`scrubbed`/etc. already use for this kind of free-form provenance.
    const parsedDetails = row.details ? (JSON.parse(row.details) as Record<string, unknown>) : {};
    appendForgetLog(edb, {
      ts: row.ts,
      kind: row.kind,
      target: row.target,
      mode: row.mode,
      details: {
        ...parsedDetails,
        imported: true,
        imported_from: serverVersion,
        imported_at: Date.now(),
      },
    });
    if (row.kind === "episode") {
      edb
        .prepare(
          "UPDATE agent_episodes SET blocked = 1, valid_until = COALESCE(valid_until, ?) WHERE id = ? AND blocked = 0",
        )
        .run(row.ts, row.target);
      if (row.mode === "erase") {
        edb
          .prepare(
            "UPDATE agent_episodes SET args_json = NULL, summary = NULL, tags = NULL, error_code = NULL WHERE id = ?",
          )
          .run(row.target);
      }
    }
  }
  return "imported";
}
