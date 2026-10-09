// Dynamic Client Registration, the data half (design v2 sections 4.3, 4.7, 8): what a registration
// request may say, and the `oauth_clients` rows it becomes. Everything in the request is untrusted
// input from a stranger, so only the few fields the flow needs are kept, the server picks the
// client_id (a request that names one, a static client's or a metadata-document URL, gets a fresh
// id of its own), and no secret is ever issued: a registered client is public, bound to PKCE.
// The route that serves it is as-register.ts; the lookup that turns a row back into a client is the
// one resolver in as-cimd.ts.
import { randomBytes } from "node:crypto";
import { inWriteTransaction } from "../db/txn";
import type { Database } from "../db/types";
import { cleanName, usableRedirect } from "./as-cimd-document";

/** The one client-authentication method this server gives a registered client. */
export const DCR_AUTH_METHOD = "none";
const REDIRECTS_MAX = 20;
const GRANTS = new Set(["authorization_code", "refresh_token"]);
/** A registration nobody used for this long is the first thing a full table gives up. */
export const DCR_RECLAIM_MS = 24 * 60 * 60_000;
/** `last_used_at` is refreshed at most this often per client: a sign-in is not a write per request. */
const TOUCH_EVERY_MS = 60 * 60_000;

/** What a registration keeps. */
export interface DcrMetadata {
  name: string;
  redirectUris: string[];
  grantTypes: string[];
}

/** RFC 7591 section 3.2.2 error codes. */
export type DcrError = "invalid_redirect_uri" | "invalid_client_metadata";
export type DcrParse =
  | { ok: true; meta: DcrMetadata }
  | { ok: false; error: DcrError; description: string };

const bad = (error: DcrError, description: string): Extract<DcrParse, { ok: false }> => ({
  ok: false,
  error,
  description,
});
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Is this redirect an http URI to a host that is not loopback (never usable, and not a private-use scheme)? */
function plainHttp(raw: string): boolean {
  try {
    return new URL(raw).protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Validate a registration request body. Redirect URIs follow the authorize rules: https, or http to
 * a loopback host. A private-use scheme (`cursor://...`) is dropped, not fatal, while one usable URI
 * remains; plain http to anywhere else is refused outright. The client-authentication method must be
 * `none` (or absent: a public client), the grants and response types must be ones the server serves,
 * and every other member is ignored: never stored, never fetched.
 */
export function parseRegistration(body: unknown): DcrParse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return bad("invalid_client_metadata", "the registration is not a JSON object");
  }
  const d = body as Record<string, unknown>;

  const uris = d.redirect_uris;
  if (!isStringArray(uris) || uris.length === 0 || uris.length > REDIRECTS_MAX) {
    return bad(
      "invalid_redirect_uri",
      `redirect_uris must be a list of 1 to ${REDIRECTS_MAX} URIs`,
    );
  }
  const redirectUris: string[] = [];
  for (const raw of uris) {
    const kept = usableRedirect(raw);
    if (kept === "refuse") {
      return bad(
        "invalid_redirect_uri",
        "a redirect_uri is not a valid URI without credentials or fragment",
      );
    }
    if (kept === undefined) {
      if (plainHttp(raw)) {
        return bad("invalid_redirect_uri", "an http redirect_uri must be a loopback address");
      }
      continue;
    }
    if (!redirectUris.includes(kept)) redirectUris.push(kept);
  }
  if (redirectUris.length === 0) {
    return bad("invalid_redirect_uri", "none of the redirect_uris is an https or loopback URI");
  }

  const method = d.token_endpoint_auth_method;
  if (method !== undefined && method !== DCR_AUTH_METHOD) {
    return bad(
      "invalid_client_metadata",
      `token_endpoint_auth_method must be "${DCR_AUTH_METHOD}": this server registers public clients only and issues no client secret`,
    );
  }

  let grantTypes = ["authorization_code"];
  if (d.grant_types !== undefined) {
    const g = d.grant_types;
    if (!isStringArray(g) || !g.every((x) => GRANTS.has(x)) || !g.includes("authorization_code")) {
      return bad(
        "invalid_client_metadata",
        "grant_types must be a list of authorization_code and refresh_token that includes authorization_code",
      );
    }
    grantTypes = [...new Set(g)];
  }
  if (d.response_types !== undefined) {
    const r = d.response_types;
    if (!isStringArray(r) || r.length === 0 || !r.every((x) => x === "code")) {
      return bad("invalid_client_metadata", 'response_types must be ["code"]');
    }
  }
  if (d.client_name !== undefined && typeof d.client_name !== "string") {
    return bad("invalid_client_metadata", "client_name must be a string");
  }
  const name = typeof d.client_name === "string" ? cleanName(d.client_name) : "";
  return { ok: true, meta: { name, redirectUris, grantTypes } };
}

/** A fresh client_id: opaque, not shaped like a URL (so the resolver never mistakes it for a metadata document). */
export const newClientId = (): string => `dcr_${randomBytes(18).toString("base64url")}`;

/**
 * Insert a registration unless the table is full. A full table first gives up registrations that were
 * never used within `DCR_RECLAIM_MS` (a flood of throwaway registrations cannot hold the cap for the
 * 90 days housekeeping would otherwise take), and never a used one. The count and the insert are one
 * write transaction, so concurrent registrations cannot pass the cap together.
 */
export function insertRegistration(
  db: Database,
  row: { clientId: string; meta: DcrMetadata; source: string; now: number; maxClients: number },
): "ok" | "full" {
  return inWriteTransaction(db, "as_grants", () => {
    const count = (): number =>
      (
        db.prepare("SELECT COUNT(*) AS n FROM oauth_clients WHERE kind = 'dcr'").get() as {
          n: number;
        }
      ).n;
    if (count() >= row.maxClients) {
      db.prepare(
        "DELETE FROM oauth_clients WHERE kind = 'dcr' AND last_used_at IS NULL AND created_at < ?",
      ).run(row.now - DCR_RECLAIM_MS);
    }
    if (count() >= row.maxClients) return "full";
    db.prepare(
      "INSERT INTO oauth_clients (client_id, kind, metadata_json, created_at, last_used_at, expires_at, created_ip) VALUES (?, 'dcr', ?, ?, NULL, NULL, ?)",
    ).run(
      row.clientId,
      JSON.stringify({ name: row.meta.name, redirectUris: row.meta.redirectUris }),
      row.now,
      row.source,
    );
    return "ok";
  });
}

/** A live registration by its exact client_id: its name and redirect URIs, and the use is noted. */
export function loadRegistration(
  db: Database,
  clientId: string,
  now: number,
): { name: string; redirectUris: string[] } | undefined {
  const row = db
    .prepare(
      "SELECT metadata_json FROM oauth_clients WHERE client_id = ? AND kind = 'dcr' AND (expires_at IS NULL OR expires_at > ?)",
    )
    .get(clientId, now) as { metadata_json: string } | undefined;
  if (row === undefined) return undefined;
  try {
    const m = JSON.parse(row.metadata_json) as { name?: unknown; redirectUris?: unknown };
    if (
      typeof m.name !== "string" ||
      !isStringArray(m.redirectUris) ||
      m.redirectUris.length === 0
    ) {
      return undefined;
    }
    db.prepare(
      "UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ? AND (last_used_at IS NULL OR last_used_at < ?)",
    ).run(now, clientId, now - TOUCH_EVERY_MS);
    return { name: m.name, redirectUris: m.redirectUris };
  } catch {
    return undefined;
  }
}
