// The no-shell operator credential reset (design v2 section 4.11.5, item 3): `/oauth/setup` switches
// to reset mode for the sole operator when `auth.as.resetTokenEnv` names a set variable of at least
// 24 characters, the server is claimed, and the request is inside the boot window. The token is
// compared in constant time, burned in the same transaction as the reset, and announced at boot.
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordIssuedAccess } from "../src/auth/oauth-db";
import {
  claimViaSetup,
  get,
  Jar,
  login,
  makeOperator,
  type OperatorFixture,
  PASSWORD,
  post,
  SETUP_TOKEN,
  sessionRows,
  sha256,
  submit,
  T0,
  userRows,
} from "./as-operator-harness";

const RESET_TOKEN = "reset-token-0123456789-abcdefghijk";
const NEW_PASSWORD = "a different passphrase, long enough";
const DAY = 24 * 3_600_000;
const ENV = { OBSIDIAN_TC_AS_RESET_TOKEN: RESET_TOKEN };

afterEach(() => vi.restoreAllMocks());

/** A registry double: `health` is what the reset checks, `revoke` and `recordToken` what it reaches. */
function fakeRegistry(
  health: { state: "ok" | "lost"; detail: string } = { state: "ok", detail: "" },
) {
  return {
    health: () => health,
    revoke: vi.fn((_jti: string, _reason: string) => undefined),
    recordToken: vi.fn((_t: unknown) => undefined),
  };
}

/** A claimed server with the reset variable set, and the operator logged in on `session`. */
async function claimedWithReset(
  opts: Parameters<typeof makeOperator>[0] = {},
): Promise<{ op: OperatorFixture; session: Jar }> {
  const op = await makeOperator({ ...opts, env: { ...ENV, ...opts.env } });
  await claimViaSetup(op);
  const session = new Jar();
  const r = await login(op, session);
  if (r.res.status !== 303) throw new Error(`login failed: ${r.res.status}`);
  return { op, session };
}

/** Submit the reset page: loads it (for its CSRF token) and posts with the reset token by default. */
const resetPost = (
  op: OperatorFixture,
  fields: Record<string, string> = {},
  extra: Parameters<typeof post>[4] = {},
) =>
  submit(
    op,
    "/oauth/setup",
    { token: RESET_TOKEN, password: NEW_PASSWORD, confirm: NEW_PASSWORD, ...fields },
    new Jar(),
    extra,
  );

const passwordHashOf = (op: OperatorFixture): string | undefined => userRows(op)[0]?.password_hash;
const isResetPage = (text: string): boolean => /name="revoke"/.test(text);

/** A live grant with one refresh family and one issued access token (jti-1), as the AS writes them. */
function seedGrant(op: OperatorFixture, registry: ReturnType<typeof fakeRegistry>): void {
  const sub = userRows(op)[0]?.sub ?? "";
  const now = T0;
  op.db
    .prepare(
      `INSERT INTO grants (id, sub, client_id, redirect_uri, scope, resource, created_at)
       VALUES ('grant-1', ?, 'agent', 'http://127.0.0.1/cb', 'read:notes', 'https://vault.example.com/mcp', ?)`,
    )
    .run(sub, now);
  op.db
    .prepare(
      `INSERT INTO refresh_tokens (token_hash, family_id, grant_id, scope, issued_at, family_expires_at)
       VALUES ('h1', 'fam-1', 'grant-1', 'read:notes', ?, ?)`,
    )
    .run(now, now + DAY);
  recordIssuedAccess(op.db, registry as never, {
    jti: "jti-1",
    kid: "k1",
    sub,
    scope: "read:notes",
    familyId: "fam-1",
    grantId: "grant-1",
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 1800,
  });
}

