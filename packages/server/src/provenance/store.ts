// The write_provenance chain: append a signed record, read a vault's chain back, prune its head.
//
// Every record's body embeds the previous record's hash, so the chain is per vault and dense. A
// separate signed HEAD row pins the last (seq, hash) and the prune anchor, which is what makes a
// removed TAIL record visible: the chain alone cannot notice a record that simply is not there.
import { createHash } from "node:crypto";
import { canonicalJson } from "../hash";
import { inWriteTransaction, type WriteTxnHooks } from "../db/txn";
import type { Database } from "../db/types";
import type { ProvenanceSigner } from "./signer";
import { GENESIS_HASH, type ProvenanceBody, RECORD_VERSION } from "./types";

export interface ProvenanceRow {
  vault_id: string;
  seq: number;
  ts: number;
  body: string;
  prev_hash: string;
  hash: string;
  kid: string | null;
  sig: string | null;
}

export interface HeadRow {
  vault_id: string;
  head_seq: number;
  head_hash: string;
  pruned_seq: number;
  pruned_hash: string;
  kid: string | null;
  sig: string | null;
}

const RECORD_DOMAIN = "obsidian-tc:provenance:v1:";
const HEAD_DOMAIN = "obsidian-tc:provenance-head:v1:";

export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** The exact bytes a record signature covers: the domain tag plus the record hash. */
export const recordMessage = (hash: string): string => `${RECORD_DOMAIN}${hash}`;

/** The exact bytes a head signature covers: every head field, canonicalised. */
export const headMessage = (h: Omit<HeadRow, "kid" | "sig">): string =>
  `${HEAD_DOMAIN}${sha256Hex(
    canonicalJson({
      vault: h.vault_id,
      head_seq: h.head_seq,
      head_hash: h.head_hash,
      pruned_seq: h.pruned_seq,
      pruned_hash: h.pruned_hash,
    }),
  )}`;

type Attribution = Pick<ProvenanceBody, "verified" | "unauthenticated" | "self_reported">;
export interface AppendInput extends Attribution {
  vaultId: string;
  ts: number;
  tool: string;
  outcome: ProvenanceBody["outcome"];
  paths: ProvenanceBody["paths"];
  pathsOmitted: number;
}

const readHead = (db: Database, vaultId: string): HeadRow | undefined =>
  db.prepare("SELECT * FROM write_provenance_heads WHERE vault_id = ?").get(vaultId) as
    | HeadRow
    | undefined;

function writeHead(db: Database, h: Omit<HeadRow, "kid" | "sig">, signer?: ProvenanceSigner): void {
  const kid = signer?.kid ?? null;
  const sig = signer?.sign(headMessage(h)) ?? null;
  db.prepare(
    `INSERT INTO write_provenance_heads (vault_id, head_seq, head_hash, pruned_seq, pruned_hash, kid, sig)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (vault_id) DO UPDATE SET head_seq = excluded.head_seq, head_hash = excluded.head_hash,
       pruned_seq = excluded.pruned_seq, pruned_hash = excluded.pruned_hash, kid = excluded.kid, sig = excluded.sig`,
  ).run(h.vault_id, h.head_seq, h.head_hash, h.pruned_seq, h.pruned_hash, kid, sig);
}

/** Where the next record chains from: the head row when there is one (so a removed tail shows up
 *  as a sequence gap instead of being papered over), else the last record, else genesis. */
function chainTip(
  db: Database,
  vaultId: string,
): { seq: number; hash: string; prunedSeq: number; prunedHash: string } {
  const head = readHead(db, vaultId);
  if (head !== undefined) {
    return {
      seq: head.head_seq,
      hash: head.head_hash,
      prunedSeq: head.pruned_seq,
      prunedHash: head.pruned_hash,
    };
  }
  const last = db
    .prepare("SELECT seq, hash FROM write_provenance WHERE vault_id = ? ORDER BY seq DESC LIMIT 1")
    .get(vaultId) as { seq: number; hash: string } | undefined;
  return {
    seq: last?.seq ?? 0,
    hash: last?.hash ?? GENESIS_HASH,
    prunedSeq: 0,
    prunedHash: GENESIS_HASH,
  };
}

/** Append one record to `vaultId`'s chain, signed when `signer` is given. Returns its seq + hash. */
export function appendProvenance(
  db: Database,
  input: AppendInput,
  signer: ProvenanceSigner | undefined,
  hooks?: WriteTxnHooks,
): { seq: number; hash: string } {
  return inWriteTransaction(
    db,
    "provenance_append",
    () => {
      const tip = chainTip(db, input.vaultId);
      const body: ProvenanceBody = {
        v: RECORD_VERSION,
        vault: input.vaultId,
        seq: tip.seq + 1,
        ts: input.ts,
        prev: tip.hash,
        tool: input.tool,
        outcome: input.outcome,
        paths: input.paths,
        paths_omitted: input.pathsOmitted,
        verified: input.verified,
        unauthenticated: input.unauthenticated,
        self_reported: input.self_reported,
      };
      const text = canonicalJson(body);
      const hash = sha256Hex(text);
      db.prepare(
        "INSERT INTO write_provenance (vault_id, seq, ts, body, prev_hash, hash, kid, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        input.vaultId,
        body.seq,
        input.ts,
        text,
        tip.hash,
        hash,
        signer?.kid ?? null,
        signer?.sign(recordMessage(hash)) ?? null,
      );
      writeHead(
        db,
        {
          vault_id: input.vaultId,
          head_seq: body.seq,
          head_hash: hash,
          pruned_seq: tip.prunedSeq,
          pruned_hash: tip.prunedHash,
        },
        signer,
      );
      return { seq: body.seq, hash };
    },
    hooks,
  );
}

/** Every vault that has a chain (a head row, or records whose head row was removed). */
export function provenanceVaults(db: Database): string[] {
  return (
    db
      .prepare(
        "SELECT vault_id FROM write_provenance_heads UNION SELECT vault_id FROM write_provenance ORDER BY vault_id",
      )
      .all() as Array<{ vault_id: string }>
  ).map((r) => r.vault_id);
}

export const readChain = (db: Database, vaultId: string): ProvenanceRow[] =>
  db
    .prepare(
      "SELECT vault_id, seq, ts, body, prev_hash, hash, kid, sig FROM write_provenance WHERE vault_id = ? ORDER BY seq ASC",
    )
    .all(vaultId) as ProvenanceRow[];

export const readHeadRow = readHead;

/**
 * Drop every record of `vaultId` older than `cutoffMs`, as one contiguous prefix, and move the
 * signed prune anchor up to the last one dropped so the surviving chain still verifies. A record
 * newer than the cutoff stops the prefix even when a later one is older (clocks step backwards).
 * Returns how many rows went.
 */
export function pruneProvenance(
  db: Database,
  vaultId: string,
  cutoffMs: number,
  signer: ProvenanceSigner | undefined,
  hooks?: WriteTxnHooks,
): number {
  return inWriteTransaction(
    db,
    "provenance_append",
    () => {
      const firstKept = db
        .prepare("SELECT MIN(seq) AS s FROM write_provenance WHERE vault_id = ? AND ts >= ?")
        .get(vaultId, cutoffMs) as { s: number | null };
      const tip = chainTip(db, vaultId);
      const through = firstKept.s === null ? tip.seq : firstKept.s - 1;
      if (through <= tip.prunedSeq) return 0;
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
