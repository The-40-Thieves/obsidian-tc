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
import { randomBytes } from "node:crypto";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Database } from "../db/types";
import { sha256Hex } from "../provenance/store";
import { FailureLimiter } from "./as-login-limiter";
import { enabledAs } from "./as-metadata";
import {
  claimOperator,
  deleteSession,
  finalizeLogin,
  findOperator,
  normalizeUsername,
  soleOperator,
  tokenBurned,
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
import { mountAsPasskeys } from "./as-passkey-routes";
import {
  constantTimeEqual,
  hashPassword,
  needsRehash,
  PASSWORD_MAX_LENGTH,
  passwordProblem,
  verifyPassword,
} from "./as-password";
import { type AsBrowser, createAsBrowser, requestHandleOf } from "./as-session";

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
  /** The shared browser plumbing (as-session.ts). Default: built from `auth`, `db` and `secret`. */
  browser?: AsBrowser;
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

  const browser =
    deps.browser ??
    createAsBrowser({
      auth: deps.auth,
      db: deps.db,
      secret: deps.secret,
      ...(deps.now ? { now: deps.now } : {}),
    });
  const {
    now,
    db,
    html,
    claimed,
    notClaimed,
    forbidden,
    sessionId: presentedSession,
    sessionOf,
    formToken,
    tokenValid,
    readForm,
    setSession: sessionCookie,
    clearSession,
  } = browser;
  const env = deps.env ?? process.env;
  const clientIp = deps.clientIp ?? socketClientIp;
  const log = deps.log ?? defaultLog;
  const passwords: PasswordHasher = deps.passwords ?? {
    hash: hashPassword,
    verify: verifyPassword,
  };
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
  const fallbackHash = (): Promise<string> =>
    (dummyHash ??= passwords.hash(randomBytes(18).toString("base64url")));

  // Every response under /oauth/ is frame-proof and uncacheable, whichever handler or middleware
  // produced it (a 413 from the body cap, a 404, a redirect).
  app.use("/oauth/*", async (c, next) => {
    for (const [k, v] of Object.entries(AS_RESPONSE_HEADERS)) c.header(k, v);
    await next();
    for (const [k, v] of Object.entries(AS_RESPONSE_HEADERS)) {
      // The consent page widens `form-action` to its own client's redirect (as-authorize.ts), so a
      // policy a handler already set is kept; every other header is forced.
      if (k === "content-security-policy" && c.res.headers.has(k)) continue;
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

  const retryAfter = (c: Context, ms: number) => {
    c.header("retry-after", String(Math.max(1, Math.ceil(ms / 1000))));
    return html(
      c,
      429,
      messagePage("Too many attempts", "Too many failed attempts. Wait a while and try again."),
    );
  };

  // ---- login ---------------------------------------------------------------------------------

  // A pending authorization request rides through login as `request` (its handle, shape-checked so
  // nothing else can be put in the redirect); `reauth=1` asks for a fresh login even if signed in.
  app.get("/oauth/login", (c) => {
    if (!claimed()) return notClaimed(c);
    const request = requestHandleOf(c.req.query("request"));
    const reauth = request !== undefined && c.req.query("reauth") === "1";
    const session = sessionOf(c);
    if (session !== undefined && !reauth) {
      if (request !== undefined) return c.redirect(`/oauth/consent?request=${request}`, 303);
      return html(
        c,
        200,
        signedInPage({ username: session.username, csrf: formToken(c, "logout", session) }),
      );
    }
    return html(
      c,
      200,
      loginPage({
        csrf: formToken(c, "login"),
        passkeyCsrf: formToken(c, "passkey-login"),
        request,
        reauth,
      }),
    );
  });

  app.post("/oauth/login", async (c) => {
    if (!claimed()) return notClaimed(c);
    const form = await readForm(c);
    if (form instanceof Response) return form;
    if (!tokenValid(c, "login", form.get("csrf") ?? "")) return forbidden(c);
    const request = requestHandleOf(form.get("request") ?? undefined);

    const rawName = (form.get("username") ?? "").trim().toLowerCase();
    const password = form.get("password") ?? "";
    const accountKey = `u:${rawName.slice(0, 128)}`;
    const ip = clientIp(c);
    const t = now();
    // Admit the attempt BEFORE any await: it counts against the budget while it verifies, so
    // requests that arrive together cannot all pass a check that only sees settled failures.
    const account = accountLimiter.reserve(accountKey, t);
    const source = account.locked || !ip ? undefined : ipLimiter.reserve(ip, t);
    const lock = account.locked ? account : source?.locked ? source : undefined;
    if (lock?.locked) {
      if (!account.locked) accountLimiter.release(accountKey);
      log(`operator login refused: locked${ip ? ` (${ip})` : ""}`);
      return retryAfter(c, lock.retryAfterMs);
    }
    // Settled in the same tick as the outcome is recorded, never across an await.
    const settle = (): void => {
      accountLimiter.release(accountKey);
      if (ip) ipLimiter.release(ip);
    };
    try {
      if (inflight >= maxHashes) {
        c.header("retry-after", "1");
        return html(c, 503, messagePage("Busy", "The server is busy. Try again in a moment."));
      }

      const presented = presentedSession(c);
      let sessionId: string | undefined;
      inflight++;
      try {
        const name = normalizeUsername(rawName);
        const user = name === undefined ? undefined : findOperator(db, name);
        // The hash verified never depends on whether the name exists: an unknown name is checked
        // against the sole operator's own hash (same parameters, same cost, from the first request
        // on), and only a match on the name lets the result count. The dummy is the fallback for a
        // server with no sole operator, which S4 cannot produce.
        const target = user ?? soleOperator(db);
        const targetHash = target?.passwordHash ?? (await fallbackHash());
        const verified = await passwords.verify(
          password.slice(0, PASSWORD_MAX_LENGTH + 1),
          targetHash,
        );
        if (verified && user !== undefined) {
          const upgradedHash = needsRehash(user.passwordHash)
            ? await passwords.hash(password)
            : undefined;
          // Account state is re-checked in the same transaction that opens the session.
          sessionId = finalizeLogin(db, {
            sub: user.sub,
            verifiedHash: user.passwordHash,
            ...(upgradedHash !== undefined ? { upgradedHash } : {}),
            ...(presented !== undefined ? { replaces: presented } : {}),
            now: now(),
          });
        }
      } finally {
        inflight--;
      }

      if (sessionId === undefined) {
        accountLimiter.fail(accountKey, now());
        if (ip) ipLimiter.fail(ip, now());
        log(`operator login failed${ip ? ` (${ip})` : ""}`);
        return html(
          c,
          401,
          loginPage({
            csrf: formToken(c, "login"),
            passkeyCsrf: formToken(c, "passkey-login"),
            username: rawName.slice(0, 64),
            request,
            error: "Sign-in failed. Check the username and password.",
          }),
        );
      }

      accountLimiter.succeed(accountKey);
      // Rotation: the id is minted here, never adopted from the client, and the presented one is
      // retired in the same transaction.
      sessionCookie(c, sessionId);
      log("operator login ok");
      return c.redirect(
        request !== undefined ? `/oauth/consent?request=${request}` : "/oauth/login",
        303,
      );
    } finally {
      settle();
    }
  });

  // ---- logout --------------------------------------------------------------------------------

  app.post("/oauth/logout", async (c) => {
    const form = await readForm(c);
    if (form instanceof Response) return form;
    const session = sessionOf(c);
    if (session !== undefined) {
      if (!tokenValid(c, "logout", form.get("csrf") ?? "", session)) return forbidden(c);
      const id = presentedSession(c);
      if (id !== undefined) deleteSession(db, id);
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
    const keys = ["setup", ...(ip ? [`ip:${ip}`] : [])];
    const admitted: string[] = [];
    for (const key of keys) {
      const lock = setupLimiter.reserve(key, t);
      if (lock.locked) {
        for (const k of admitted) setupLimiter.release(k);
        return retryAfter(c, lock.retryAfterMs);
      }
      admitted.push(key);
    }
    const supplied = form.get("token") ?? "";
    const suppliedHash = sha256Hex(supplied);
    // Admission, the comparison and the recorded failure share one synchronous stretch (nothing is
    // awaited between them), and the reservation is given back in it.
    let refused = false;
    try {
      // Constant-time, and a token that already claimed the server is refused like a wrong one.
      const right = constantTimeEqual(supplied, expected);
      const burned = tokenBurned(db, sha256Hex(expected));
      refused = !right || burned;
      if (refused) for (const key of keys) setupLimiter.fail(key, now());
    } finally {
      for (const key of admitted) setupLimiter.release(key);
    }
    if (refused) {
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

  // ---- passkeys (design v2 section 4.11), beside the password ---------------------------------
  mountAsPasskeys(app, { browser, log, clientIp });
}
