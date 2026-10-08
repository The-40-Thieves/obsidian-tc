// What the bundled authorization server's browser-facing routes share (design v2 sections 4.3, 4.5):
// the session cookie and its lookup, the form tokens that bind a POST to a browser and a purpose,
// the same-origin form reader, and the "not claimed" refusal. One instance per mount, built from the
// issuer and the per-server secret alone, so the login routes (as-operator.ts) and the authorize and
// consent routes (as-authorize.ts) accept each other's cookies and tokens.
import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Database } from "../db/types";
import { enabledAs } from "./as-metadata";
import {
  isSessionId,
  lookupSession,
  SESSION_ABSOLUTE_MS,
  type SessionInfo,
} from "./as-operator-store";
import { messagePage } from "./as-pages";
import { constantTimeEqual } from "./as-password";
import { isClaimed } from "./oauth-db";

type AuthConfig = ServerConfig["auth"];

const CSRF_INFO = "obsidian-tc/as-csrf/v1";
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const SESSION = "otc_as";
const NONCE = "otc_as_csrf";

const HANDLE_RE = /^[A-Za-z0-9_-]{43}$/;
/** A pending authorization request's handle as it appears in a URL or form, or undefined if it is
 *  not shaped like one (32 random bytes, base64url). */
export const requestHandleOf = (v: string | undefined): string | undefined =>
  v !== undefined && HANDLE_RE.test(v) ? v : undefined;

export type HtmlStatus = 200 | 400 | 401 | 403 | 404 | 429 | 503;

export interface AsBrowserDeps {
  auth: AuthConfig;
  /** oauth.db. */
  db: Database;
  /** The per-server secret (auth/server-secret.ts); the form-token key is derived from it. */
  secret: string;
  now?: () => number;
}

export function createAsBrowser(deps: AsBrowserDeps) {
  const as = enabledAs(deps.auth);
  if (as === undefined) throw new Error("auth.as is not enabled: no browser routes to build");
  const now = deps.now ?? Date.now;
  const db = deps.db;
  const issuer = new URL(as.issuer);
  const secureCookies = issuer.protocol === "https:";
  const prefix = secureCookies ? ("host" as const) : undefined;
  const csrfKey = Buffer.from(hkdfSync("sha256", deps.secret, "", CSRF_INFO, 32));

  const html = (c: Context, status: HtmlStatus, body: string) => c.html(body, status);
  const claimed = (): boolean => {
    try {
      return isClaimed(db);
    } catch {
      return false; // an unreadable store is not a claimed one: fail closed
    }
  };
  const notClaimed = (c: Context) =>
    html(
      c,
      503,
      messagePage(
        "Not claimed",
        "This authorization server has not been claimed yet. The operator claims it with `obsidian-tc auth as set-password` on the host, or with a setup token.",
      ),
    );
  const forbidden = (c: Context) =>
    html(
      c,
      403,
      messagePage(
        "Request refused",
        "This request could not be verified. Reload the page and try again.",
      ),
    );

  const token = (purpose: string, bind: string): string =>
    createHmac("sha256", csrfKey).update(`${purpose}\0${bind}`).digest("base64url");

  /** The browser's pre-sign-in nonce, set as a cookie on first use. */
  const nonceFor = (c: Context, create: boolean): string | undefined => {
    const have = getCookie(c, NONCE, prefix);
    if (have !== undefined && NONCE_RE.test(have)) return have;
    if (!create) return undefined;
    const fresh = randomBytes(16).toString("base64url");
    setCookie(c, NONCE, fresh, {
      prefix,
      httpOnly: true,
      secure: secureCookies,
      sameSite: "Strict",
      path: "/",
      maxAge: 3600,
    });
    return fresh;
  };

  /** The well-formed session id the browser presented, if any (not yet checked against the store). */
  const sessionId = (c: Context): string | undefined => {
    const id = getCookie(c, SESSION, prefix);
    return isSessionId(id) ? id : undefined;
  };
  const sessionOf = (c: Context): SessionInfo | undefined => {
    const id = sessionId(c);
    if (id === undefined) return undefined;
    try {
      return lookupSession(db, id, now());
    } catch {
      return undefined;
    }
  };

  const formToken = (c: Context, purpose: string, session?: SessionInfo): string =>
    session !== undefined
      ? token(purpose, `s:${session.idHash}`)
      : token(purpose, `n:${nonceFor(c, true)}`);

  const tokenValid = (
    c: Context,
    purpose: string,
    supplied: string,
    session?: SessionInfo,
  ): boolean => {
    const nonce = session === undefined ? nonceFor(c, false) : undefined;
    if (session === undefined && nonce === undefined) return false; // no browser binding to check
    const bind = session !== undefined ? `s:${session.idHash}` : `n:${nonce}`;
    return supplied !== "" && constantTimeEqual(token(purpose, bind), supplied);
  };

  /** Content type, then Origin, then the parsed body. A returned Response is the refusal. */
  const readForm = async (c: Context): Promise<URLSearchParams | Response> => {
    const type = c.req.header("content-type") ?? "";
    if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(type)) {
      return c.text("Unsupported Media Type", 415);
    }
    if (c.req.header("origin") !== issuer.origin) return forbidden(c);
    try {
      return new URLSearchParams(await c.req.text());
    } catch {
      return c.text("Payload Too Large", 413);
    }
  };

  const setSession = (c: Context, id: string): void =>
    setCookie(c, SESSION, id, {
      prefix,
      httpOnly: true,
      secure: secureCookies,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_ABSOLUTE_MS / 1000,
    });
  const clearSession = (c: Context): void => {
    deleteCookie(c, SESSION, { prefix, secure: secureCookies, path: "/" });
  };

  return {
    as,
    issuer,
    now,
    db,
    html,
    claimed,
    notClaimed,
    forbidden,
    nonceFor,
    sessionId,
    sessionOf,
    formToken,
    tokenValid,
    readForm,
    setSession,
    clearSession,
  };
}

export type AsBrowser = ReturnType<typeof createAsBrowser>;
