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
// Ordinary settling stays fail-open like the audit row: a recording fault never turns an already
// committed write into an error. The multi-note `pending` row is the exception: it runs before the
// first rename and fails closed, because the write can still be safely refused. Post-commit faults
// are made visible (`fault` below) through stderr, a counter, and an `event_log` row that `doctor`
// reads; a pending-row fault is returned to the caller and reported through `onError`.

import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { writeEvent } from "../audit";
import type { WriteTxnHooks } from "../db/txn";
import type { Database } from "../db/types";
import { vaultArgOf } from "../mcp/registry/input-binding";
import type { CallerContext, ProvenanceSink, ToolDefinition } from "../mcp/registry/types";
import { normalizeVaultPath } from "../vault/paths";
import { digestUnder } from "./digest";
import type { KeyResolver, SignerSource } from "./signer";
import { appendProvenance } from "./store";
import { type Digest, type PathEntry, PROVENANCE_FAULT_EVENT, type ProvenanceBody } from "./types";

/** Paths recorded per call; more are counted in `paths_omitted`. Bounds the row and the hashing. */
export const MAX_PATHS_PER_RECORD = 500;
export { MAX_HASH_BYTES } from "./digest";

/** What the recorder reports a fault to (the Prometheus recorder implements it). */
export interface ProvenanceFaultMetrics {
  incFault(vault: string, tool: string, kind: "omitted" | "head_untrusted"): void;
}

export interface ProvenanceRecorderOptions {
  db: Database;
  /** The host id recorded on every row: a salted hash by default, or an operator label. */
  host: string;
  serverVersion: string;
  signer?: SignerSource;
  now?: () => number;
  hooks?: WriteTxnHooks;
  /** Sink for a recording fault (the stderr line). */
  onError?: (tool: string, vaultId: string, e: unknown) => void;
  /** Counter for the same faults; they are also written to `event_log` for `doctor`. */
  metrics?: ProvenanceFaultMetrics;
}

export interface PendingProvenance {
  tool: string;
  vaultId: string;
  root: string | undefined;
  before: Array<{ path: string; before: Digest }>;
  omitted: number;
  /** Set once `recordPending` appended this call's pending record: the settling record is then
   *  written even for an error that changed nothing, so the pending one is never left unanswered. */
  pendingWritten?: boolean;
  attribution: Pick<ProvenanceBody, "verified" | "unauthenticated" | "self_reported">;
}

/** The digest a write's own result vouches for: handlers that rewrite one note return the sha256 of
 *  the exact content they wrote (`content_hash`), so that, not a later re-read of the disk, is the
 *  record's `after` (a re-read can see bytes a concurrent writer planted after the handler
 *  returned). Only for a single named path whose result `path` is that path. */
function writtenDigest(result: unknown, named: Array<{ path: string }>): string | undefined {
  const [only] = named;
  if (named.length !== 1 || only === undefined || typeof result !== "object" || result === null) {
    return undefined;
  }
  const { content_hash: hash, path } = result as { content_hash?: unknown; path?: unknown };
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash) || typeof path !== "string") {
    return undefined;
  }
  try {
    return normalizeVaultPath(path) === normalizeVaultPath(only.path) ? hash : undefined;
  } catch {
    return undefined;
  }
}

function safeNormalize(path: string): string {
  try {
    return normalizeVaultPath(path);
  } catch {
    return path;
  }
}

