// The passkey routes of the bundled authorization server (design v2 section 4.11), mounted by
// `mountAsOperator` beside the password login:
//
//   POST /oauth/passkey/login/options    a challenge for a username-less login (conditional UI)
//   POST /oauth/passkey/login/verify     the assertion; on success the same session cookie a password gives
//   POST /oauth/passkey/register/options (signed in, recently) a challenge to enrol a passkey
//   POST /oauth/passkey/register/verify  the attestation, `none` only; stores the credential
//   GET  /oauth/account                  the operator's passkeys, with `last_used_at`
//   POST /oauth/account/passkeys/remove  take one away (signed in, recently)
//   GET  /oauth/assets/passkey.js        the browser half (as-passkey-asset.ts)
//
// Every JSON POST needs the issuer's `Origin`, a JSON content type and the form token of its purpose
// in `x-csrf-token` (bound to the browser, and to the session when there is one), exactly the three
// things the HTML forms need. Adding or removing a passkey needs a login within `FRESH_LOGIN_MS` (the same freshness a first consent needs).
// A refused ceremony tells the browser only that it was refused; the reason goes to the log with no
// credential, challenge or cookie in it.
import type { Context, Hono } from "hono";
import { MemoryBackend } from "../ratelimit/memory-backend";
import { FRESH_LOGIN_MS } from "./as-grants";
import { FailureLimiter } from "./as-login-limiter";
import { AS_PASSKEY_JS_PATH, accountPage, messagePage } from "./as-pages";
import {
  authenticationOptions,
  challengeOf,
  PasskeyRefused,
  parseAuthenticationBody,
  parseRegistrationBody,
  registrationOptions,
  relyingPartyOf,
  verifyAssertion,
  verifyRegistration,
} from "./as-passkey";
import { AS_PASSKEY_JS } from "./as-passkey-asset";
import {
  addCredential,
  finalizePasskeyLogin,
  findCredential,
  listCredentials,
  removeCredential,
  storeChallenge,
  takeChallenge,
} from "./as-passkey-store";
import { type AsBrowser, requestHandleOf } from "./as-session";

const CSRF_HEADER = "x-csrf-token";
/** Failed passkey logins one source may cause, as a multiple of the per-account password budget. */
const IP_BUDGET_FACTOR = 4;
/**
 * Login challenges one source may ask for: a burst, then a steady rate (a page load asks for one).
 * A peer the server cannot tell apart (loopback proxy or tunnel, unknown address) shares ONE bucket
 * with a larger allowance, so a flood from behind a proxy spends that bucket and nobody else's.
 */
const OPTIONS_PER_SOURCE = { capacity: 20, refillTokens: 20, intervalMs: 60_000 } as const;
const OPTIONS_UNATTRIBUTED = { capacity: 60, refillTokens: 60, intervalMs: 60_000 } as const;

export interface PasskeyDeps {
  browser: AsBrowser;
  log: (line: string) => void;
  clientIp: (c: Context) => string | undefined;
}

