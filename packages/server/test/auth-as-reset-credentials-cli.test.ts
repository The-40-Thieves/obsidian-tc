// `obsidian-tc auth as reset-credentials` (design v2 section 4.11.5, slice S10): the recovery when the
// passkey and the password are both lost. The CLI runs against a real config file and a real oauth.db
// on disk, and the operator routes are mounted on that same file, so "an old session cookie gets 401
// after the reset" and "the new password signs in" are observed at the HTTP surface.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAsKey } from "../src/auth/as-boot";
import { type OpenedOauthDb, openOauthDb, recordIssuedAccess } from "../src/auth/oauth-db";
import { openAuthRegistry } from "../src/auth/registry-open";
import { parseCliArgs } from "../src/cli/args";
import { run_auth } from "../src/cli/commands/auth";
import {
  claimViaSetup,
  get,
  ISSUER,
  Jar,
  login,
  makeOperator,
  type OperatorFixture,
  PASSWORD,
  RESOURCE,
  sessionCookieName,
} from "./as-operator-harness";
import { makeTempDir, rmTemp } from "./tmp";
import { VirtualAuthenticator } from "./webauthn-authenticator";

const NEW_PASSWORD = "a different passphrase, long enough";
const RP_ID = new URL(ISSUER).hostname;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

let out = "";
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out += String(c);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

const csrfOfMount = (html: string): string =>
  /id="passkey"[^>]*data-csrf="([^"]+)"/.exec(html)?.[1] ?? "";

