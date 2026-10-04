// Operator identity routes of the bundled authorization server (design v2 sections 4.3 and 4.5):
// `/oauth/setup` (claim with the one-time setup token), `/oauth/login`, `/oauth/logout`, the
// stylesheet the pages need under their Content-Security-Policy, and the refusal of authorize,
// token and register while the server is unclaimed. It adds NO issuing route and registers nothing
// in AS_ROUTES, so discovery stays off until a slice that issues tokens mounts them.
//
// Every response under /oauth/ carries the frame-proof headers (as-pages.ts). Every state-changing
// form needs three things: a form token bound to the browser (a per-browser nonce cookie before
// sign-in, the session after) and to the form's purpose, an `Origin` equal to the issuer's origin,
// and the urlencoded content type. Success always answers 303 so a browser never re-POSTs
// credentials to the redirect target. Nothing here logs a username, a password, a token, a cookie
// or a query string.
import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Database } from "../db/types";
import { FailureLimiter } from "./as-login-limiter";
import { enabledAs } from "./as-metadata";
import {
  claimOperator,
  createSession,
  deleteSession,
  findOperator,
  isSessionId,
  lookupSession,
  normalizeUsername,
  SESSION_ABSOLUTE_MS,
  type SessionInfo,
  sha256Hex,
  tokenBurned,
  upgradePasswordHash,
} from "./as-operator-store";
import {
  AS_CSS,
  AS_CSS_PATH,
  AS_RESPONSE_HEADERS,
  loginPage,
  messagePage,
  setupPage,
  signedInPage,
} from "./as-pages";
import {
  constantTimeEqual,
  hashPassword,
  needsRehash,
  PASSWORD_MAX_LENGTH,
  passwordProblem,
  verifyPassword,
} from "./as-password";
import { isClaimed } from "./oauth-db";

type AuthConfig = ServerConfig["auth"];

const SETUP_WINDOW_MS = 24 * 3_600_000;
/** A setup token shorter than this is refused outright: it would not survive being guessed. */
const SETUP_TOKEN_MIN_LENGTH = 24;
const FORM_MAX_BYTES = 16 * 1024;
const SETUP_MAX_FAILURES = 10;
const SETUP_WINDOW_FAILURE_MS = 15 * 60_000;
/** Failures one source address may cause across every account, as a multiple of the per-account
 *  budget: enough that a household behind one NAT is not locked out by one typo each. */
const IP_BUDGET_FACTOR = 4;
const DEFAULT_MAX_CONCURRENT_HASHES = 4;
const CSRF_INFO = "obsidian-tc/as-csrf/v1";
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, phc: string): Promise<boolean>;
}

export interface AsOperatorDeps {
  auth: AuthConfig;
  /** oauth.db. */
  db: Database;
  /** The per-server secret (auth/server-secret.ts); the form-token key is derived from it. */
  secret: string;
  now?: () => number;
  /** Where the setup token variable is read from, per request. Default: the process environment. */
  env?: Record<string, string | undefined>;
  /** The client's address. Default: the peer address of the socket, never a forwarded header. */
  clientIp?: (c: Context) => string | undefined;
  log?: (line: string) => void;
  passwords?: PasswordHasher;
  /** Password verifications running at once before login answers 503. */
  maxConcurrentHashes?: number;
}

const LOOPBACK_RE = /^(127\.|::1$|0:0:0:0:0:0:0:1$)/;

/**
 * The address of the TCP peer, or undefined when it is not informative: unknown, or loopback (a
 * reverse proxy or tunnel on the same host, where every client looks like one address). Never reads
 * `X-Forwarded-For`: nothing in the config says which proxies to trust, so a forwarded header is
 * whatever the client wrote.
 */
