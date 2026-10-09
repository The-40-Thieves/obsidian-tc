// Passkeys beside the password on the operator routes (design v2 section 4.11, slice S10): enrol,
// sign in username-less (the conditional-UI request), the page and script wiring, and every refusal
// the HTTP surface adds on top of the ceremony checks (auth-as-passkey-ceremony.test.ts). The browser
// is played by a software authenticator (webauthn-authenticator.ts) behind the real route mounter.
import { describe, expect, it } from "vitest";
import {
  claimViaSetup,
  get,
  ISSUER,
  Jar,
  login,
  MIN,
  makeOperator,
  type OperatorFixture,
  PASSWORD,
  post,
  sessionCookieName,
  sessionRows,
} from "./as-operator-harness";
import { VirtualAuthenticator } from "./webauthn-authenticator";

const RP_ID = new URL(ISSUER).hostname;
const csrfOfMount = (html: string): string =>
  /id="passkey"[^>]*data-csrf="([^"]+)"/.exec(html)?.[1] ?? "";

interface Json {
  status: number;
  body: Record<string, unknown>;
  res: Response;
}

/** POST JSON the way passkey.js does: same-origin, with the page's form token in `x-csrf-token`. */
async function postJson(
  op: OperatorFixture,
  path: string,
  body: unknown,
  jar: Jar,
  csrf: string,
  extra: { origin?: string | null; contentType?: string; headers?: Record<string, string> } = {},
): Promise<Json> {
  const cookie = jar.header();
  const origin = extra.origin === undefined ? op.issuer : extra.origin;
  const res = await op.app.request(op.url(path), {
    method: "POST",
    headers: {
      "content-type": extra.contentType ?? "application/json",
      ...(origin !== null ? { origin } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf !== "" ? { "x-csrf-token": csrf } : {}),
      ...extra.headers,
    },
    body: JSON.stringify(body),
  });
  jar.apply(res);
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON: the status carries the refusal
  }
  return { status: res.status, body: parsed, res };
}

async function claimed(opts: Parameters<typeof makeOperator>[0] = {}) {
  const op = await makeOperator(opts);
  await claimViaSetup(op);
  return op;
}

/** Sign in with the password and enrol `auth` through the account page, as a browser would. */
async function enrolled(op: OperatorFixture, auth = new VirtualAuthenticator(ISSUER, RP_ID)) {
  const jar = new Jar();
  await login(op, jar);
  const page = await get(op, "/oauth/account", jar);
  const csrf = csrfOfMount(page.text);
  const opts = await postJson(op, "/oauth/passkey/register/options", {}, jar, csrf);
  expect(opts.status).toBe(200);
  const done = await postJson(
    op,
    "/oauth/passkey/register/verify",
    { response: auth.register(opts.body as never) },
    jar,
    csrf,
  );
  expect(done.status).toBe(200);
  return { auth, jar };
}

/** The sign-in a browser performs on the login page. */
async function passkeyLogin(
  op: OperatorFixture,
  auth: VirtualAuthenticator,
  jar = new Jar(),
  knobs: Parameters<VirtualAuthenticator["assert"]>[1] = {},
  request?: string,
  loginPath = "/oauth/login",
): Promise<Json> {
  const page = await get(op, loginPath, jar);
  const csrf = csrfOfMount(page.text);
  const opts = await postJson(op, "/oauth/passkey/login/options", {}, jar, csrf);
  expect(opts.status).toBe(200);
  return postJson(
    op,
    "/oauth/passkey/login/verify",
    { response: auth.assert(opts.body as never, knobs), ...(request ? { request } : {}) },
    jar,
    csrf,
  );
}

const credentialRows = (op: OperatorFixture) =>
  op.db
    .prepare("SELECT credential_id, sign_count, last_used_at FROM webauthn_credentials")
    .all() as Array<{
    credential_id: string;
    sign_count: number;
    last_used_at: number | null;
  }>;

