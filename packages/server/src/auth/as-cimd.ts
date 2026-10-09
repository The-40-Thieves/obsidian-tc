// The one place a `client_id` becomes a client (design v2 section 4.7): a static client from
// `auth.as.clients` first, otherwise a Client ID Metadata Document fetched from the client_id URL.
// Authorize, consent, token and revoke all resolve through here, so no endpoint can accept a client
// another would refuse.
//
// The fetch is `fetchBoundedText` as the OIDC and JWKS fetches use it: https only, no redirects,
// every resolved address public and checked after resolution, the connection pinned to those
// addresses, 5 KiB, 5 s. There is deliberately NO private-network opt-in for a document: the URL is
// chosen by whoever starts a sign-in, so it can never be allowed to reach the operator's network.
//
// Cache (`cimd_cache`, keyed by the exact client_id): a document is kept for the response's
// `Cache-Control: max-age` clamped to 5 minutes..24 hours. Only the validated fields are stored, a
// stored row whose document names another client is ignored, errors are never cached, and the table
// is capped. Concurrent lookups of one client share one fetch, and at most MAX_INFLIGHT fetches run at once.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { inWriteTransaction } from "../db/txn";
import type { Database } from "../db/types";
import {
  CIMD_MAX_BYTES,
  type ClientDocument,
  parseClientDocument,
  parseClientIdUrl,
} from "./as-cimd-document";
import { type AsClient, findStaticClient } from "./as-clients";
import { fetchBoundedText } from "./oidc-discovery";

type StaticClient = NonNullable<NonNullable<ServerConfig["auth"]["as"]>["clients"]>[number];

export const CIMD_TTL_MIN_MS = 5 * 60_000;
export const CIMD_TTL_MAX_MS = 24 * 60 * 60_000;
export const CIMD_CACHE_ROWS = 1000;
const MAX_INFLIGHT = 8;

/** The answer for a client_id: the client, or why not. `unavailable`: the document could not be got
 *  right now (a transient failure), as opposed to the client being refused. */
export type ClientLookup = { client: AsClient } | { failure: string; unavailable?: true };
export type ClientResolver = (clientId: string) => Promise<ClientLookup>;

/** Test seams: the transport, the name resolver, the timeout and the cache cap. */
export interface CimdSeams {
  fetch?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  maxCacheRows?: number;
}

export interface ResolverDeps {
  clients: readonly StaticClient[];
  allowedHosts: readonly string[];
  /** oauth.db. */
  db: Database;
  now: () => number;
  log: (line: string) => void;
  seams?: CimdSeams | undefined;
}

export const UNKNOWN_CLIENT = "unknown client";

/** The cache lifetime a `Cache-Control` value asks for, clamped; anything unusable is the floor. */
export function cimdTtlMs(cacheControl: string | null): number {
  const m = /(?:^|[\s,])max-age=(\d{1,9})(?=$|[\s,;])/i.exec(cacheControl ?? "");
  const asked = m?.[1] === undefined ? 0 : Number(m[1]) * 1000;
  return Math.min(CIMD_TTL_MAX_MS, Math.max(CIMD_TTL_MIN_MS, asked));
}

const asClient = (d: ClientDocument): AsClient => ({
  clientId: d.clientId,
  name: d.name,
  redirectUris: d.redirectUris,
  cimd: true,
});

/** A cached document for exactly this client_id that is still live and still names it. */
function cached(db: Database, clientId: string, now: number): ClientDocument | undefined {
  const row = db
    .prepare("SELECT document_json FROM cimd_cache WHERE client_id = ? AND expires_at > ?")
    .get(clientId, now) as { document_json: string } | undefined;
  if (row === undefined) return undefined;
  try {
    const d = JSON.parse(row.document_json) as Partial<ClientDocument>;
    if (
      d.clientId === clientId &&
      typeof d.name === "string" &&
      Array.isArray(d.redirectUris) &&
      d.redirectUris.length > 0 &&
      d.redirectUris.every((u) => typeof u === "string")
    ) {
      return { clientId, name: d.name, redirectUris: d.redirectUris };
    }
  } catch {
    // fall through: a row that does not parse is dropped like one that names another client
  }
  db.prepare("DELETE FROM cimd_cache WHERE client_id = ?").run(clientId);
  return undefined;
}

