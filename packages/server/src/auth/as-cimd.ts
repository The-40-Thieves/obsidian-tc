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
//
// A lookup is reachable by anyone who can start a sign-in, so it is bounded four ways: one deadline
// covers the name lookup, the connection and the body (fetchBoundedText), so a stalled lookup frees its
// slot when the deadline fires; a source (the TCP peer, as_authorize's admission rule, an IPv6 address
// counted as its /64) may start CIMD_SOURCE_BURST uncached lookups a minute, from the same token bucket
// the tool-call limiter uses, and have CIMD_MAX_INFLIGHT_PER_SOURCE running at once, so one source can
// never hold every slot; a peer with no usable address (unknown, or loopback: a same-host proxy or
// tunnel, behind which every client looks alike) is one source of its own with a smaller budget, never
// an exemption; and a caller whose request is already malformed asks for `cacheOnly`, which never
// starts a fetch. A forwarded header is not read: the config names no trusted proxy.
import { isIP } from "node:net";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { inWriteTransaction } from "../db/txn";
import type { Database } from "../db/types";
import { MemoryBackend } from "../ratelimit/memory-backend";
import {
  CIMD_MAX_BYTES,
  type ClientDocument,
  parseClientDocument,
  parseClientIdUrl,
} from "./as-cimd-document";
import { type AsClient, findStaticClient } from "./as-clients";
import { loadRegistration } from "./as-dcr";
import { fetchBoundedText } from "./oidc-discovery";

type StaticClient = NonNullable<NonNullable<ServerConfig["auth"]["as"]>["clients"]>[number];

export const CIMD_TTL_MIN_MS = 5 * 60_000;
export const CIMD_TTL_MAX_MS = 24 * 60 * 60_000;
export const CIMD_CACHE_ROWS = 1000;
const MAX_INFLIGHT = 8;
/** Uncached lookups one source address may start: this many at once, refilling at this many a minute. */
export const CIMD_SOURCE_BURST = 5;
/** Lookups one source may have running at once; the global cap is MAX_INFLIGHT. */
export const CIMD_MAX_INFLIGHT_PER_SOURCE = 2;
/** The shared bucket for peers with no usable address: smaller than a real source's, as it stands for all of them. */
export const CIMD_UNATTRIBUTED_BURST = 10;
const SOURCE_BUDGET = {
  capacity: CIMD_SOURCE_BURST,
  refillTokens: CIMD_SOURCE_BURST,
  intervalMs: 60_000,
};
const UNATTRIBUTED_BUDGET = {
  capacity: CIMD_UNATTRIBUTED_BURST,
  refillTokens: CIMD_UNATTRIBUTED_BURST,
  intervalMs: 60_000,
};
const UNATTRIBUTED = "unattributed";

/** The eight 16-bit groups of an IPv6 address, or undefined when it is not one. */
function ipv6Groups(addr: string): number[] | undefined {
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  let text = addr;
  if (dotted?.[1] !== undefined && isIP(dotted[1]) === 4) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[1].split(".").map(Number);
    text = `${addr.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array<string>(Math.max(fill, 0)).fill("0"), ...tail];
  if (all.length !== 8) return undefined;
  const nums = all.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  return nums.some(Number.isNaN) ? undefined : nums;
}

/**
 * The budget bucket a peer address belongs to: an IPv4 address by itself, an IPv6 address by its /64
 * (a host holds a whole /64 and can rotate within it for free), an IPv4-mapped IPv6 address as the IPv4
 * address, and a missing or unreadable address as the one shared `unattributed` source.
 */
export function cimdSourceKey(source: string | undefined): string {
  const bare = (source ?? "").replace(/%.*$/, "").trim();
  if (isIP(bare) === 4) return `v4:${bare}`;
  const g = isIP(bare) === 6 ? ipv6Groups(bare) : undefined;
  if (g === undefined) return UNATTRIBUTED;
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    const [a = 0, b = 0] = [g[6] ?? 0, g[7] ?? 0];
    return `v4:${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return `v6:${g
    .slice(0, 4)
    .map((n) => n.toString(16))
    .join(":")}`;
}

/** The answer for a client_id: the client, or why not. `unavailable`: the document could not be got
 *  right now (a transient failure), as opposed to the client being refused. */
export type ClientLookup = { client: AsClient } | { failure: string; unavailable?: true };
export interface ClientLookupOptions {
  /** The caller's address, for the per-source limits; unknown or loopback: the shared fallback source. */
  source?: string | undefined;
  /** Answer from config or the cache only: never start a fetch (the request is not worth one). */
  cacheOnly?: boolean | undefined;
}
export type ClientResolver = (
  clientId: string,
  opts?: ClientLookupOptions,
) => Promise<ClientLookup>;

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
  /** `auth.as.dynamicRegistration`: registered clients resolve only while it is on. */
  dynamicRegistration?: boolean | undefined;
  now: () => number;
  log: (line: string) => void;
  seams?: CimdSeams | undefined;
}