describe("reset mode is off unless every condition holds", () => {
  it("with the variable unset, a claimed server answers as before (403 closed, 404 with no setup token)", async () => {
    const op = await makeOperator({ env: { OBSIDIAN_TC_AS_RESET_TOKEN: undefined } });
    await claimViaSetup(op);
    expect((await get(op, "/oauth/setup")).res.status).toBe(403);
    expect((await resetPost(op)).res.status).toBe(403);

    const bare = await makeOperator({
      env: { OBSIDIAN_TC_AS_RESET_TOKEN: undefined, OBSIDIAN_TC_AS_SETUP_TOKEN: undefined },
    });
    await claimViaSetup(bare).catch(() => undefined);
    expect((await get(bare, "/oauth/setup")).res.status).toBe(404);
  });

  it("a token shorter than 24 characters leaves reset mode off", async () => {
    const op = await makeOperator({ env: { OBSIDIAN_TC_AS_RESET_TOKEN: "too-short" } });
    await claimViaSetup(op);
    const r = await get(op, "/oauth/setup");
    expect(r.res.status).toBe(403);
    expect(isResetPage(r.text)).toBe(false);
  });

  it("outside the boot window reset mode is closed", async () => {
    const { op } = await claimedWithReset();
    op.clock.t = T0 + DAY + 1;
    const r = await get(op, "/oauth/setup");
    expect(r.res.status).toBe(403);
    expect(isResetPage(r.text)).toBe(false);
    expect((await resetPost(op)).res.status).toBe(403);
  });

  it("on an unclaimed server the reset token is ignored and setup works as before", async () => {
    const op = await makeOperator({ env: ENV });
    const page = await get(op, "/oauth/setup");
    expect(page.res.status).toBe(200);
    expect(isResetPage(page.text)).toBe(false);
    expect(page.text).toContain('name="token"');
    const refused = await submit(op, "/oauth/setup", {
      token: RESET_TOKEN,
      username: "operator",
      password: PASSWORD,
      confirm: PASSWORD,
    });
    expect(refused.res.status).toBe(403);
    const claimed = await submit(op, "/oauth/setup", {
      token: SETUP_TOKEN,
      username: "operator",
      password: PASSWORD,
      confirm: PASSWORD,
    });
    expect(claimed.res.status).toBe(303);
  });
});