describe("page and script wiring (conditional UI)", () => {
  it("the login page offers the passkey through the username field's autofill and loads only its own script", async () => {
    const op = await claimed();
    const page = await get(op, "/oauth/login");
    expect(page.text).toContain('autocomplete="username webauthn"');
    expect(page.text).toContain('data-mode="login"');
    expect(page.text).toContain('id="passkey-button"');
    const scripts = [...page.text.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual(['<script src="/oauth/assets/passkey.js" defer>']);
    expect(page.text).not.toMatch(/<script[^>]*>[^<]+<\/script>/); // no inline script
    expect(page.text).not.toMatch(/https?:\/\/(?!vault\.example\.com)/);
    const csp = page.res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/unsafe-|https?:/);
  });

  it("serves the script from the server itself, with no CDN and no network target but its own routes", async () => {
    const op = await claimed();
    const res = await get(op, "/oauth/assets/passkey.js");
    expect(res.res.status).toBe(200);
    expect(res.res.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(res.res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.text).toContain('mediation: conditional ? "conditional" : "optional"');
    expect(res.text).toContain("isConditionalMediationAvailable");
    expect(res.text).toContain("parseRequestOptionsFromJSON");
    expect(res.text).not.toMatch(/https?:\/\//);
    const targets = [...res.text.matchAll(/post\("(\/[^"]+)"/g)].map((m) => m[1]);
    expect(targets.sort()).toEqual([
      "/oauth/passkey/login/options",
      "/oauth/passkey/login/verify",
      "/oauth/passkey/register/options",
      "/oauth/passkey/register/verify",
    ]);
  });

  it("the account page needs a session, and offers enrolment only to a recent sign-in", async () => {
    const op = await claimed();
    const anon = await get(op, "/oauth/account");
    expect(anon.res.status).toBe(303);
    expect(anon.res.headers.get("location")).toBe("/oauth/login");
    const jar = new Jar();
    await login(op, jar);
    const page = await get(op, "/oauth/account", jar);
    expect(page.res.status).toBe(200);
    expect(page.text).toContain('data-mode="enroll"');
    expect(page.text).toContain("No passkeys yet");
    op.clock.t += 6 * MIN;
    const stale = await get(op, "/oauth/account", jar);
    expect(stale.text).not.toContain('data-mode="enroll"');
    expect(stale.text).toContain("sign in again");
  });
});

describe("enrol and sign in", () => {
  it("enrols a passkey from a signed-in session and lists it on the account page", async () => {
    const op = await claimed();
    const { auth, jar } = await enrolled(op);
    expect(credentialRows(op).map((r) => r.credential_id)).toEqual([auth.id]);
    const page = await get(op, "/oauth/account", jar);
    expect(page.text).toContain(auth.id.slice(0, 12));
    expect(page.text).toContain("never used");
    expect(op.logs).toContain("passkey registered");
  });

  it("signs in username-less with the passkey: the conditional-UI request names no credential and no user", async () => {
    const op = await claimed();
    const { auth } = await enrolled(op);
    const jar = new Jar();
    const page = await get(op, "/oauth/login", jar);
    const csrf = csrfOfMount(page.text);
    const opts = await postJson(op, "/oauth/passkey/login/options", {}, jar, csrf);
    expect(opts.status).toBe(200);
    expect(opts.body.allowCredentials ?? []).toEqual([]);
    expect(opts.body.userVerification).toBe("required");
    expect(opts.body.rpId).toBe(RP_ID);
    const done = await postJson(
      op,
      "/oauth/passkey/login/verify",
      { response: auth.assert(opts.body as never) },
      jar,
      csrf,
    );
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ redirect: "/oauth/login" });
    expect(sessionCookieName(jar)).toBeDefined();
    const signedIn = await get(op, "/oauth/login", jar);
    expect(signedIn.text).toContain("Signed in as");
    expect(credentialRows(op)[0]).toMatchObject({ sign_count: 1, last_used_at: op.clock.t });
  });

  it("continues a pending authorization request into consent, and ignores a request that is not a handle", async () => {
    const op = await claimed();
    const { auth } = await enrolled(op);
    const handle = "A".repeat(43);
    const ok = await passkeyLogin(op, auth, new Jar(), {}, handle);
    expect(ok.body).toEqual({ redirect: `/oauth/consent?request=${handle}` });
    const odd = await passkeyLogin(op, auth, new Jar(), {}, "../../evil");
    expect(odd.body).toEqual({ redirect: "/oauth/login" });
  });

  it("rotates the session: the presented one is retired when a passkey login lands", async () => {
    const op = await claimed();
    const { auth, jar } = await enrolled(op);
    expect(sessionRows(op)).toHaveLength(1);
    const before = sessionRows(op)[0]?.id_hash;
    // A signed-in browser sees the login form again when consent asks for a fresh sign-in (reauth).
    const handle = "B".repeat(43);
    const again = await passkeyLogin(
      op,
      auth,
      jar,
      {},
      handle,
      `/oauth/login?request=${handle}&reauth=1`,
    );
    expect(again.status).toBe(200);
    const after = sessionRows(op);
    expect(after).toHaveLength(1);
    expect(after[0]?.id_hash).not.toBe(before);
  });

  it("password login still works beside an enrolled passkey", async () => {
    const op = await claimed();
    await enrolled(op);
    const jar = new Jar();
    const r = await login(op, jar);
    expect(r.res.status).toBe(303);
    expect(sessionCookieName(jar)).toBeDefined();
    const bad = await login(op, new Jar(), {
      username: "operator",
      password: "wrong password here",
    });
    expect(bad.res.status).toBe(401);
    expect(PASSWORD.length).toBeGreaterThan(11);
  });

  it("a synced passkey (constant zero counter) signs in repeatedly", async () => {
    const op = await claimed();
    const { auth } = await enrolled(op);
    auth.counter = "constant-zero";
    expect((await passkeyLogin(op, auth)).status).toBe(200);
    expect((await passkeyLogin(op, auth)).status).toBe(200);
    expect(credentialRows(op)[0]?.sign_count).toBe(0);
  });
});

describe("refusals", () => {
  it("RED: a non-none attestation format is refused at registration over HTTP, and nothing is stored", async () => {
    const op = await claimed();
    const jar = new Jar();
    await login(op, jar);
    const csrf = csrfOfMount((await get(op, "/oauth/account", jar)).text);
    const opts = await postJson(op, "/oauth/passkey/register/options", {}, jar, csrf);
    const auth = new VirtualAuthenticator(ISSUER, RP_ID);
    const r = await postJson(
      op,
      "/oauth/passkey/register/verify",
      { response: auth.register(opts.body as never, { fmt: "packed" }) },
      jar,
      csrf,
    );
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "refused" });
    expect(credentialRows(op)).toEqual([]);
    expect(op.logs).toContain("passkey registration failed: attestation_format");
  });

  it("RED: a cloned authenticator (stored counter non-zero, new one not greater) is refused and gets no session", async () => {
    const op = await claimed();
    const { auth } = await enrolled(op);
    auth.counter = 9;
    expect((await passkeyLogin(op, auth)).status).toBe(200); // stored = 10
    for (const seen of [3, 9]) {
      auth.counter = seen; // reports 4, then 10: both <= 10
      const jar = new Jar();
      const r = await passkeyLogin(op, auth, jar);
      expect(r.status).toBe(401);
      expect(sessionCookieName(jar)).toBeUndefined();
    }
    expect(credentialRows(op)[0]?.sign_count).toBe(10);
    expect(op.logs.some((l) => l.startsWith("passkey login failed: cloned_or_replayed"))).toBe(
      true,
    );
  });

  it("RED: a credential registered for another rpID fails authentication", async () => {
    const op = await claimed();
    const { auth } = await enrolled(op);
    const jar = new Jar();
    const r = await passkeyLogin(op, auth, jar, { rpID: "evil.example" });
    expect(r.status).toBe(401);
    expect(sessionCookieName(jar)).toBeUndefined();
  });

  it("an authenticator for another rpID cannot enrol", async () => {
    const op = await claimed();
    const jar = new Jar();
    await login(op, jar);
    const csrf = csrfOfMount((await get(op, "/oauth/account", jar)).text);
    const opts = await postJson(op, "/oauth/passkey/register/options", {}, jar, csrf);
    const r = await postJson(
      op,
      "/oauth/passkey/register/verify",
      {
        response: new VirtualAuthenticator(ISSUER, RP_ID).register(opts.body as never, {
          rpID: "evil.example",
        }),
      },
      jar,
      csrf,
    );
    expect(r.status).toBe(400);
    expect(credentialRows(op)).toEqual([]);
  });

  it("an assertion answers its challenge once", async () => {
    const op = await claimed();
    const { auth } = await enrolled(op);
    const jar = new Jar();
    const csrf = csrfOfMount((await get(op, "/oauth/login", jar)).text);
    const opts = await postJson(op, "/oauth/passkey/login/options", {}, jar, csrf);
    const answer = { response: auth.assert(opts.body as never) };
    expect((await postJson(op, "/oauth/passkey/login/verify", answer, jar, csrf)).status).toBe(200);
    expect((await postJson(op, "/oauth/passkey/login/verify", answer, jar, csrf)).status).toBe(401);
  });

  it("an assertion for a challenge the server never issued, or after it expired, is refused", async () => {
    const op = await claimed();
    const { auth } = await enrolled(op);
    const jar = new Jar();
    const csrf = csrfOfMount((await get(op, "/oauth/login", jar)).text);
    const forged = { challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
    expect(
      (
        await postJson(
          op,
          "/oauth/passkey/login/verify",
          { response: auth.assert(forged) },
          jar,
          csrf,
        )
      ).status,
    ).toBe(401);
    const opts = await postJson(op, "/oauth/passkey/login/options", {}, jar, csrf);
    op.clock.t += 6 * MIN;
    expect(
      (
        await postJson(
          op,
          "/oauth/passkey/login/verify",
          { response: auth.assert(opts.body as never) },
          jar,
          csrf,
        )
      ).status,
    ).toBe(401);
  });

  it("a passkey of an account disabled mid-ceremony does not sign in", async () => {
    const op = await claimed();
    const { auth } = await enrolled(op);
    const jar = new Jar();
    const csrf = csrfOfMount((await get(op, "/oauth/login", jar)).text);
    const opts = await postJson(op, "/oauth/passkey/login/options", {}, jar, csrf);
    op.db.prepare("UPDATE users SET disabled_at = ?").run(op.clock.t);
    const r = await postJson(
      op,
      "/oauth/passkey/login/verify",
      { response: auth.assert(opts.body as never) },
      jar,
      csrf,
    );
    expect(r.status).toBe(503); // a server with no enabled operator is unclaimed: nothing signs in
    expect(sessionRows(op)).toHaveLength(1); // only the enrolment session; no new one
  });

  it("an unknown credential and a garbage body are refused alike", async () => {
    const op = await claimed();
    await enrolled(op);
    const stranger = new VirtualAuthenticator(ISSUER, RP_ID);
    expect((await passkeyLogin(op, stranger, new Jar(), { userHandle: null })).status).toBe(401);
    const jar = new Jar();
    const csrf = csrfOfMount((await get(op, "/oauth/login", jar)).text);
    expect(
      (await postJson(op, "/oauth/passkey/login/verify", { response: { id: 1 } }, jar, csrf))
        .status,
    ).toBe(401);
    expect((await postJson(op, "/oauth/passkey/login/verify", [], jar, csrf)).status).toBe(400);
  });

  it("the JSON endpoints need the issuer's Origin, a JSON body and the form token of their purpose", async () => {
    const op = await claimed();
    const jar = new Jar();
    const csrf = csrfOfMount((await get(op, "/oauth/login", jar)).text);
    const path = "/oauth/passkey/login/options";
    expect((await postJson(op, path, {}, jar, csrf)).status).toBe(200);
    expect(
      (await postJson(op, path, {}, jar, csrf, { origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await postJson(op, path, {}, jar, csrf, { origin: null })).status).toBe(403);
    expect((await postJson(op, path, {}, jar, "")).status).toBe(403);
    expect((await postJson(op, path, {}, jar, "x".repeat(43))).status).toBe(403);
    expect(
      (
        await postJson(op, path, {}, jar, csrf, {
          contentType: "application/x-www-form-urlencoded",
        })
      ).status,
    ).toBe(415);
    // a token of another purpose does not do, and neither does one from another browser
    const loginToken = (await get(op, "/oauth/login", new Jar())).csrf;
    expect((await postJson(op, path, {}, jar, loginToken)).status).toBe(403);
    expect((await postJson(op, path, {}, new Jar(), csrf)).status).toBe(403);
  });

  it("refuses everything while the server is unclaimed", async () => {
    const op = await makeOperator();
    const jar = new Jar();
    const csrf = csrfOfMount((await get(op, "/oauth/login", jar)).text);
    expect(csrf).toBe(""); // the unclaimed page carries no passkey mount
    expect((await postJson(op, "/oauth/passkey/login/options", {}, jar, "x")).status).toBe(503);
    expect((await get(op, "/oauth/account")).res.status).toBe(503);
  });

  it("slows a source that keeps failing", async () => {
    const op = await claimed({ as: { login: { maxFailuresPerWindow: 1, windowSeconds: 900 } } });
    const jar = new Jar();
    const csrf = csrfOfMount((await get(op, "/oauth/login", jar)).text);
    const attempt = () =>
      postJson(op, "/oauth/passkey/login/verify", { response: { id: 1 } }, jar, csrf, {
        headers: { "x-test-ip": "203.0.113.9" },
      });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await attempt()).status);
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses.at(-1)).toBe(429);
  });

  it("the log names no credential, challenge or cookie", async () => {
    const op = await claimed();
    const { auth } = await enrolled(op);
    auth.counter = 9;
    await passkeyLogin(op, auth);
    auth.counter = 1;
    await passkeyLogin(op, auth);
    const text = op.logs.join("\n");
    expect(text).not.toContain(auth.id);
    expect(text).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });
});

