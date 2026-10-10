// What of a CallerContext crosses the enqueue of a task-backed tool call, in one place.
//
// The offload happens BEFORE registry dispatch and the worker has no request, so it rebuilds a
// context from the job payload. Copying fields one by one into that payload dropped everything
// nobody thought to copy: `toolVisibility`, the persona's mask, which dispatch enforces, so a
// persona that disabled `external-network` was refused a synchronous `index_vault` and served the
// same call as a task. The fix is not one more field. Every key of CallerContext is classified
// below, `Record<keyof CallerContext, ...>` makes an unclassified new key a compile error, and
// test/task-offload-policy.test.ts also fails when dispatch reads a key that is not in the table
// or a carried key does not survive the JSON round trip.

import type { ToolVisibilityConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { FolderAcl } from "../acl";
import type { Database } from "../db/types";
import type { ClaimedProvenance } from "../provenance/types";
import type { ClientInfo } from "./client-info";
import type { CallerContext } from "./registry";

/** The caller half of a task-call payload: JSON, so it can sit in a job row. */
export interface CallerSnapshot {
  caller: string | null;
  authenticated: boolean;
  /** `grantedScopes`, as the array a JSON payload can hold. */
  scopes: string[];
  vaultId: string;
  vaultBound: boolean;
  transport?: "stdio" | "http";
  persona?: string;
  authVerified?: boolean;
  claimedProvenance?: ClaimedProvenance;
  toolVisibility?: ToolVisibilityConfig;
  clientInfo?: ClientInfo;
  sessionId?: string;
}

/** What the worker supplies itself: deployment state and the live run, never caller state. */
export interface WorkerRuntime {
  db: Database;
  acl: FolderAcl;
  signal?: AbortSignal | undefined;
  progress?: CallerContext["progress"];
}

type Disposition =
  | { how: "carried" }
  | { how: "rebuilt"; by: string }
  | { how: "dropped"; why: string };

const carried: Disposition = { how: "carried" };
const rebuilt = (by: string): Disposition => ({ how: "rebuilt", by });
const dropped = (why: string): Disposition => ({ how: "dropped", why });

const HITL =
  "HITL-gated tools cannot be taskAugmentable (registration refuses them), so no confirmation round exists to carry";
const BY_DISPATCH = "set by dispatch itself during the worker's own call";

/**
 * Every CallerContext key and what the offload path does with it. Adding a key to CallerContext
 * without adding it here fails the typecheck; reading a new key in dispatch without it fails the
 * test. A `dropped` entry needs a reason a reviewer can disagree with.
 */
export const CALLER_CONTEXT_DISPOSITION: Record<keyof CallerContext, Disposition> = {
  caller: carried,
  authenticated: carried,
  grantedScopes: carried,
  vaultId: carried,
  vaultBound: carried,
  transport: carried,
  persona: carried,
  authVerified: carried,
  claimedProvenance: carried,
  toolVisibility: carried,
  clientInfo: carried,
  sessionId: carried,
  db: rebuilt("the worker's own database handle (deployment state)"),
  acl: rebuilt(
    "the server's folder ACL; dispatch then applies the per-vault ACL, as it does synchronously",
  ),
  signal: rebuilt("the job's own abort signal (cancel, lease loss, shutdown)"),
  progress: rebuilt(
    "the queue's progress fan-out, only when the originating request had a progressToken",
  ),
  callerVaultId: dropped(BY_DISPATCH),
  markEffectCommitted: dropped(BY_DISPATCH),
  recordPendingWrite: dropped(BY_DISPATCH),
  elicitToken: dropped(HITL),
  elicitState: dropped(HITL),
  relayElicitConsumed: dropped(HITL),
  hitlRoute: dropped(HITL),
  hitlAnswer: dropped(HITL),
  roots: dropped(
    "a live channel to the client; the request that owned it has ended by the time a task runs",
  ),
  sample: dropped(
    "a live channel to the client; the request that owned it has ended by the time a task runs",
  ),
  now: dropped("a test clock injection; the worker uses the real clock"),
  traceCarrier: dropped(
    "parents the caller's trace span; the task's own span is a new root, not a policy input",
  ),
  effectiveFacadeMode: dropped(
    "observability of how tools/list was shaped for the originating connection",
  ),
  facadeExplanation: dropped(
    "observability of how tools/list was shaped for the originating connection",
  ),
};

/** The payload half of a task call: everything about the caller that the worker is allowed to know. */
export function snapshotCaller(ctx: CallerContext): CallerSnapshot {
  return {
    caller: ctx.caller,
    authenticated: ctx.authenticated,
    scopes: [...ctx.grantedScopes],
    vaultId: ctx.vaultId,
    vaultBound: ctx.vaultBound === true,
    ...(ctx.transport !== undefined ? { transport: ctx.transport } : {}),
    ...(ctx.persona !== undefined ? { persona: ctx.persona } : {}),
    ...(ctx.authVerified !== undefined ? { authVerified: ctx.authVerified } : {}),
    ...(ctx.claimedProvenance !== undefined ? { claimedProvenance: ctx.claimedProvenance } : {}),
    ...(ctx.toolVisibility !== undefined ? { toolVisibility: ctx.toolVisibility } : {}),
    ...(ctx.clientInfo !== undefined ? { clientInfo: ctx.clientInfo } : {}),
    ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
  };
}

/**
 * The worker's CallerContext: the carried keys from the payload, the rebuilt ones from `runtime`,
 * nothing else. `authenticated` is read as "not explicitly false" only so that a payload queued
 * before this field existed (all of which were enqueued for an authenticated caller) still runs;
 * the offload itself always writes the real value.
 */
export function restoreCaller(s: CallerSnapshot, runtime: WorkerRuntime): CallerContext {
  return {
    caller: s.caller,
    authenticated: s.authenticated !== false,
    // EXACTLY the enqueue-time grant. Not the server's, not a superset, not re-read.
    grantedScopes: new Set(s.scopes),
    vaultId: s.vaultId,
    vaultBound: s.vaultBound,
    ...(s.transport !== undefined ? { transport: s.transport } : {}),
    ...(s.persona !== undefined ? { persona: s.persona } : {}),
    ...(s.authVerified !== undefined ? { authVerified: s.authVerified } : {}),
    ...(s.claimedProvenance !== undefined ? { claimedProvenance: s.claimedProvenance } : {}),
    ...(s.toolVisibility !== undefined ? { toolVisibility: s.toolVisibility } : {}),
    ...(s.clientInfo !== undefined ? { clientInfo: s.clientInfo } : {}),
    ...(s.sessionId !== undefined ? { sessionId: s.sessionId } : {}),
    db: runtime.db,
    acl: runtime.acl,
    ...(runtime.signal ? { signal: runtime.signal } : {}),
    ...(runtime.progress ? { progress: runtime.progress } : {}),
  };
}
