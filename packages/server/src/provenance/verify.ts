// Verify a vault's provenance chain: recompute every hash, walk the links and the sequence, check
// every signature against the registry's public keys (any key state), and check the signed head.
//
// One problem code per way the evidence can be wrong, so an operator sees WHAT was done to it:
//   hash_mismatch     a record's content changed after it was written (a tampered field)
//   column_mismatch   an indexed column disagrees with the body it indexes
//   chain_break       a record's prev does not match the hash before it (re-signing one record
//                     without rebuilding everything after it lands here)
//   seq_gap           the sequence is not dense: a record was removed or moved
//   unknown_kid       signed by a key the registry has never held
//   bad_signature     the signature does not verify under that key
//   unsigned          written with no EdDSA key available (a problem unless allowUnsigned)
//   head_untrusted    the record was written while the chain head failed validation (the server
//                     refused to re-sign it); never hidden by allowUnsigned
//   head_mismatch / head_missing / head_bad_signature / head_unsigned
//                     the signed head disagrees with the chain (a removed tail), is gone, or is
//                     not a valid signature
import type { Database } from "../db/types";
import type { KeyResolver } from "./signer";
import { verifyMessage } from "./signer";
import {
  headMessage,
  provenanceVaults,
  readChain,
  readHeadRow,
  recordMessage,
  sha256Hex,
} from "./store";
import { GENESIS_HASH } from "./types";

export type ProblemCode =
  | "hash_mismatch"
  | "column_mismatch"
  | "chain_break"
  | "seq_gap"
  | "malformed"
  | "unknown_kid"
  | "bad_signature"
  | "unsigned"
  | "head_mismatch"
  | "head_untrusted"
  | "head_missing"
  | "head_bad_signature"
  | "head_unknown_kid"
  | "head_unsigned";

export interface Problem {
  code: ProblemCode;
  seq?: number;
  detail: string;
}

export interface VaultVerification {
  vault: string;
  records: number;
  signed: number;
  unsigned: number;
  problems: Problem[];
  ok: boolean;
}

export interface VerifyOptions {
  resolveKey: KeyResolver;
  /** Treat unsigned records as acceptable (chain-only deployments). Default false. */
  allowUnsigned?: boolean;
}

function checkSignature(
  resolveKey: KeyResolver,
  kid: string | null,
  sig: string | null,
  message: string,
  codes: { unknown: ProblemCode; bad: ProblemCode },
  seq?: number,
): Problem | undefined {
  const at = seq === undefined ? {} : { seq };
  if (kid === null || sig === null) return undefined;
  const jwk = resolveKey(kid);
  if (jwk === undefined) {
    return {
      code: codes.unknown,
      ...at,
      detail: `signed by kid ${kid}, which the registry has never held`,
    };
  }
  return verifyMessage(jwk, message, sig)
    ? undefined
    : { code: codes.bad, ...at, detail: `signature does not verify under kid ${kid}` };
}

export function verifyVault(db: Database, vaultId: string, opts: VerifyOptions): VaultVerification {
  const problems: Problem[] = [];
  const head = readHeadRow(db, vaultId);
  const rows = readChain(db, vaultId);
  let expectSeq = (head?.pruned_seq ?? 0) + 1;
  let prev = head?.pruned_hash ?? GENESIS_HASH;
  let signed = 0;
  let unsigned = 0;

  for (const r of rows) {
    if (r.seq !== expectSeq) {
      problems.push({
        code: "seq_gap",
        seq: r.seq,
        detail: `expected seq ${expectSeq}, found ${r.seq}: a record was removed or moved`,
      });
    }
    if (sha256Hex(r.body) !== r.hash) {
      problems.push({
        code: "hash_mismatch",
        seq: r.seq,
        detail: "record content does not match its hash",
      });
    }
    let body:
      | { vault?: unknown; seq?: unknown; ts?: unknown; prev?: unknown; integrity?: unknown }
      | undefined;
    try {
      body = JSON.parse(r.body);
    } catch {
      problems.push({ code: "malformed", seq: r.seq, detail: "record body is not JSON" });
    }
    if (
      body !== undefined &&
      (body.vault !== r.vault_id ||
        body.seq !== r.seq ||
        body.ts !== r.ts ||
        body.prev !== r.prev_hash)
    ) {
      problems.push({
        code: "column_mismatch",
        seq: r.seq,
        detail: "an indexed column disagrees with the record body",
      });
    }
    const fault = (body?.integrity as { head_fault?: unknown } | undefined)?.head_fault;
    if (typeof fault === "string") {
      problems.push({
        code: "head_untrusted",
        seq: r.seq,
        detail: `written while the chain head failed validation: ${fault}`,
      });
    }
    if (r.prev_hash !== prev) {
      problems.push({
        code: "chain_break",
        seq: r.seq,
        detail: "prev_hash does not match the preceding record's hash",
      });
    }
    if (r.kid === null || r.sig === null) {
      unsigned++;
      problems.push({ code: "unsigned", seq: r.seq, detail: "record has no signature" });
    } else {
      signed++;
      const bad = checkSignature(
        opts.resolveKey,
        r.kid,
        r.sig,
        recordMessage(r.hash),
        { unknown: "unknown_kid", bad: "bad_signature" },
        r.seq,
      );
      if (bad !== undefined) problems.push(bad);
    }
    prev = r.hash;
    expectSeq = r.seq + 1;
  }

  if (head === undefined) {
    if (rows.length > 0) {
      problems.push({ code: "head_missing", detail: "the signed chain head is missing" });
    }
  } else {
    const last = rows.at(-1);
    const tailOk =
      last === undefined
        ? head.head_seq === head.pruned_seq && head.head_hash === head.pruned_hash
        : last.seq === head.head_seq && last.hash === head.head_hash;
    if (!tailOk) {
      problems.push({
        code: "head_mismatch",
        detail: `head says seq ${head.head_seq}, the chain ends at ${last?.seq ?? head.pruned_seq}: a record was removed from the end`,
      });
    }
    if (head.kid === null || head.sig === null) {
      problems.push({ code: "head_unsigned", detail: "chain head has no signature" });
    } else {
      const bad = checkSignature(opts.resolveKey, head.kid, head.sig, headMessage(head), {
        unknown: "head_unknown_kid",
        bad: "head_bad_signature",
      });
      if (bad !== undefined) problems.push(bad);
    }
  }

  const failing = problems.filter(
    (p) => opts.allowUnsigned !== true || (p.code !== "unsigned" && p.code !== "head_unsigned"),
  );
  return {
    vault: vaultId,
    records: rows.length,
    signed,
    unsigned,
    problems,
    ok: failing.length === 0,
  };
}

/** Verify every vault with a chain, or just `vaultId` (which may have none: zero records, ok). */
export function verifyProvenance(
  db: Database,
  opts: VerifyOptions,
  vaultId?: string,
): VaultVerification[] {
  const vaults = vaultId === undefined ? provenanceVaults(db) : [vaultId];
  return vaults.map((v) => verifyVault(db, v, opts));
}
