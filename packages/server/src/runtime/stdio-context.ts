// The CallerContext factory for the stdio transport, lifted out of server-runtime.ts (biome's file
// line ceiling) verbatim.
import type { FolderAcl } from "../acl";
import type { Database } from "../db/types";
import type { CallerContext } from "../mcp/registry";
import { autoOpenSession } from "../workspace/auto-open";
import {
  type ActiveSessionTracker,
  DEFAULT_TRACE_FOLDER,
  endSession,
  inFlightCount,
} from "../workspace/sessions";

// Ids this process opened under sessions.autoOpen, per database handle. Process-local on purpose:
// cache.db is shared, so a second stdio process must never close a row this one did not open.
const openedByDb = new WeakMap<Database, Set<string>>();

/** stdio is the trusted local transport: the operator runs the binary against their own vault,
 *  so calls are authenticated with full local scope. `signal` is the SDK's per-request
 *  extra.signal, threaded through so a caller that cancels a stdio call stops runDispatch at
 *  the next stage boundary. `use` names the MCP method asking for the context: only a call that
 *  touches a vault (tools/call, resources/read) may open a session under sessions.autoOpen. */
export function stdioContext(deps: {
  activeSessions: ActiveSessionTracker;
  db: Database;
  acl: FolderAcl;
  config: { sessions: { autoOpen?: boolean; windowSeconds?: number } };
  defaultVaultId: string;
}): (signal?: AbortSignal, use?: "call" | "read") => CallerContext {
  const { activeSessions, db, acl, config, defaultVaultId } = deps;
  const opened = openedByDb.get(db) ?? new Set<string>();
  openedByDb.set(db, opened);
  return (signal, use) => {
    let active = activeSessions.validate(db, "stdio", config.sessions);
    // A bare list or prompt call names no `use`, so a client's connect-time listing never leaves an
    // empty session behind.
    if (!active && use !== undefined) {
      const fresh = autoOpenSession(db, {
        autoOpen: config.sessions.autoOpen === true,
        principal: "stdio",
        vaultId: defaultVaultId,
        traceFolder: DEFAULT_TRACE_FOLDER,
        now: Date.now(),
      });
      if (fresh) {
        opened.add(fresh.sessionId);
        activeSessions.set("stdio", fresh.sessionId, fresh.vaultId);
        active = fresh;
      }
    }
    return {
      caller: "stdio",
      transport: "stdio",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: defaultVaultId,
      db,
      acl,
      signal,
      ...(active && active.vaultId === defaultVaultId ? { sessionId: active.sessionId } : {}),
    };
  };
}

/** Clean shutdown: close the implicit sessions THIS process opened under sessions.autoOpen. A
 *  session with a call in flight is left for the window sweep, and so is anything missed after a
 *  crash. Best-effort: never throws, and returns how many it closed. */
export function closeStdioOpened(db: Database, now: number): number {
  const opened = openedByDb.get(db);
  if (!opened) return 0;
  let closed = 0;
  try {
    for (const id of opened) {
      if (inFlightCount(id) === 0 && endSession(db, id, now).changes > 0) closed++;
    }
  } catch {
    /* the sweep closes what this misses */
  }
  opened.clear();
  return closed;
}
