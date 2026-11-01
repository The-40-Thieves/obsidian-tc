// THE-726 slice 3 / GH #1457: the one place a server-opened session is created. HTTP and stdio both
// call it. Each keeps its own resolve: HTTP reads the durable row, stdio the process-local tracker.
import type { Database } from "../db/types";
import { openImplicitSession } from "./sessions";

/** Open a server-side session for `principal` when `sessions.autoOpen` is on. Returns undefined,
 *  and writes nothing, when it is off or the principal is absent or empty: a row for an
 *  unidentifiable principal would be the shared bucket the resolver refuses to read from. */
export function autoOpenSession(
  db: Database,
  opts: {
    autoOpen: boolean;
    principal: string | null | undefined;
    vaultId: string;
    traceFolder: string;
    now: number;
  },
): { sessionId: string; vaultId: string } | undefined {
  if (!opts.autoOpen || typeof opts.principal !== "string" || opts.principal.length === 0) {
    return undefined;
  }
  return openImplicitSession(db, {
    principal: opts.principal,
    vaultId: opts.vaultId,
    traceFolder: opts.traceFolder,
    now: opts.now,
  });
}