export const UNKNOWN_CLIENT = "unknown client";
const UNNAMED_CLIENT = "Unnamed application";

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
  const budgets = new MemoryBackend();
  /** Fetches running per source key (a fetch shared by several callers counts once, for its starter). */
  const running = new Map<string, number>();
  const busy: ClientLookup = {
    failure: "too many client lookups are in progress",
    unavailable: true,
  };
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

  async function viaMetadata(clientId: string, opts?: ClientLookupOptions): Promise<ClientLookup> {
    const url = parseClientIdUrl(clientId);
    if (typeof url === "string") return refused(url);
    if (d.allowedHosts.length > 0 && !d.allowedHosts.includes(url.hostname)) {
      return refused("this server does not accept clients hosted at that address");
    }
    const hit = cached(d.db, clientId, d.now());
    if (hit !== undefined) return { client: asClient(hit) };
    const shared = inflight.get(clientId);
    if (shared !== undefined) return shared;
    if (opts?.cacheOnly) return { failure: "the client is not cached", unavailable: true };
    if (inflight.size >= MAX_INFLIGHT) return busy;
    const source = cimdSourceKey(opts?.source);
    const crowded = (): ClientLookup | undefined => {
      if ((running.get(source) ?? 0) < CIMD_MAX_INFLIGHT_PER_SOURCE) return undefined;
      d.log("client metadata lookups refused: a source has too many running");
      return { failure: "too many client lookups from this address", unavailable: true };
    };
    const early = crowded();
    if (early !== undefined) return early;
    const turn = await budgets.consume(
      `cimd:${source}`,
      source === UNATTRIBUTED ? UNATTRIBUTED_BUDGET : SOURCE_BUDGET,
      1,
      d.now(),
    );
    if (!turn.ok) {
      d.log("client metadata lookups refused: a source exceeded its budget");
      return { failure: "too many client lookups from this address", unavailable: true };
    }
    // The budget answer was awaited: what was true above may not be now.
    const meanwhile = inflight.get(clientId);
    if (meanwhile !== undefined) return meanwhile;
    if (inflight.size >= MAX_INFLIGHT) return busy;
    const late = crowded();
    if (late !== undefined) return late;
    running.set(source, (running.get(source) ?? 0) + 1);
    const p = fetchDocument(clientId).finally(() => {
      inflight.delete(clientId);
      const left = (running.get(source) ?? 1) - 1;
      if (left > 0) running.set(source, left);
      else running.delete(source);
    });
    inflight.set(clientId, p);
    return p;
  }

  return async (clientId, opts) => {
    const fixed = findStaticClient(d.clients, clientId);
    if (fixed !== undefined) return { client: fixed };
    // Anything that is not even shaped like a URL is a registered client or no client at all (an
    // opaque id is never fetched, and a URL is never looked up as a registration).
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(clientId)) {
      const registered = d.dynamicRegistration
        ? loadRegistration(d.db, clientId, d.now())
        : undefined;
      return registered === undefined
        ? { failure: UNKNOWN_CLIENT }
        : {
            client: {
              clientId,
              name: registered.name || UNNAMED_CLIENT,
              redirectUris: registered.redirectUris,
              dcr: true,
              grantTypes: registered.grantTypes,
            },
          };
    }
    return viaMetadata(clientId, opts);
  };
}
