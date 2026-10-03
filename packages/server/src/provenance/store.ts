// The write_provenance chain: append a signed record, read a vault's chain back (retention.ts prunes it).
//
// Every record's body embeds the previous record's hash, so the chain is per vault and dense. A
// separate signed HEAD row pins the last (seq, hash) and the prune anchor, which is what makes a
// removed TAIL record visible: the chain alone cannot notice a record that simply is not there.
import { createHash } from "node:crypto";
import { inWriteTransaction, type WriteTxnHooks } from "../db/txn";
import type { Database } from "../db/types";
import { canonicalJson } from "../hash";
import { type ProvenanceSigner, verifyMessage } from "./signer";
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
export interface ProvenanceAppendInput extends Attribution {
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

export function writeHead(
  db: Database,
  h: Omit<HeadRow, "kid" | "sig">,
  signer?: ProvenanceSigner,
): void {
  const kid = signer?.kid ?? null;
  const sig = signer?.sign(headMessage(h)) ?? null;
  db.prepare(
    `INSERT INTO write_provenance_heads (vault_id, head_seq, head_hash, pruned_seq, pruned_hash, kid, sig)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (vault_id) DO UPDATE SET head_seq = excluded.head_seq, head_hash = excluded.head_hash,
       pruned_seq = excluded.pruned_seq, pruned_hash = excluded.pruned_hash, kid = excluded.kid, sig = excluded.sig`,
  ).run(h.vault_id, h.head_seq, h.head_hash, h.pruned_seq, h.pruned_hash, kid, sig);
}

/** Raised by `appendProvenance` when a SIGNED head is on file and no signer is available (a key-file
 *  or registry outage). Recording unsigned would put an unsigned head over a signed one, which reads
 *  afterwards as "this deployment never signed"; the caller reports the write as omitted instead. */
export class ProvenanceSignerUnavailable extends Error {
  constructor(vaultId: string) {
    super(
      `signer unavailable: vault ${vaultId} has a signed chain head, which an unsigned record would downgrade`,
    );
    this.name = "ProvenanceSignerUnavailable";
  }
}

export interface ChainView {
  head: HeadRow | undefined;
  /** Where the next record chains from: the last record, else the head's pin, else genesis. */
  tip: { seq: number; hash: string };
  /** Why the committed head cannot be trusted; undefined when it checks out. */
  fault: string | undefined;
}

type RecordEdge = { seq: number; hash: string; prev_hash: string; sig: string | null };

/**
 * The ONE place a committed head is validated, shared by append and prune: both extend or re-sign
 * it, so both must first prove it is what the last honest writer left. A writer of cache.db without
 * the signing key can forge `pruned_*`/`head_*` or delete rows, but the signature then no longer
 * verifies, and a server that re-signed whatever it found would launder the forgery into a head
 * `verify` accepts. Checks, in order: the head exists when records do; it pins the actual last
 * record (or, with none left, its own anchor); the anchor matches the first surviving record; a
 * signature that was there is still there and verifies under a registry key (any state).
 */
export function checkHead(
  db: Database,
  vaultId: string,
  signer: ProvenanceSigner | undefined,
): ChainView {
  const head = readHead(db, vaultId);
  const edge = (order: "ASC" | "DESC") =>
    db
      .prepare(
        `SELECT seq, hash, prev_hash, sig FROM write_provenance WHERE vault_id = ? ORDER BY seq ${order} LIMIT 1`,
      )
      .get(vaultId) as RecordEdge | undefined;
  const last = edge("DESC");
  const first = edge("ASC");
  const tip = last
    ? { seq: last.seq, hash: last.hash }
    : head
      ? { seq: head.head_seq, hash: head.head_hash }
      : { seq: 0, hash: GENESIS_HASH };
  return { head, tip, fault: headFault(head, last, first, signer) };
}

function headFault(
  head: HeadRow | undefined,
  last: RecordEdge | undefined,
  first: RecordEdge | undefined,
  signer: ProvenanceSigner | undefined,
): string | undefined {
  if (head === undefined) return last ? "the head row is missing but records exist" : undefined;
  if (last) {
    if (last.seq !== head.head_seq || last.hash !== head.head_hash) {
      return `the head pins seq ${head.head_seq} but the chain ends at seq ${last.seq}`;
    }
  } else if (head.head_seq !== head.pruned_seq || head.head_hash !== head.pruned_hash) {
    return `the head pins seq ${head.head_seq} but no records remain past the prune anchor`;
  }
  if (first && (first.seq !== head.pruned_seq + 1 || first.prev_hash !== head.pruned_hash)) {
    return `the prune anchor (seq ${head.pruned_seq}) does not match the first surviving record (seq ${first.seq})`;
  }
  if (head.kid === null || head.sig === null) {
    return last?.sig != null
      ? "the head lost its signature while its records are signed"
      : undefined;
  }
  const jwk = signer?.resolveKey(head.kid);
  if (jwk === undefined)
    return `the head is signed by kid ${head.kid}, which the registry has never held`;
  return verifyMessage(jwk, headMessage(head), head.sig)
    ? undefined
    : `the head signature does not verify under kid ${head.kid}`;
}

/**
 * Append one record to `vaultId`'s chain, signed when `signer` is given. Returns its seq + hash,
 * plus `headFault` when the committed head failed validation: the record is still written (so the
 * write is on the record), chained from the real last record and stamped `integrity.head_fault`, but
 * the bad head row is left exactly as found, neither re-signed nor overwritten, so `verify` keeps
 * failing and the evidence survives. Throws `ProvenanceSignerUnavailable` rather than put an
 * unsigned head over a signed one.
 */
export function appendProvenance(
  db: Database,
  input: ProvenanceAppendInput,
  signer: ProvenanceSigner | undefined,
  hooks?: WriteTxnHooks,
): { seq: number; hash: string; headFault?: string } {
  return inWriteTransaction(
    db,
    "provenance_append",
    () => {
      if (signer === undefined && readHead(db, input.vaultId)?.sig != null) {
        throw new ProvenanceSignerUnavailable(input.vaultId);
      }
      const { head, tip, fault } = checkHead(db, input.vaultId, signer);
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
        ...(fault !== undefined ? { integrity: { head_fault: fault } } : {}),
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
      if (fault !== undefined) return { seq: body.seq, hash, headFault: fault };
      writeHead(
        db,
        {
          vault_id: input.vaultId,
          head_seq: body.seq,
          head_hash: hash,
          pruned_seq: head?.pruned_seq ?? 0,
          pruned_hash: head?.pruned_hash ?? GENESIS_HASH,
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