function store(
  db: Database,
  doc: ClientDocument,
  now: number,
  ttlMs: number,
  maxRows: number,
): void {
  inWriteTransaction(db, "as_grants", () => {
    db.prepare("DELETE FROM cimd_cache WHERE expires_at <= ? OR client_id = ?").run(
      now,
      doc.clientId,
    );
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM cimd_cache").get() as { n: number };
    if (n >= maxRows) {
      db.prepare(
        "DELETE FROM cimd_cache WHERE client_id IN (SELECT client_id FROM cimd_cache ORDER BY fetched_at ASC LIMIT ?)",
      ).run(n - maxRows + 1);
    }
    db.prepare(
      "INSERT INTO cimd_cache (client_id, document_json, fetched_at, expires_at) VALUES (?, ?, ?, ?)",
    ).run(doc.clientId, JSON.stringify(doc), now, now + ttlMs);
  });
}

export function createClientResolver(d: ResolverDeps): ClientResolver {
  const inflight = new Map<string, Promise<ClientLookup>>();
  const maxRows = d.seams?.maxCacheRows ?? CIMD_CACHE_ROWS;
  const refused = (why: string): ClientLookup => {
    d.log(`client metadata document refused: ${why}`);
    return { failure: why };
  };

  async function fetchDocument(clientId: string): Promise<ClientLookup> {
    let cacheControl: string | null = null;
    let text: string;
    try {
      text = await fetchBoundedText(clientId, {
        ...(d.seams?.fetch ? { fetch: d.seams.fetch } : {}),
        ...(d.seams?.timeoutMs !== undefined ? { timeoutMs: d.seams.timeoutMs } : {}),
        // No private-network opt-in: a document is never fetched from a non-public address.
        network: d.seams?.resolveHost ? { resolveHost: d.seams.resolveHost } : {},
        maxBytes: CIMD_MAX_BYTES,
        what: "client metadata document",
        onResponse: (res) => {
          cacheControl = res.headers.get("cache-control");
        },
      });
    } catch (e) {
      // The detail names addresses and URLs: it goes to the log, never to the caller.
      d.log(`client metadata document not fetched: ${e instanceof Error ? e.message : String(e)}`);
      return { failure: "the client's metadata document could not be fetched", unavailable: true };
    }
    const parsed = parseClientDocument(clientId, text);
    if (!parsed.ok) return refused(parsed.message);
    store(d.db, parsed.doc, d.now(), cimdTtlMs(cacheControl), maxRows);
    return { client: asClient(parsed.doc) };
  }

  async function viaMetadata(clientId: string): Promise<ClientLookup> {
    const url = parseClientIdUrl(clientId);
    if (typeof url === "string") return refused(url);
    if (d.allowedHosts.length > 0 && !d.allowedHosts.includes(url.hostname)) {
      return refused("this server does not accept clients hosted at that address");
    }
    const hit = cached(d.db, clientId, d.now());
    if (hit !== undefined) return { client: asClient(hit) };
    const running = inflight.get(clientId);
    if (running !== undefined) return running;
    if (inflight.size >= MAX_INFLIGHT) {
      return { failure: "too many client lookups are in progress", unavailable: true };
    }
    const p = fetchDocument(clientId).finally(() => inflight.delete(clientId));
    inflight.set(clientId, p);
    return p;
  }

  return async (clientId) => {
    const fixed = findStaticClient(d.clients, clientId);
    if (fixed !== undefined) return { client: fixed };
    // Anything that is not even shaped like a URL is simply not registered.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(clientId)) return { failure: UNKNOWN_CLIENT };
    return viaMetadata(clientId);
  };
}