describe("account management", () => {
  it("enrolment and removal need a signed-in, recent session", async () => {
    const op = await claimed();
    const anon = new Jar();
    const csrf = csrfOfMount((await get(op, "/oauth/login", anon)).text);
    expect((await postJson(op, "/oauth/passkey/register/options", {}, anon, csrf)).status).toBe(
      401,
    );

    const jar = new Jar();
    await login(op, jar);
    const page = await get(op, "/oauth/account", jar);
    const token = csrfOfMount(page.text);
    op.clock.t += 6 * MIN;
    const stale = await postJson(op, "/oauth/passkey/register/options", {}, jar, token);
    expect(stale.status).toBe(403);
    expect(stale.body).toEqual({ error: "sign_in_again" });
  });

  it("removes a passkey from the account page; the password still signs in", async () => {
    const op = await claimed();
    const { auth, jar } = await enrolled(op);
    const page = await get(op, "/oauth/account", jar);
    const removeCsrf =
      /action="\/oauth\/account\/passkeys\/remove">\s*<input type="hidden" name="csrf" value="([^"]+)"/.exec(
        page.text,
      )?.[1] ?? "";
    expect(
      (await post(op, "/oauth/account/passkeys/remove", { csrf: "x", credential: auth.id }, jar))
        .res.status,
    ).toBe(403);
    expect(credentialRows(op)).toHaveLength(1);
    const gone = await post(
      op,
      "/oauth/account/passkeys/remove",
      { csrf: removeCsrf, credential: auth.id },
      jar,
    );
    expect(gone.res.status).toBe(303);
    expect(credentialRows(op)).toEqual([]);
    expect((await passkeyLogin(op, auth)).status).toBe(401);
    expect((await login(op, new Jar())).res.status).toBe(303);
  });

  it("removal needs a recent sign-in", async () => {
    const op = await claimed();
    const { auth, jar } = await enrolled(op);
    const page = await get(op, "/oauth/account", jar);
    const removeCsrf =
      /action="\/oauth\/account\/passkeys\/remove">\s*<input type="hidden" name="csrf" value="([^"]+)"/.exec(
        page.text,
      )?.[1] ?? "";
    op.clock.t += 6 * MIN;
    const r = await post(
      op,
      "/oauth/account/passkeys/remove",
      { csrf: removeCsrf, credential: auth.id },
      jar,
    );
    expect(r.res.status).toBe(403);
    expect(credentialRows(op)).toHaveLength(1);
  });

  it("the same credential cannot be enrolled twice", async () => {
    const op = await claimed();
    const { auth, jar } = await enrolled(op);
    const csrf = csrfOfMount((await get(op, "/oauth/account", jar)).text);
    const opts = await postJson(op, "/oauth/passkey/register/options", {}, jar, csrf);
    expect((opts.body.excludeCredentials as unknown[]).length).toBe(1);
    const r = await postJson(
      op,
      "/oauth/passkey/register/verify",
      { response: auth.register(opts.body as never) },
      jar,
      csrf,
    );
    expect(r.status).toBe(400);
    expect(credentialRows(op)).toHaveLength(1);
  });

  it("a login challenge cannot be redeemed as a registration", async () => {
    const op = await claimed();
    const jar = new Jar();
    const csrfLogin = csrfOfMount((await get(op, "/oauth/login", jar)).text);
    const loginOpts = await postJson(op, "/oauth/passkey/login/options", {}, jar, csrfLogin);
    await login(op, jar);
    const csrf = csrfOfMount((await get(op, "/oauth/account", jar)).text);
    const creation = { challenge: String(loginOpts.body.challenge), rp: {}, user: { id: "AAAA" } };
    const auth = new VirtualAuthenticator(ISSUER, RP_ID);
    const r = await postJson(
      op,
      "/oauth/passkey/register/verify",
      { response: auth.register(creation) },
      jar,
      csrf,
    );
    expect(r.status).toBe(400);
    expect(credentialRows(op)).toEqual([]);
  });
});
