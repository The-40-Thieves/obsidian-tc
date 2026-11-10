// Operator-only registration management. Removing a client and queuing revocation of every grant
// share one transaction; the durable outbox bridges oauth.db to auth.db after commit.
import { inWriteTransaction } from "../db/txn";
import type { Database } from "../db/types";
import { drainRevocations, queueGrantRevocation } from "./as-grants";
import type { AuthRegistry } from "./registry";

export interface RegisteredClientSummary {
  clientId: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

export function listRegisteredClients(db: Database): RegisteredClientSummary[] {
  return db
    .prepare(
      `SELECT client_id AS clientId, created_at AS createdAt, last_used_at AS lastUsedAt,
            expires_at AS expiresAt FROM oauth_clients WHERE kind = 'dcr'
      ORDER BY created_at DESC, client_id`,
    )
    .all() as RegisteredClientSummary[];
}

export function removeRegisteredClient(
  db: Database,
  registry: Pick<AuthRegistry, "revoke">,
  clientId: string,
  reason: string,
  now: number,
): { status: "removed" | "not_found" | "not_dcr"; grants: number } {
  const result = inWriteTransaction(db, "as_grants", () => {
    const row = db.prepare("SELECT kind FROM oauth_clients WHERE client_id = ?").get(clientId) as
      | { kind: string }
      | undefined;
    if (row === undefined) return { status: "not_found" as const, grants: 0 };
    if (row.kind !== "dcr") return { status: "not_dcr" as const, grants: 0 };
    const grants = db.prepare("SELECT id FROM grants WHERE client_id = ?").all(clientId) as Array<{
      id: string;
    }>;
    for (const { id } of grants) queueGrantRevocation(db, id, reason, now);
    // End outstanding sign-ins as well as preventing fresh client resolution.
    db.prepare("UPDATE auth_requests SET used_at = COALESCE(used_at, ?) WHERE client_id = ?").run(
      now,
      clientId,
    );
    db.prepare("DELETE FROM oauth_clients WHERE client_id = ? AND kind = 'dcr'").run(clientId);
    return { status: "removed" as const, grants: grants.length };
  });
  // Also drain on a retry after the row was deleted but the registry write failed.
  drainRevocations(db, registry);
  return result;
}
