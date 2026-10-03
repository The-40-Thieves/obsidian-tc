// Retention for the write_provenance chain: prune the oldest records and move the signed anchor up.
// It lives apart from store.ts because deleting records is only safe after the records being deleted
// have been verified, and verification (verify.ts) reads the store.
import { inWriteTransaction, type WriteTxnHooks } from "../db/txn";
import type { Database } from "../db/types";
import type { ProvenanceSigner } from "./signer";
import { checkHead, type ProvenanceRow, readHeadRow, writeHead } from "./store";
import { GENESIS_HASH } from "./types";
import { checkRecord } from "./verify";

/**
 * Why the records `seq <= through` may not be pruned, or undefined when every one verifies: its hash,
 * its indexed columns against its signed body, its link to the record before it (the signed prune
 * anchor for the first), its place in the sequence and its signature. The records are picked for
 * deletion by a mutable column (`ts`); this is what stops that column from being edited to drag
 * records into the prefix and having the prune sign a valid anchor over the result. Unsigned records
 * stay acceptable (a chain written before signing was on), as `verify --allow-unsigned` accepts them.
 */
function unverifiedPrefix(
  db: Database,
  vaultId: string,
  through: number,
  pruned: { seq: number; hash: string },
  signer: ProvenanceSigner | undefined,
): string | undefined {
  const rows = db
    .prepare(
      "SELECT vault_id, seq, ts, body, prev_hash, hash, kid, sig FROM write_provenance WHERE vault_id = ? AND seq <= ? ORDER BY seq ASC",
    )
    .all(vaultId, through) as ProvenanceRow[];
  let expectSeq = pruned.seq + 1;
  let prev = pruned.hash;
  for (const r of rows) {
    const bad = checkRecord(r, prev, expectSeq, (kid) => signer?.resolveKey(kid)).problems.find(
      (p) => p.code !== "unsigned",
    );
    if (bad !== undefined)
      return `record seq ${r.seq} fails verification (${bad.code}): ${bad.detail}`;
    prev = r.hash;
    expectSeq = r.seq + 1;
  }
  return rows.length === through - pruned.seq
    ? undefined
    : `records ${pruned.seq + 1}..${through} are not all present`;
}

/**
 * Drop every record of `vaultId` older than `cutoffMs`, as one contiguous prefix, and move the
 * signed prune anchor up to the last one dropped so the surviving chain still verifies. A record
 * newer than the cutoff stops the prefix even when a later one is older (clocks step backwards).
 * Returns how many rows went. Refuses (returns 0) to re-sign a signed head without a signer, to
 * touch a chain whose head fails validation, and to delete a record that does not itself verify
 * (`onFault` is told why; nothing is deleted or signed).
 */
export function pruneProvenance(
  db: Database,
  vaultId: string,
  cutoffMs: number,
  signer: ProvenanceSigner | undefined,
  hooks?: WriteTxnHooks,
  onFault?: (vaultId: string, reason: string) => void,
): number {
  return inWriteTransaction(
    db,
    "provenance_append",
    () => {
      const firstKept = db
        .prepare("SELECT MIN(seq) AS s FROM write_provenance WHERE vault_id = ? AND ts >= ?")
        .get(vaultId, cutoffMs) as { s: number | null };
      // An unsigned head over a signed one would be a silent downgrade (a missing signature then
      // reads as "this deployment never signed"): without a signer, leave a signed chain alone.
      if (signer === undefined && readHeadRow(db, vaultId)?.sig != null) return 0;
      const { head, tip, fault } = checkHead(db, vaultId, signer);
      if (fault !== undefined) {
        onFault?.(vaultId, fault);
        return 0;
      }
      const through = firstKept.s === null ? tip.seq : firstKept.s - 1;
      if (through <= (head?.pruned_seq ?? 0)) return 0;
      const unverified = unverifiedPrefix(
        db,
        vaultId,
        through,
        { seq: head?.pruned_seq ?? 0, hash: head?.pruned_hash ?? GENESIS_HASH },
        signer,
      );
      if (unverified !== undefined) {
        onFault?.(vaultId, unverified);
        return 0;
      }
      const anchor = db
        .prepare("SELECT hash FROM write_provenance WHERE vault_id = ? AND seq = ?")
        .get(vaultId, through) as { hash: string } | undefined;
      // Nothing to anchor on (the record at `through` is already gone): leave the chain as it is
      // rather than writing an anchor that names a hash nobody can check.
      if (anchor === undefined) return 0;
      const removed = db
        .prepare("DELETE FROM write_provenance WHERE vault_id = ? AND seq <= ?")
        .run(vaultId, through).changes;
      writeHead(
        db,
        {
          vault_id: vaultId,
          head_seq: tip.seq,
          head_hash: tip.hash,
          pruned_seq: through,
          pruned_hash: anchor.hash,
        },
        signer,
      );
      return removed;
    },
    hooks,
  );
}