async function postJson(op: OperatorFixture, path: string, body: unknown, jar: Jar, csrf: string) {
  const cookie = jar.header();
  const res = await op.app.request(op.url(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: op.issuer,
      "x-csrf-token": csrf,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  jar.apply(res);
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/** A deployment on disk, the operator claimed through the setup page, one passkey, one live grant. */
async function deployment() {
  const root = makeTempDir("as-reset-cli-");
  dirs.push(root);
  const vault = join(root, "vault");
  mkdirSync(vault);
  const cacheDir = join(root, "cache");
  const configPath = join(root, "config.json");
  const raw = {
    vaults: [{ id: "main", path: vault }],
    cacheDir,
    auth: {
      mode: "jwt",
      jwtSecret: "test-only-secret-not-a-real-credential-0123456789",
      resource: RESOURCE,
      as: { enabled: true, issuer: ISSUER },
    },
  };
  writeFileSync(configPath, JSON.stringify(raw));
  const cfg = ServerConfigSchema.parse(raw);
  const reg = await openAuthRegistry(cfg);
  await ensureAsKey(reg.registry, { alg: "ES256", accessTokenSeconds: 1800 });
  const store: OpenedOauthDb = await openOauthDb(cfg);
  const op = await makeOperator({ db: store.db });
  await claimViaSetup(op);

  const jar = new Jar();
  await login(op, jar);
  const csrf = csrfOfMount((await get(op, "/oauth/account", jar)).text);
  const auth = new VirtualAuthenticator(ISSUER, RP_ID);
  const opts = await postJson(op, "/oauth/passkey/register/options", {}, jar, csrf);
  const done = await postJson(
    op,
    "/oauth/passkey/register/verify",
    { response: auth.register(opts.body as never) },
    jar,
    csrf,
  );
  expect(done.status).toBe(200);

  const sub = (store.db.prepare("SELECT sub FROM users").get() as { sub: string }).sub;
  const now = Date.now();
  store.db
    .prepare(
      `INSERT INTO grants (id, sub, client_id, redirect_uri, scope, resource, created_at)
       VALUES ('grant-1', ?, 'agent', 'http://127.0.0.1/cb', 'read:notes', ?, ?)`,
    )
    .run(sub, RESOURCE, now);
  store.db
    .prepare(
      `INSERT INTO refresh_tokens (token_hash, family_id, grant_id, scope, issued_at, family_expires_at)
       VALUES ('h1', 'fam-1', 'grant-1', 'read:notes', ?, ?)`,
    )
    .run(now, now + 86_400_000);
  recordIssuedAccess(store.db, reg.registry, {
    jti: "jti-1",
    kid: reg.registry.signingKey({ purpose: "as" }).kid,
    sub,
    scope: "read:notes",
    familyId: "fam-1",
    grantId: "grant-1",
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 1800,
  });
  return {
    cfg,
    configPath,
    op,
    auth,
    session: jar,
    registry: reg.registry,
    close: () => {
      reg.close();
      store.close();
    },
  };
}

const reset = (configPath: string, over: Record<string, unknown> = {}, password = NEW_PASSWORD) =>
  run_auth(
    { kind: "auth", sub: "as-reset-credentials", configPath, stdin: true, ...over } as never,
    {
      readStdin: async () => `${password}\n`,
    },
  );

const count = (op: OperatorFixture, table: string): number =>
  (op.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("argv", () => {
  it("parses `auth as reset-credentials [--user <name>] [--stdin] [--revoke-grants] [path]`", () => {
    expect(
      parseCliArgs([
        "auth",
        "as",
        "reset-credentials",
        "--user",
        "bob",
        "--stdin",
        "--revoke-grants",
        "c.json",
      ]),
    ).toMatchObject({
      kind: "auth",
      sub: "as-reset-credentials",
      user: "bob",
      stdin: true,
      revokeGrants: true,
      configPath: "c.json",
    });
    expect(parseCliArgs(["auth", "as", "reset-credentials"])).toMatchObject({
      sub: "as-reset-credentials",
      revokeGrants: false,
      stdin: false,
    });
    expect(parseCliArgs(["auth", "as", "set-password", "--revoke-grants"])).toMatchObject({
      kind: "error",
    });
    expect(parseCliArgs(["auth", "as", "nope"])).toMatchObject({ kind: "error" });
  });
});

describe("reset-credentials", () => {
  it("recovers a lost passkey: new password signs in, the old passkey and old password do not, and a new passkey can be enrolled", async () => {
    const d = await deployment();
    try {
      expect(count(d.op, "webauthn_credentials")).toBe(1);
      await reset(d.configPath);
      expect(out).toContain("1 passkey removed");
      expect(out).toContain("1 session ended");
      expect(count(d.op, "webauthn_credentials")).toBe(0);
      expect(count(d.op, "sessions")).toBe(0);

      // the old session cookie is dead
      const stale = await postJson(
        d.op,
        "/oauth/passkey/register/options",
        {},
        d.session,
        csrfOfMount((await get(d.op, "/oauth/account", d.session)).text),
      );
      expect(stale.status).toBe(401);
      expect((await get(d.op, "/oauth/account", d.session)).res.status).toBe(303);

      // the lost passkey is gone; the old password is gone; the new one works
      const page = await get(d.op, "/oauth/login", new Jar());
      const opts = await postJson(d.op, "/oauth/passkey/login/options", {}, new Jar(), "x");
      expect(opts.status).toBe(403);
      const pj = new Jar();
      const csrf = csrfOfMount((await get(d.op, "/oauth/login", pj)).text);
      const o2 = await postJson(d.op, "/oauth/passkey/login/options", {}, pj, csrf);
      const lost = await postJson(
        d.op,
        "/oauth/passkey/login/verify",
        { response: d.auth.assert(o2.body as never) },
        pj,
        csrf,
      );
      expect(lost.status).toBe(401);
      expect(page.res.status).toBe(200);
      const oldPw = new Jar();
      expect((await login(d.op, oldPw)).res.status).toBe(401);
      expect(sessionCookieName(oldPw)).toBeUndefined();
      const newPw = new Jar();
      const ok = await login(d.op, newPw, { username: "operator", password: NEW_PASSWORD });
      expect(ok.res.status).toBe(303);
      expect(sessionCookieName(newPw)).toBeDefined();

      // and a new passkey can be enrolled from that session
      const fresh = new VirtualAuthenticator(ISSUER, RP_ID);
      const csrfNew = csrfOfMount((await get(d.op, "/oauth/account", newPw)).text);
      const create = await postJson(d.op, "/oauth/passkey/register/options", {}, newPw, csrfNew);
      expect(create.status).toBe(200);
      const done = await postJson(
        d.op,
        "/oauth/passkey/register/verify",
        { response: fresh.register(create.body as never) },
        newPw,
        csrfNew,
      );
      expect(done.status).toBe(200);
      expect(count(d.op, "webauthn_credentials")).toBe(1);
    } finally {
      d.close();
    }
  });

  it("leaves grants and refresh families alone without --revoke-grants", async () => {
    const d = await deployment();
    try {
      await reset(d.configPath);
      expect(out).not.toContain("grant");
      expect(
        (
          d.op.db.prepare("SELECT revoked_at FROM grants WHERE id = 'grant-1'").get() as {
            revoked_at: number | null;
          }
        ).revoked_at,
      ).toBeNull();
      expect(d.registry.isRevoked("jti-1")).toBe(false);
    } finally {
      d.close();
    }
  });

  it("with --revoke-grants also revokes every grant, its refresh family and its live access tokens", async () => {
    const d = await deployment();
    try {
      await reset(d.configPath, { revokeGrants: true, json: true });
      expect(JSON.parse(out)).toMatchObject({
        user: "operator",
        passkeysRemoved: 1,
        sessionsEnded: 1,
        grantsRevoked: 1,
        refreshFamilies: 1,
        accessTokens: 1,
      });
      expect(
        (
          d.op.db.prepare("SELECT revoked_at FROM grants WHERE id = 'grant-1'").get() as {
            revoked_at: number | null;
          }
        ).revoked_at,
      ).not.toBeNull();
      expect(
        (
          d.op.db
            .prepare("SELECT revoked_at FROM refresh_tokens WHERE token_hash = 'h1'")
            .get() as { revoked_at: number | null }
        ).revoked_at,
      ).not.toBeNull();
      expect(d.registry.isRevoked("jti-1")).toBe(true);
    } finally {
      d.close();
    }
  });

  it("names the account with --user, and refuses an unknown one without changing anything", async () => {
    const d = await deployment();
    try {
      await expect(reset(d.configPath, { user: "nobody" })).rejects.toThrow(
        /no operator named nobody/,
      );
      await expect(reset(d.configPath, { user: "bad name!" })).rejects.toThrow(/--user may use/);
      expect(count(d.op, "webauthn_credentials")).toBe(1);
      expect(count(d.op, "sessions")).toBe(1);
      await reset(d.configPath, { user: "Operator" });
      expect(out).toContain("operator");
      expect(count(d.op, "webauthn_credentials")).toBe(0);
    } finally {
      d.close();
    }
  });

  it("refuses a password that is too short, and changes nothing", async () => {
    const d = await deployment();
    try {
      await expect(reset(d.configPath, {}, "short")).rejects.toThrow(/12/);
      expect(count(d.op, "webauthn_credentials")).toBe(1);
      expect(count(d.op, "sessions")).toBe(1);
      const jar = new Jar();
      expect(
        (await login(d.op, jar, { username: "operator", password: PASSWORD })).res.status,
      ).toBe(303);
    } finally {
      d.close();
    }
  });

  it("refuses when auth.as is not enabled", async () => {
    const root = makeTempDir("as-reset-cli-off-");
    dirs.push(root);
    mkdirSync(join(root, "v"));
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        vaults: [{ id: "main", path: join(root, "v") }],
        cacheDir: join(root, "c"),
      }),
    );
    await expect(reset(configPath)).rejects.toThrow(/auth\.as is not enabled/);
  });

  it("refuses an unclaimed server, naming the way to claim it", async () => {
    const root = makeTempDir("as-reset-cli-unclaimed-");
    dirs.push(root);
    mkdirSync(join(root, "v"));
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        vaults: [{ id: "main", path: join(root, "v") }],
        cacheDir: join(root, "c"),
        auth: {
          mode: "jwt",
          jwtSecret: "test-only-secret-not-a-real-credential-0123456789",
          resource: RESOURCE,
          as: { enabled: true, issuer: ISSUER },
        },
      }),
    );
    await expect(reset(configPath)).rejects.toThrow(/set-password/);
  });
});