export function mountAsPasskeys(app: Hono, deps: PasskeyDeps): void {
  const { browser, log } = deps;
  const { as, issuer, db, now, claimed, notClaimed, html, forbidden } = browser;
  const rp = relyingPartyOf(as.issuer);
  const failureWindowMs = as.login.windowSeconds * 1000;
  const sourceLimiter = new FailureLimiter({
    maxFailures: as.login.maxFailuresPerWindow * IP_BUDGET_FACTOR,
    windowMs: failureWindowMs,
  });
  // Per credential, beside the source: behind a proxy that hides the source, an attacker's failures
  // on other credentials land on no key of the operator's (the password login's per-name budget).
  const credentialLimiter = new FailureLimiter({
    maxFailures: as.login.maxFailuresPerWindow,
    windowMs: failureWindowMs,
  });
  const optionsBuckets = new MemoryBackend();

  const refuse = (c: Context, status: 400 | 401 | 403 | 429 | 503, error: string) =>
    c.json({ error }, status);

  /** The JSON body of a same-origin, token-carrying POST, or the Response that refuses it. */
  const readJson = async (
    c: Context,
    purpose: string,
    session?: ReturnType<AsBrowser["sessionOf"]>,
  ): Promise<Record<string, unknown> | Response> => {
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) {
      return c.text("Unsupported Media Type", 415);
    }
    if (c.req.header("origin") !== issuer.origin) return refuse(c, 403, "forbidden");
    if (!browser.tokenValid(c, purpose, c.req.header(CSRF_HEADER) ?? "", session)) {
      return refuse(c, 403, "forbidden");
    }
    try {
      const body: unknown = await c.req.json();
      return typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : refuse(c, 400, "bad_request");
    } catch {
      return refuse(c, 400, "bad_request");
    }
  };

  const fresh = (createdAt: number): boolean => now() - createdAt <= FRESH_LOGIN_MS;

  app.get(AS_PASSKEY_JS_PATH, (c) =>
    c.body(AS_PASSKEY_JS, 200, { "content-type": "text/javascript; charset=utf-8" }),
  );

  // ---- login ---------------------------------------------------------------------------------

  app.post("/oauth/passkey/login/options", async (c) => {
    if (!claimed()) return refuse(c, 503, "unavailable");
    const body = await readJson(c, "passkey-login");
    if (body instanceof Response) return body;
    const ip = deps.clientIp(c);
    const budget = await optionsBuckets.consume(
      ip === undefined ? "options:-" : `options:ip:${ip}`,
      ip === undefined ? OPTIONS_UNATTRIBUTED : OPTIONS_PER_SOURCE,
      1,
      now(),
    );
    if (!budget.ok) {
      log(`passkey login options refused: rate limited${ip ? ` (${ip})` : ""}`);
      c.header("retry-after", String(Math.max(1, Math.ceil(budget.retryAfterMs / 1000))));
      return refuse(c, 429, "rate_limited");
    }
    const options = await authenticationOptions(rp);
    if (
      !storeChallenge(db, { challenge: options.challenge, purpose: "login", sub: null, now: now() })
    ) {
      c.header("retry-after", "30");
      return refuse(c, 503, "busy");
    }
    return c.json(options);
  });

  /** Challenge, credential, ceremony and session, in that order: a new session id, or a refusal. */
  async function passkeySession(
    c: Context,
    response: NonNullable<ReturnType<typeof parseAuthenticationBody>>,
  ): Promise<string> {
    const challenge = challengeOf(response);
    if (
      challenge === undefined ||
      takeChallenge(db, { challenge, purpose: "login", now: now() }) === undefined
    ) {
      throw new PasskeyRefused("not_verified", "challenge");
    }
    const stored = findCredential(db, response.id);
    if (stored === undefined) throw new PasskeyRefused("not_verified", "unknown credential");
    const result = await verifyAssertion(rp, response, stored, challenge);
    const presented = browser.sessionId(c);
    const id = finalizePasskeyLogin(db, {
      credentialId: stored.credentialId,
      sub: stored.sub,
      newCounter: result.newCounter,
      backedUp: result.backedUp,
      ...(presented !== undefined ? { replaces: presented } : {}),
      now: now(),
    });
    if (id === undefined) throw new PasskeyRefused("cloned_or_replayed", "state moved");
    return id;
  }

  app.post("/oauth/passkey/login/verify", async (c) => {
    if (!claimed()) return refuse(c, 503, "unavailable");
    const body = await readJson(c, "passkey-login");
    if (body instanceof Response) return body;
    const ip = deps.clientIp(c);
    const response = parseAuthenticationBody(body.response);
    // Failures are charged to the source (when it can be told apart) AND to the credential being
    // asserted (when it is one we hold): never to a shared "unknown" bucket, which anyone behind the
    // same proxy could spend to lock the operator out. Without either key the attempt is bounded by
    // what it must hold first: a single-use challenge, which `login/options` budgets per source.
    const stored = response === undefined ? undefined : findCredential(db, response.id);
    const charged: Array<[FailureLimiter, string]> = [
      ...(ip !== undefined ? [[sourceLimiter, ip] as [FailureLimiter, string]] : []),
      ...(stored !== undefined
        ? [[credentialLimiter, stored.credentialId] as [FailureLimiter, string]]
        : []),
    ];
    const held: Array<[FailureLimiter, string]> = [];
    let retryAfterMs = 0;
    for (const [limiter, key] of charged) {
      const lock = limiter.reserve(key, now());
      if (lock.locked) {
        retryAfterMs = lock.retryAfterMs;
        break;
      }
      held.push([limiter, key]);
    }
    const release = () => {
      for (const [limiter, key] of held) limiter.release(key);
    };
    if (held.length < charged.length) {
      release();
      log(`passkey login refused: locked${ip ? ` (${ip})` : ""}`);
      c.header("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      return refuse(c, 429, "rate_limited");
    }
    try {
      const request = requestHandleOf(typeof body.request === "string" ? body.request : undefined);
      let session: string | undefined;
      let why = "malformed";
      if (response !== undefined) {
        try {
          session = await passkeySession(c, response);
        } catch (e) {
          why = e instanceof PasskeyRefused ? e.reason : "error";
        }
      }
      if (session === undefined) {
        for (const [limiter, key] of held) limiter.fail(key, now());
        log(`passkey login failed: ${why}${ip ? ` (${ip})` : ""}`);
        return refuse(c, 401, "refused");
      }
      for (const [limiter, key] of held) limiter.succeed(key);
      browser.setSession(c, session);
      log("operator login ok (passkey)");
      return c.json({
        redirect: request !== undefined ? `/oauth/consent?request=${request}` : "/oauth/login",
      });
    } finally {
      release();
    }
  });

  // ---- enrol ---------------------------------------------------------------------------------

  app.post("/oauth/passkey/register/options", async (c) => {
    const session = browser.sessionOf(c);
    if (session === undefined) return refuse(c, 401, "signed_out");
    const body = await readJson(c, "passkey-register", session);
    if (body instanceof Response) return body;
    if (!fresh(session.createdAt)) return refuse(c, 403, "sign_in_again");
    const options = await registrationOptions(
      rp,
      { sub: session.sub, username: session.username },
      listCredentials(db, session.sub),
    );
    if (
      !storeChallenge(db, {
        challenge: options.challenge,
        purpose: "register",
        sub: session.sub,
        now: now(),
        session,
      })
    ) {
      // Full, or the session ended between the lookup and the write (a reset from another process).
      if (browser.sessionOf(c) === undefined) return refuse(c, 401, "signed_out");
      c.header("retry-after", "30");
      return refuse(c, 503, "busy");
    }
    return c.json(options);
  });

  app.post("/oauth/passkey/register/verify", async (c) => {
    const session = browser.sessionOf(c);
    if (session === undefined) return refuse(c, 401, "signed_out");
    const body = await readJson(c, "passkey-register", session);
    if (body instanceof Response) return body;
    if (!fresh(session.createdAt)) return refuse(c, 403, "sign_in_again");
    const response = parseRegistrationBody(body.response);
    const challenge = response === undefined ? undefined : challengeOf(response);
    const issued =
      challenge === undefined
        ? undefined
        : takeChallenge(db, { challenge, purpose: "register", now: now() });
    if (response === undefined || challenge === undefined || issued?.sub !== session.sub) {
      log("passkey registration failed: challenge");
      return refuse(c, 400, "refused");
    }
    try {
      const credential = await verifyRegistration(rp, response, challenge);
      const added = addCredential(db, {
        ...credential,
        sub: session.sub,
        createdAt: now(),
        session,
      });
      if (!added.ok) throw new PasskeyRefused("not_verified", added.reason);
    } catch (e) {
      log(`passkey registration failed: ${e instanceof PasskeyRefused ? e.reason : "error"}`);
      return refuse(c, 400, "refused");
    }
    log("passkey registered");
    return c.json({ ok: true });
  });

  // ---- account -------------------------------------------------------------------------------

  const accountView = (
    c: Context,
    session: NonNullable<ReturnType<AsBrowser["sessionOf"]>>,
    error?: string,
  ) =>
    accountPage({
      username: session.username,
      registerCsrf: browser.formToken(c, "passkey-register", session),
      removeCsrf: browser.formToken(c, "passkey-remove", session),
      logoutCsrf: browser.formToken(c, "logout", session),
      fresh: fresh(session.createdAt),
      credentials: listCredentials(db, session.sub).map((k) => ({
        id: k.credentialId,
        deviceType: k.deviceType,
        backedUp: k.backedUp,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
      })),
      ...(error !== undefined ? { error } : {}),
    });

  app.get("/oauth/account", (c) => {
    if (!claimed()) return notClaimed(c);
    const session = browser.sessionOf(c);
    if (session === undefined) return c.redirect("/oauth/login", 303);
    return html(c, 200, accountView(c, session));
  });

  app.post("/oauth/account/passkeys/remove", async (c) => {
    const form = await browser.readForm(c);
    if (form instanceof Response) return form;
    const session = browser.sessionOf(c);
    if (session === undefined) return c.redirect("/oauth/login", 303);
    if (!browser.tokenValid(c, "passkey-remove", form.get("csrf") ?? "", session))
      return forbidden(c);
    if (!fresh(session.createdAt)) {
      return html(
        c,
        403,
        messagePage("Sign in again", "Sign out and sign in again before removing a passkey."),
      );
    }
    if (removeCredential(db, session.sub, form.get("credential") ?? "")) log("passkey removed");
    return c.redirect("/oauth/account", 303);
  });
}