export function socketClientIp(c: Context): string | undefined {
  const env = c.env as
    | {
        incoming?: { socket?: { remoteAddress?: string } };
        requestIP?: (req: Request) => { address?: string } | null;
      }
    | undefined;
  let addr = env?.incoming?.socket?.remoteAddress;
  if (addr === undefined && typeof env?.requestIP === "function") {
    addr = env.requestIP(c.req.raw)?.address;
  }
  if (!addr) return undefined;
  const bare = addr.replace(/^::ffff:/i, "");
  return LOOPBACK_RE.test(bare) ? undefined : bare;
}

const defaultLog = (line: string): void => {
  process.stderr.write(`[as] ${line}\n`);
};

export function mountAsOperator(app: Hono, deps: AsOperatorDeps): void {
  const as = enabledAs(deps.auth);
  if (as === undefined) return;

  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const clientIp = deps.clientIp ?? socketClientIp;
  const log = deps.log ?? defaultLog;
  const passwords: PasswordHasher = deps.passwords ?? {
    hash: hashPassword,
    verify: verifyPassword,
  };
  const db = deps.db;
  const issuer = new URL(as.issuer);
  const secureCookies = issuer.protocol === "https:";
  const prefix = secureCookies ? ("host" as const) : undefined;
  const SESSION = "otc_as";
  const NONCE = "otc_as_csrf";
  const csrfKey = Buffer.from(hkdfSync("sha256", deps.secret, "", CSRF_INFO, 32));
  const startedAt = now();
  const maxHashes = deps.maxConcurrentHashes ?? DEFAULT_MAX_CONCURRENT_HASHES;
  const accountLimiter = new FailureLimiter({
    maxFailures: as.login.maxFailuresPerWindow,
    windowMs: as.login.windowSeconds * 1000,
  });
  const ipLimiter = new FailureLimiter({
    maxFailures: as.login.maxFailuresPerWindow * IP_BUDGET_FACTOR,
    windowMs: as.login.windowSeconds * 1000,
  });
  const setupLimiter = new FailureLimiter({
    maxFailures: SETUP_MAX_FAILURES,
    windowMs: SETUP_WINDOW_FAILURE_MS,
  });
  let inflight = 0;
  let dummyHash: Promise<string> | undefined;

  const claimed = (): boolean => {
    try {
      return isClaimed(db);
    } catch {
      return false; // an unreadable store is not a claimed one: fail closed
    }
  };
  const html = (c: Context, status: 200 | 400 | 401 | 403 | 404 | 429 | 503, body: string) =>
    c.html(body, status);
  const notClaimed = (c: Context) =>
    html(
      c,
      503,
      messagePage(
        "Not claimed",
        "This authorization server has not been claimed yet. The operator claims it with `obsidian-tc auth as set-password` on the host, or with a setup token.",
      ),
    );

  // Every response under /oauth/ is frame-proof and uncacheable, whichever handler or middleware
  // produced it (a 413 from the body cap, a 404, a redirect).
  app.use("/oauth/*", async (c, next) => {
    for (const [k, v] of Object.entries(AS_RESPONSE_HEADERS)) c.header(k, v);
    await next();
    for (const [k, v] of Object.entries(AS_RESPONSE_HEADERS)) {
      try {
        c.res.headers.set(k, v);
      } catch {
        // an immutable response already carries the headers set above
      }
    }
  });
  app.use(
    "/oauth/*",
    bodyLimit({ maxSize: FORM_MAX_BYTES, onError: (c) => c.text("Payload Too Large", 413) }),
  );

  // Until the operator exists nothing that issues or registers may answer. S5 and later mount their
  // real routes after this guard, so it keeps refusing for them too.
  app.use("/oauth/authorize", async (c, next) => (claimed() ? next() : notClaimed(c)));
  for (const path of ["/oauth/token", "/oauth/register"]) {
    app.use(path, async (c, next) =>
      claimed()
        ? next()
        : c.json(
            {
              error: "temporarily_unavailable",
              error_description: "authorization server not claimed",
            },
            503,
          ),
    );
  }

  app.get(AS_CSS_PATH, (c) => c.body(AS_CSS, 200, { "content-type": "text/css; charset=utf-8" }));

  // ---- form tokens -------------------------------------------------------------------------

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

  const sessionOf = (c: Context): SessionInfo | undefined => {
    const id = getCookie(c, SESSION, prefix);
    if (!isSessionId(id)) return undefined;
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

  const forbidden = (c: Context) =>
    html(
      c,
      403,
      messagePage(
        "Request refused",
        "This request could not be verified. Reload the page and try again.",
      ),
    );

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

  const sessionCookie = (c: Context, id: string): void =>
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

  const retryAfter = (c: Context, ms: number) => {
    c.header("retry-after", String(Math.max(1, Math.ceil(ms / 1000))));
    return html(
      c,
      429,
      messagePage("Too many attempts", "Too many failed attempts. Wait a while and try again."),
    );
  };

  // ---- login ---------------------------------------------------------------------------------

  app.get("/oauth/login", (c) => {
    if (!claimed()) return notClaimed(c);
    const session = sessionOf(c);
    if (session !== undefined) {
      return html(
        c,
        200,
        signedInPage({ username: session.username, csrf: formToken(c, "logout", session) }),
      );
    }
    return html(c, 200, loginPage({ csrf: formToken(c, "login") }));
  });

  app.post("/oauth/login", async (c) => {
    if (!claimed()) return notClaimed(c);
    const form = await readForm(c);
    if (form instanceof Response) return form;
    if (!tokenValid(c, "login", form.get("csrf") ?? "")) return forbidden(c);

    const rawName = (form.get("username") ?? "").trim().toLowerCase();
    const password = form.get("password") ?? "";
    const accountKey = `u:${rawName.slice(0, 128)}`;
    const ip = clientIp(c);
    const t = now();
    for (const lock of [
      accountLimiter.check(accountKey, t),
      ip ? ipLimiter.check(ip, t) : undefined,
    ]) {
      if (lock?.locked) {
        log(`operator login refused: locked${ip ? ` (${ip})` : ""}`);
        return retryAfter(c, lock.retryAfterMs);
      }
    }
    if (inflight >= maxHashes) {
      c.header("retry-after", "1");
      return html(c, 503, messagePage("Busy", "The server is busy. Try again in a moment."));
    }

    inflight++;
    let user: ReturnType<typeof findOperator>;
    let ok = false;
    try {
      const name = normalizeUsername(rawName);
      user = name === undefined ? undefined : findOperator(db, name);
      // An unknown user still pays for one verification, against a hash made under the same
      // parameters, so the response time does not say whether the account exists.
      dummyHash ??= passwords.hash(randomBytes(18).toString("base64url"));
      const verified = await passwords.verify(
        password.slice(0, PASSWORD_MAX_LENGTH + 1),
        user?.passwordHash ?? (await dummyHash),
      );
      ok = verified && user !== undefined;
      if (ok && user !== undefined && needsRehash(user.passwordHash)) {
        upgradePasswordHash(db, user.sub, await passwords.hash(password));
      }
    } finally {
      inflight--;
    }

    if (!ok || user === undefined) {
      accountLimiter.fail(accountKey, now());
      if (ip) ipLimiter.fail(ip, now());
      log(`operator login failed${ip ? ` (${ip})` : ""}`);
      return html(
        c,
        401,
        loginPage({
          csrf: formToken(c, "login"),
          username: rawName.slice(0, 64),
          error: "Sign-in failed. Check the username and password.",
        }),
      );
    }

    accountLimiter.succeed(accountKey);
    // Rotation: a session id is never adopted from the client, and the one presented is retired.
    const presented = getCookie(c, SESSION, prefix);
    if (isSessionId(presented)) deleteSession(db, presented);
    sessionCookie(c, createSession(db, user.sub, now()));
    log("operator login ok");
    return c.redirect("/oauth/login", 303);
  });

  // ---- logout --------------------------------------------------------------------------------

  app.post("/oauth/logout", async (c) => {
    const form = await readForm(c);
    if (form instanceof Response) return form;
    const session = sessionOf(c);
    if (session !== undefined) {
      if (!tokenValid(c, "logout", form.get("csrf") ?? "", session)) return forbidden(c);
      const id = getCookie(c, SESSION, prefix);
      if (isSessionId(id)) deleteSession(db, id);
      log("operator logout");
    }
    clearSession(c);
    return c.redirect("/oauth/login", 303);
  });

  // ---- setup ---------------------------------------------------------------------------------

  /** The configured setup token, or undefined when setup is off (unset, empty or too short). */
  const setupToken = (): string | undefined => {
    const v = env[as.setupTokenEnv];
    return v !== undefined && v.length >= SETUP_TOKEN_MIN_LENGTH ? v : undefined;
  };
  const setupClosed = (c: Context) =>
    html(c, 403, messagePage("Setup closed", "This server cannot be claimed this way now."));
  const setupOpen = (): boolean => now() - startedAt <= SETUP_WINDOW_MS;

  app.get("/oauth/setup", (c) => {
    if (setupToken() === undefined) return html(c, 404, messagePage("Not found", "Not found."));
    if (claimed() || !setupOpen()) return setupClosed(c);
    return html(c, 200, setupPage({ csrf: formToken(c, "setup") }));
  });

  app.post("/oauth/setup", async (c) => {
    const expected = setupToken();
    if (expected === undefined) return html(c, 404, messagePage("Not found", "Not found."));
    const form = await readForm(c);
    if (form instanceof Response) return form;
    if (!tokenValid(c, "setup", form.get("csrf") ?? "")) return forbidden(c);
    if (claimed() || !setupOpen()) return setupClosed(c);

    const ip = clientIp(c);
    const t = now();
    for (const key of ["setup", ...(ip ? [`ip:${ip}`] : [])]) {
      const lock = setupLimiter.check(key, t);
      if (lock.locked) return retryAfter(c, lock.retryAfterMs);
    }
    const supplied = form.get("token") ?? "";
    const suppliedHash = sha256Hex(supplied);
    // Constant-time, and a token that already claimed the server is refused like a wrong one.
    const right = constantTimeEqual(supplied, expected);
    const burned = tokenBurned(db, sha256Hex(expected));
    if (!right || burned) {
      for (const key of ["setup", ...(ip ? [`ip:${ip}`] : [])]) setupLimiter.fail(key, now());
      log(`setup token refused${ip ? ` (${ip})` : ""}`);
      return setupClosed(c);
    }

    const username = normalizeUsername(form.get("username") ?? "");
    const password = form.get("password") ?? "";
    const problem =
      username === undefined
        ? "the username may use letters, digits and . _ @ - (up to 64 characters)"
        : (passwordProblem(password) ??
          (password === (form.get("confirm") ?? "")
            ? undefined
            : "the two passwords do not match"));
    if (problem !== undefined || username === undefined) {
      return html(
        c,
        400,
        setupPage({
          csrf: formToken(c, "setup"),
          username: (form.get("username") ?? "").slice(0, 64),
          error: `Not claimed: ${problem}.`,
        }),
      );
    }

    const result = claimOperator(db, {
      username,
      passwordHash: await passwords.hash(password),
      now: now(),
      setupTokenHash: suppliedHash,
    });
    if (!result.ok) {
      log(`setup claim refused: ${result.reason}`);
      return result.reason === "username_taken"
        ? html(
            c,
            400,
            setupPage({ csrf: formToken(c, "setup"), error: "That username is not available." }),
          )
        : setupClosed(c);
    }
    log("operator claimed through the setup page");
    return c.redirect("/oauth/login", 303);
  });
}
