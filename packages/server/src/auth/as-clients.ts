// Who may ask the bundled authorization server for a token, and where its answer may be sent
// (design v2 sections 4.3 and 4.7). Static clients live in `auth.as.clients`,
// so resolution is a lookup in config and nothing here fetches anything (a metadata-document client
// is resolved in as-cimd.ts).
//
// The redirect check is the open-redirect defence: every authorization response goes to a URI that
// matched, exactly, one the operator registered. The single concession is loopback, where a native
// client picks its port at run time (RFC 8252 section 7.3): `http://127.0.0.1`, `http://[::1]` and
// `http://localhost` match with the port ignored and everything else (scheme, host, path, query) exact.
import { createHash, timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import {
  grantsScope,
  isLoopbackHost,
  isQualifiedScope,
  parseScope,
} from "@the-40-thieves/obsidian-tc-shared";

type AuthConfig = ServerConfig["auth"];
type StaticClient = NonNullable<AuthConfig["as"]>["clients"][number];

export interface AsClient {
  clientId: string;
  name: string;
  redirectUris: readonly string[];
  /** Name of the environment variable holding the secret; present only for a confidential client. */
  secretEnv?: string | undefined;
  /** True for a client resolved from a Client ID Metadata Document (its `clientId` is the URL). */
  cimd?: boolean | undefined;
}

export function findStaticClient(
  clients: readonly StaticClient[],
  clientId: string,
): AsClient | undefined {
  return clients.find((c) => c.clientId === clientId);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

function parseHttpLoopback(uri: string): URL | undefined {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return undefined;
  }
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname) && !u.username && !u.password
    ? u
    : undefined;
}

/** Is this an `http` URI to a loopback host (the one place a port may vary)? */
export const isLoopbackUri = (uri: string): boolean => parseHttpLoopback(uri) !== undefined;

/**
 * Does this redirect return to the computer the browser runs on? Any http or https URI whose host is
 * loopback (all of 127.0.0.0/8, `::1`, `localhost`): the question the consent page's warning and
 * remembered consent ask, wider than the three hosts whose port may vary (`isLoopbackUri`).
 */
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return (u.protocol === "http:" || u.protocol === "https:") && isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Does `requested` match one of the client's registered redirect URIs? A loopback URI matches a
 * registered one that differs only in the port; any other URI must be the registered string exactly.
 * No fragment, no credentials: a registered URI cannot contain either (config refuses them), so an
 * exact or loopback match cannot either.
 */
export function redirectUriAllowed(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const want = parseHttpLoopback(requested);
  if (want === undefined || requested.includes("#")) return false;
  return registered.some((r) => {
    const have = parseHttpLoopback(r);
    return (
      have !== undefined &&
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}

/** The identity a grant is remembered under: the redirect URI with a loopback port removed, so a
 *  native client that picks a new port each run is the same client to the operator's consent. */
export function redirectKey(uri: string): string {
  const u = parseHttpLoopback(uri);
  if (u === undefined) return uri;
  u.port = "";
  return u.href;
}

/** RFC 8707 resource comparison: scheme and host case-insensitive (the URL parser lower-cases them),
 *  everything else exact. */
export function sameResource(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant-time comparison of two secrets through their digests (equal length by construction). */
export function secretsEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** The scope tokens in a request, de-duplicated, in order. */
export const splitScope = (raw: string | null | undefined): string[] => [
  ...new Set((raw ?? "").split(/\s+/).filter(Boolean)),
];

export interface ScopeOutcome {
  /** The scopes the server knows and will consider granting. */
  scopes: string[];
  /** The request named scopes (other than `offline_access`) and none were known. */
  unknown: boolean;
}

/**
 * Parse a requested `scope` against the vocabulary: `auth.scopesSupported` when the operator set it
 * (a requested scope must be covered by a listed one), otherwise any fully-qualified scope. Unknown
 * scopes are dropped, not refused (the granted set is echoed in the token response). Nothing
 * requested means the vocabulary's own default, so a client that omits `scope` still gets a flow.
 * `offline_access` is dropped: a refresh token is issued on every code exchange (design v2 section
 * 4.6), so asking for it changes nothing and it never reaches a grant or a token's `scope`.
 */
export function resolveScopes(
  requested: readonly string[],
  supported: readonly string[] | undefined,
): ScopeOutcome {
  const named = requested.filter((s) => s !== "offline_access");
  const vocab = (supported ?? []).filter((s) => s !== "offline_access");
  const known = named.filter((s) =>
    vocab.length > 0 ? grantsScope(vocab, s) : isQualifiedScope(s),
  );
  if (named.length > 0 && known.length === 0) return { scopes: [], unknown: true };
  if (known.length > 0) return { scopes: known, unknown: false };
  return { scopes: vocab.length > 0 ? vocab : ["read:*"], unknown: false };
}

const VERBS: Record<string, string> = {
  read: "Read",
  write: "Create and change",
  delete: "Delete",
  execute: "Run commands on",
  admin: "Administer",
  bulk: "Change in bulk",
};

/** A scope in words for the consent page: `write:notes` is "Create and change notes". */
export function describeScope(scope: string): string {
  const { family, resource } = parseScope(scope);
  const verb = VERBS[family] ?? family;
  return resource === "*" ? `${verb} everything` : `${verb} ${resource}`;
}

/** Is every scope in `wanted` covered by the `granted` set (family and global wildcards honoured)? */
export const scopesCovered = (granted: readonly string[], wanted: readonly string[]): boolean =>
  wanted.every((w) => grantsScope(granted, w));