describe("the reset page", () => {
  it("renders the reset form with an unchecked revoke box", async () => {
    const { op } = await claimedWithReset();
    const page = await get(op, "/oauth/setup");
    expect(page.res.status).toBe(200);
    expect(isResetPage(page.text)).toBe(true);
    expect(page.text).not.toMatch(/name="revoke"[^>]*checked/);
  });

  it("requires the CSRF token: a POST without it changes nothing", async () => {
    const { op } = await claimedWithReset();
    const before = passwordHashOf(op);
    const bare = await post(op, "/oauth/setup", {
      token: RESET_TOKEN,
      password: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(bare.res.status).toBe(403);
    expect(passwordHashOf(op)).toBe(before);
  });

  it("names the CLI when the server has no single operator", async () => {
    const { op } = await claimedWithReset();
    op.db
      .prepare(
        "INSERT INTO users (sub, username, password_hash, created_at) VALUES ('usr_second', 'second', 'x', ?)",
      )
      .run(T0);
    const r = await get(op, "/oauth/setup");
    expect(r.text).toMatch(/--user/);
    expect(isResetPage(r.text)).toBe(false);
  });
});

describe("the token", () => {
  it("a wrong token is refused like setup and counts against the limiter", async () => {
    const { op } = await claimedWithReset();
    const headers = { "x-test-ip": "10.0.0.9" };
    for (let i = 0; i < 10; i++) {
      const r = await resetPost(op, { token: "wrong-token-0123456789-abcdefgh" }, { headers });
      expect(r.res.status).toBe(403);
      expect(r.text).toContain("Setup closed");
    }
    // Locked out now, even with the right token.
    const locked = await resetPost(op, {}, { headers });
    expect(locked.res.status).toBe(429);
    expect(locked.res.headers.get("retry-after")).not.toBeNull();
  });

  it("a correct reset sets the new password, ends sessions and deletes passkeys", async () => {
    const { op, session } = await claimedWithReset();
    op.db
      .prepare(
        `INSERT INTO webauthn_credentials (credential_id, sub, public_key, device_type, created_at)
         VALUES ('cred-1', (SELECT sub FROM users), 'pk', 'singleDevice', ?)`,
      )
      .run(T0);
    expect(sessionRows(op)).toHaveLength(1);

    const done = await resetPost(op);
    expect(done.res.status).toBe(303);
    expect(done.res.headers.get("location")).toBe("/oauth/login");

    expect(sessionRows(op)).toHaveLength(0);
    expect(op.db.prepare("SELECT COUNT(*) AS n FROM webauthn_credentials").get()).toEqual({ n: 0 });
    // The old session no longer reaches the account page.
    expect((await get(op, "/oauth/account", session)).res.status).not.toBe(200);

    expect((await login(op, new Jar())).res.status).toBe(401);
    const fresh = await login(op, new Jar(), { username: "operator", password: NEW_PASSWORD });
    expect(fresh.res.status).toBe(303);
  });

  it("is single-use, including after a restart on the same database", async () => {
    const { op } = await claimedWithReset();
    expect((await resetPost(op)).res.status).toBe(303);
    expect((await resetPost(op, { password: "yet another long passphrase" })).res.status).toBe(403);
    const restarted = await makeOperator({ db: op.db, env: ENV });
    expect(
      (await resetPost(restarted, { password: "yet another long passphrase" })).res.status,
    ).toBe(403);
    expect(op.db.prepare("SELECT token_hash FROM burned_reset_tokens").all()).toEqual([
      { token_hash: sha256(RESET_TOKEN) },
    ]);
  });

  it("a bad password does not burn the token", async () => {
    const { op } = await claimedWithReset();
    const bad = await resetPost(op, { confirm: "does not match at all, long" });
    expect(bad.res.status).toBe(400);
    expect((await resetPost(op)).res.status).toBe(303);
  });
});

describe("revoking grants", () => {
  it("with the box ticked every grant is revoked and its access-token jti reaches the registry", async () => {
    const registry = fakeRegistry();
    const { op } = await claimedWithReset({ registry: registry as never });
    seedGrant(op, registry);
    const done = await resetPost(op, { revoke: "on" });
    expect(done.res.status).toBe(303);
    expect(registry.revoke).toHaveBeenCalledWith("jti-1", expect.any(String));
    expect(op.db.prepare("SELECT revoked_at FROM grants WHERE id = 'grant-1'").get()).toEqual({
      revoked_at: expect.any(Number),
    });
  });

  it("with the registry lost the reset is refused and nothing changes", async () => {
    const registry = fakeRegistry({ state: "lost", detail: "auth.db is gone" });
    const { op, session } = await claimedWithReset({ registry: registry as never });
    seedGrant(op, registry);
    const before = passwordHashOf(op);
    const r = await resetPost(op, { revoke: "on" });
    expect(r.res.status).toBe(503);
    expect(r.text).toContain("auth.db is gone");
    expect(passwordHashOf(op)).toBe(before);
    expect(sessionRows(op)).toHaveLength(1);
    expect((await get(op, "/oauth/account", session)).res.status).toBe(200);
    expect(op.db.prepare("SELECT revoked_at FROM grants WHERE id = 'grant-1'").get()).toEqual({
      revoked_at: null,
    });
    expect(op.db.prepare("SELECT COUNT(*) AS n FROM burned_reset_tokens").get()).toEqual({ n: 0 });
  });

  it("with the box ticked and no registry wired, the reset is refused, not silently narrowed", async () => {
    const { op } = await claimedWithReset();
    const before = passwordHashOf(op);
    const r = await resetPost(op, { revoke: "on" });
    expect(r.res.status).toBe(400);
    expect(r.text).toMatch(/--revoke-grants/);
    expect(passwordHashOf(op)).toBe(before);
  });

  it("audits a completed reset and logs one line, and does neither on a refusal", async () => {
    const audit = vi.fn(async (_event: string) => undefined);
    const { op } = await claimedWithReset({ audit });
    const refused = await resetPost(op, { token: "wrong-token-0123456789-abcdefgh" });
    expect(refused.res.status).toBe(403);
    expect(audit).not.toHaveBeenCalled();
    expect((await resetPost(op)).res.status).toBe(303);
    expect(audit).toHaveBeenCalledWith("auth_credentials_reset");
    expect(op.logs.some((l) => /reset/.test(l))).toBe(true);
  });
});

describe("the boot notice", () => {
  it("is emitted while the variable is set, names it, and is absent when it is not", async () => {
    const { resetBootNotice } = await import("../src/auth/as-operator");
    const name = "OBSIDIAN_TC_AS_RESET_TOKEN";
    const issuer = "https://vault.example.com";
    expect(resetBootNotice({ [name]: RESET_TOKEN }, name, issuer)).toMatch(
      /warning.*OBSIDIAN_TC_AS_RESET_TOKEN.*remove/s,
    );
    expect(resetBootNotice({}, name, issuer)).toBeUndefined();
    expect(resetBootNotice({ [name]: RESET_TOKEN }, name, issuer)).not.toContain(RESET_TOKEN);
  });
});
