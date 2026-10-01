// The dispatch-side half of write provenance: `begin` runs just before a mutating handler and
// hashes the paths the call names; `commit` runs once the call settled and appends ONE record.
// runDispatch is the only caller, so every mutating tool is covered by construction and a new one
// needs nothing added.
//
// What is recorded, and what is not:
//   * a call that succeeded (or whose response overflowed, which still wrote): recorded;
//   * a call that failed but changed a named path anyway (a partial write): recorded, outcome
//     `error`;
//   * a refused, denied, invalid, replayed or no-op-failed call: NOT recorded (event_log holds the
//     attempt; this table is what changed).
//   * paths are the ones the call NAMES (the tool's `pathAcl` set). Notes a tool rewrites as a side
//     effect, such as backlinks updated by a move, are not listed.
//
// Fail-open like the audit row: a recording fault is reported to `onError` and never turns a
// committed write into an error.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { hostname } from "node:os";
import type { WriteTxnHooks } from "../db/txn";
import type { Database } from "../db/types";
import { vaultArgOf } from "../mcp/registry/input-binding";
import type { CallerContext, ProvenanceSink, ToolDefinition } from "../mcp/registry/types";
import { resolveVaultPathChecked } from "../vault/paths";
import type { SignerSource } from "./signer";
import { appendProvenance } from "./store";
import {
  DIGEST_ABSENT,
  DIGEST_UNHASHABLE,
  type Digest,
  type PathEntry,
  type ProvenanceBody,
} from "./types";

/** Paths recorded per call; more are counted in `paths_omitted`. Bounds the row and the hashing. */
export const MAX_PATHS_PER_RECORD = 500;
/** Largest file hashed; bigger is `unhashable` so one huge attachment cannot stall dispatch. */
export const MAX_HASH_BYTES = 256 * 1024 * 1024;

export interface ProvenanceRecorderOptions {
  db: Database;
  /** The host id recorded on every row: a salted hash by default, or an operator label. */
  host: string;
  serverVersion: string;
  signer?: SignerSource;
  now?: () => number;
  hooks?: WriteTxnHooks;
  /** Fail-open sink for a recording fault. */
  onError?: (tool: string, vaultId: string, e: unknown) => void;
}

export interface PendingProvenance {
  tool: string;
  vaultId: string;
  root: string | undefined;
  before: Array<{ path: string; before: Digest }>;
  omitted: number;
  attribution: Pick<ProvenanceBody, "verified" | "unauthenticated" | "self_reported">;
}

/** sha256 of a regular file's bytes. The leaf is opened O_NOFOLLOW, so a symlink swapped in after
 *  the containment check is refused (ELOOP) instead of read. */
async function digestOf(abs: string): Promise<Digest> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = await fh.stat();
    if (!st.isFile() || st.size > MAX_HASH_BYTES) return DIGEST_UNHASHABLE;
    const h = createHash("sha256");
    for await (const chunk of fh.createReadStream({ autoClose: false })) h.update(chunk as Buffer);
    return h.digest("hex");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? DIGEST_ABSENT : DIGEST_UNHASHABLE;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/**
 * Digest of `path` under `root`. Containment is the write path's own guard
 * (`resolveVaultPathChecked`: lexical traversal plus a realpath check that refuses an in-vault
 * symlink or symlinked ancestor pointing outside the vault), so a digest can never be used to probe
 * a file the tools themselves could not touch. Anything it refuses is `unhashable`, never read.
 */
function digestUnder(root: string | undefined, path: string): Promise<Digest> {
  if (root === undefined) return Promise.resolve(DIGEST_UNHASHABLE);
  let abs: string;
  try {
    abs = resolveVaultPathChecked(root, path).abs;
  } catch {
    return Promise.resolve(DIGEST_UNHASHABLE);
  }
  return digestOf(abs);
}

export class ProvenanceRecorder implements ProvenanceSink {
  private signerSource: SignerSource | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: ProvenanceRecorderOptions) {
    this.signerSource = opts.signer;
    this.now = opts.now ?? Date.now;
  }

  /** Wired after construction: the auth registry opens later than the tool registry. */
  setSignerSource(source: SignerSource | undefined): void {
    this.signerSource = source;
  }

  /** Hash the named paths before the handler runs. Never throws. */
  async begin(
    def: ToolDefinition,
    input: unknown,
    ctx: CallerContext,
    root: string | undefined,
  ): Promise<PendingProvenance> {
    const vaultId = vaultArgOf(def, input) ?? ctx.vaultId;
    const named = new Set<string>();
    try {
      if (def.pathAcl && root !== undefined) {
        for (const { path } of def.pathAcl(input as never, { root })) named.add(path);
      }
    } catch (e) {
      this.opts.onError?.(def.name, vaultId, e);
    }
    const all = [...named];
    const listed = all.slice(0, MAX_PATHS_PER_RECORD);
    const before = await Promise.all(
      listed.map(async (path) => ({ path, before: await digestUnder(root, path) })),
    );
    return {
      tool: def.name,
      vaultId,
      root,
      before,
      omitted: all.length - listed.length,
      attribution: attributionOf(ctx, this.opts.host, this.opts.serverVersion),
    };
  }

  /**
   * Append the record for a settled call. `error` outcomes are recorded only when a named path's
   * digest actually moved. Never throws.
   */
  async commit(p: PendingProvenance, outcome: "ok" | "error"): Promise<void> {
    try {
      const paths: PathEntry[] = await Promise.all(
        p.before.map(async (b) => ({
          path: b.path,
          before: b.before,
          after: await digestUnder(p.root, b.path),
        })),
      );
      if (outcome === "error" && !paths.some((e) => e.before !== e.after)) return;
      appendProvenance(
        this.opts.db,
        {
          vaultId: p.vaultId,
          ts: this.now(),
          tool: p.tool,
          outcome,
          paths,
          pathsOmitted: p.omitted,
          ...p.attribution,
        },
        this.signerSource?.(),
        this.opts.hooks,
      );
    } catch (e) {
      this.opts.onError?.(p.tool, p.vaultId, e);
    }
  }

  /** The signer the next append would use (maintenance pruning re-signs the head with it). */
  currentSigner(): ReturnType<SignerSource> {
    return this.signerSource?.();
  }
}

/** The host id a record carries: `hashed` (default) is a stable digest of the machine's hostname,
 *  so rows from one host correlate without naming it; `label` is the operator's own string. */
export function resolveHostId(cfg: {
  mode: "hashed" | "label";
  label?: string | undefined;
}): string {
  if (cfg.mode === "label" && cfg.label) return cfg.label;
  return createHash("sha256")
    .update(`obsidian-tc:host:${hostname()}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function attributionOf(
  ctx: CallerContext,
  host: string,
  serverVersion: string,
): PendingProvenance["attribution"] {
  const verifiedPrincipal = ctx.authVerified === true && ctx.caller ? ctx.caller : undefined;
  return {
    verified: {
      host,
      server_version: serverVersion,
      ...(ctx.transport !== undefined ? { transport: ctx.transport } : {}),
      ...(verifiedPrincipal !== undefined ? { principal: verifiedPrincipal } : {}),
      ...(ctx.authVerified === true && ctx.persona !== undefined ? { persona: ctx.persona } : {}),
      ...(ctx.sessionId !== undefined ? { session_id: ctx.sessionId } : {}),
    },
    unauthenticated: verifiedPrincipal === undefined && ctx.caller ? { principal: ctx.caller } : {},
    self_reported: {
      ...(ctx.claimedProvenance ?? {}),
      ...(ctx.clientInfo !== undefined ? { client: ctx.clientInfo } : {}),
    },
  };
}