export class ProvenanceRecorder implements ProvenanceSink {
  private signerSource: SignerSource | undefined;
  private keySource: (() => KeyResolver) | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: ProvenanceRecorderOptions) {
    this.signerSource = opts.signer;
    this.now = opts.now ?? Date.now;
  }

  /** Wired after construction: the auth registry opens later than the tool registry. */
  setSignerSource(source: SignerSource | undefined): void {
    this.signerSource = source;
  }

  /** Wired beside the signer source: every registry key in any state, for `get_provenance`'s
   *  per-record verification (a retired key still vouches for what it signed). */
  setKeyResolverSource(source: (() => KeyResolver) | undefined): void {
    this.keySource = source;
  }

  keyResolver(): KeyResolver | undefined {
    return this.keySource?.();
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
   * Append the `pending` record of a multi-note commit, just before its first note is replaced:
   * each named path with the digest it had at `begin` and the digest the commit is about to write
   * (`after`; a path the commit leaves alone keeps its `before`). Synchronous and fail-closed: if
   * the durable intent cannot be appended, the caller must abort before its first rename.
   */
  recordPending(p: PendingProvenance, after: ReadonlyMap<string, string>): void {
    try {
      const paths = p.before.flatMap((b): PathEntry[] => {
        const digest = after.get(b.path) ?? after.get(safeNormalize(b.path));
        return digest === undefined ? [] : [{ path: b.path, before: b.before, after: digest }];
      });
      const appended = appendProvenance(
        this.opts.db,
        {
          vaultId: p.vaultId,
          ts: this.now(),
          tool: p.tool,
          outcome: "pending",
          paths,
          pathsOmitted: Math.max(0, after.size - paths.length),
          ...p.attribution,
        },
        this.signerSource?.(),
        this.opts.hooks,
      );
      p.pendingWritten = true;
      if (appended.headFault !== undefined) {
        this.fault("head_untrusted", p.tool, p.vaultId, new Error(appended.headFault));
      }
    } catch (e) {
      // No write has happened yet, so this is not an omitted record for a committed effect and
      // must not increment the omission counter or create a misleading doctor event.
      try {
        this.opts.onError?.(p.tool, p.vaultId, e);
      } catch {}
      throw err.internalError("write refused because pending provenance could not be recorded", {
        cause: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Append the record for a settled call. `error` outcomes are recorded only when a named path's
   * digest actually moved. Never throws.
   */
  async commit(
    p: PendingProvenance,
    outcome: "ok" | "error",
    result?: unknown,
    batchWritten?: ReadonlyMap<string, string>,
  ): Promise<void> {
    try {
      const resultWritten = outcome === "ok" ? writtenDigest(result, p.before) : undefined;
      const paths: PathEntry[] = await Promise.all(
        p.before.map(async (b) => ({
          path: b.path,
          before: b.before,
          after:
            outcome === "ok"
              ? (batchWritten?.get(b.path) ??
                batchWritten?.get(safeNormalize(b.path)) ??
                resultWritten ??
                (await digestUnder(p.root, b.path)))
              : await digestUnder(p.root, b.path),
        })),
      );
      if (outcome === "error" && !p.pendingWritten && !paths.some((e) => e.before !== e.after))
        return;
      const appended = appendProvenance(
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
      if (appended.headFault !== undefined) {
        this.fault("head_untrusted", p.tool, p.vaultId, new Error(appended.headFault));
      }
    } catch (e) {
      this.fault("omitted", p.tool, p.vaultId, e);
    }
  }

  /** Make a fault visible three ways: the stderr line, the counter, and an `event_log` row (the one
   *  place `doctor`, a separate process, can see it). Never throws: this runs inside the fail-open
   *  catch, and the event write may itself be failing for the same reason as the record. */
  private fault(kind: "omitted" | "head_untrusted", tool: string, vaultId: string, e: unknown) {
    this.opts.onError?.(tool, vaultId, e);
    this.opts.metrics?.incFault(vaultId, tool, kind);
    try {
      writeEvent(this.opts.db, {
        ts: this.now(),
        vault_id: vaultId,
        tool_name: tool,
        status: "error",
        error_code: `provenance_${kind}`,
        event_type: PROVENANCE_FAULT_EVENT,
      });
    } catch {
      // The counter and the stderr line above are what is left.
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

/** The caller's principal, only when a bearer token proved it (stdio and `auth.mode: none` never
 *  do). The one definition shared by the record and the optional stamps. */
export const verifiedPrincipalOf = (
  ctx: Pick<CallerContext, "authVerified" | "caller">,
): string | undefined => (ctx.authVerified === true && ctx.caller ? ctx.caller : undefined);

function attributionOf(
  ctx: CallerContext,
  host: string,
  serverVersion: string,
): PendingProvenance["attribution"] {
  const verifiedPrincipal = verifiedPrincipalOf(ctx);
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
