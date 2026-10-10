// The CallerContext factory for the stdio transport, lifted out of server-runtime.ts (biome's file
// line ceiling) verbatim.
import type { FolderAcl } from "../acl";
import type { Database } from "../db/types";
import type { CallerContext } from "../mcp/registry";
import type { ActiveSessionTracker } from "../workspace/sessions";

/** stdio is the trusted local transport: the operator runs the binary against their own vault,
 *  so calls are authenticated with full local scope. `signal` is the SDK's per-request
 *  extra.signal, threaded through so a caller that cancels a stdio call stops runDispatch at
 *  the next stage boundary. */
export function stdioContext(deps: {
  activeSessions: ActiveSessionTracker;
  db: Database;
  acl: FolderAcl;
  config: { sessions: { windowSeconds?: number } };
  firstVault: { id: string };
}): (signal?: AbortSignal) => CallerContext {
  const { activeSessions, db, acl, config, firstVault } = deps;
  return (signal) => {
    const active = activeSessions.validate(db, "stdio", config.sessions);
    return {
      caller: "stdio",
      transport: "stdio",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: firstVault.id,
      db,
      acl,
      signal,
      ...(active && active.vaultId === firstVault.id ? { sessionId: active.sessionId } : {}),
    };
  };
}
