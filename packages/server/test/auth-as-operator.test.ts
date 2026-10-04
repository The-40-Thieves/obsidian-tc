// Operator identity for the bundled authorization server (design v2 sections 4.5 and 8), slice S4:
// the claim of an unclaimed server (first-run race, setup token) and the refusal of everything
// while it is unclaimed. Login, sessions and the page-level threat rows are in
// auth-as-operator-login.test.ts.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, describe, expect, it } from "vitest";
import { isClaimed, openOauthDb } from "../src/auth/oauth-db";
import {
  claimViaSetup,
  get,
  Jar,
  makeOperator,
  PASSWORD,
  post,
  SETUP_TOKEN,
  sha256,
  submit,
  T0,
  userRows,
} from "./as-operator-harness";
import { makeTempDir, rmTemp } from "./tmp";

const HOUR = 3_600_000;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

describe("an unclaimed authorization server refuses (first-run claim race row)", () => {
  it("serves no login form and says it is not claimed", async () => {
    const op = await makeOperator();
    for (const method of ["GET", "POST"] as const) {
      const res = await op.app.request(op.url("/oauth/login"), { method });
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toMatch(/not claimed/i);
      expect(text).not.toMatch(/type="password"/);
    }
  });

  it("refuses authorize, token and register with 503 until claimed", async () => {
    const op = await makeOperator();
    for (const [method, path] of [
      ["GET", "/oauth/authorize?client_id=x"],
      ["POST", "/oauth/token"],
      ["POST", "/oauth/register"],
    ] as const) {
      const res = await op.app.request(op.url(path), { method });
      expect(res.status, `${method} ${path}`).toBe(503);
      expect(await res.text()).toMatch(/not claimed/i);
    }
  });

  it("stops refusing once claimed (the refusal is the claim state, not a constant)", async () => {
    const op = await makeOperator();
    await claimViaSetup(op);
    const res = await op.app.request(op.url("/oauth/authorize?client_id=x"));
    expect(res.status).not.toBe(503);
  });

  it("is claimed exactly when an enabled operator exists", async () => {
    const op = await makeOperator();
    expect(isClaimed(op.db)).toBe(false);
    await claimViaSetup(op);
    expect(isClaimed(op.db)).toBe(true);
    op.db.prepare("UPDATE users SET disabled_at = ?").run(T0);
    expect(isClaimed(op.db)).toBe(false);
  });
});

describe("first-run race: two concurrent claims, exactly one wins", () => {
  it("lets one of six simultaneous setup claims through and refuses the rest", async () => {
    const op = await makeOperator();
    const forms = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const jar = new Jar();
        const page = await get(op, "/oauth/setup", jar);
        return { jar, csrf: page.csrf };
      }),
    );
    const results = await Promise.all(
      forms.map(({ jar, csrf }, i) =>
        post(
          op,
          "/oauth/setup",
          {
            csrf,
            token: SETUP_TOKEN,
            username: `attacker${i}`,
            password: `${PASSWORD}-${i}`,
            confirm: `${PASSWORD}-${i}`,
          },
          jar,
        ),
      ),
    );
    const statuses = results.map((r) => r.res.status).sort();
    expect(statuses.filter((s) => s === 303)).toHaveLength(1);
    expect(statuses.filter((s) => s === 403)).toHaveLength(5);
    expect(userRows(op)).toHaveLength(1);
  });

  it("claims once across two connections to the same oauth.db file", async () => {
    const { claimOperator } = await import("../src/auth/as-operator-store");
    const dir = makeTempDir("as-claim-");
    dirs.push(dir);
    const cfg = ServerConfigSchema.parse({
      vaults: [{ id: "v1", path: "/tmp/v1" }],
      cacheDir: dir,
    });
    const a = await openOauthDb(cfg);
    const b = await openOauthDb(cfg);
    try {
      const first = claimOperator(a.db, { username: "alice", passwordHash: "h1", now: T0 });
      const second = claimOperator(b.db, { username: "bob", passwordHash: "h2", now: T0 });
      expect(first).toMatchObject({ ok: true });
      expect(second).toEqual({ ok: false, reason: "already_claimed" });
      const rows = a.db.prepare("SELECT username FROM users").all() as { username: string }[];
      expect(rows.map((r) => r.username)).toEqual(["alice"]);
    } finally {
      a.close();
      b.close();
    }
  });

  it("refuses a setup claim after the CLI claim, and the CLI claim shares the same primitive", async () => {
    const op = await makeOperator();
    const { claimOperator } = await import("../src/auth/as-operator-store");
    const { hashPassword } = await import("../src/auth/as-password");
    const r = claimOperator(op.db, {
      username: "operator",
      passwordHash: await hashPassword(PASSWORD),
      now: T0,
    });
    expect(r.ok).toBe(true);
    const late = await submit(op, "/oauth/setup", {
      token: SETUP_TOKEN,
      username: "intruder",
      password: PASSWORD,
      confirm: PASSWORD,
    });
    expect(late.res.status).toBe(403);
    expect(userRows(op).map((u) => u.username)).toEqual(["operator"]);
  });
});

describe("setup token (single use, expiry, constant-time compare)", () => {
  const claim = (op: Awaited<ReturnType<typeof makeOperator>>, token: string, user = "operator") =>
    submit(op, "/oauth/setup", { token, username: user, password: PASSWORD, confirm: PASSWORD });

  it("is off when the env var is unset, empty or too short", async () => {
    for (const value of [undefined, "", "short-token"]) {
      const op = await makeOperator({ env: { OBSIDIAN_TC_AS_SETUP_TOKEN: value } });
      expect((await op.app.request(op.url("/oauth/setup"))).status).toBe(404);
      const r = await claim(op, value ?? "x");
      expect(r.res.status).toBe(404);
      expect(userRows(op)).toHaveLength(0);
    }
  });

  it("is read from the variable NAMED by auth.as.setupTokenEnv", async () => {
    const op = await makeOperator({
      as: { setupTokenEnv: "MY_SETUP_TOKEN" },
      env: { OBSIDIAN_TC_AS_SETUP_TOKEN: undefined, MY_SETUP_TOKEN: SETUP_TOKEN },
    });
    expect((await claim(op, SETUP_TOKEN)).res.status).toBe(303);
  });

  it("refuses a wrong token, including a prefix and a longer one, with 403", async () => {
    const op = await makeOperator();
    for (const bad of [
      SETUP_TOKEN.slice(0, -1),
      `${SETUP_TOKEN}x`,
      SETUP_TOKEN.toUpperCase(),
      "x".repeat(4096),
    ]) {
      const r = await claim(op, bad);
      expect(r.res.status, bad.slice(0, 12)).toBe(403);
    }
    expect(userRows(op)).toHaveLength(0);
  });

  it("claims with the right token: 303, one operator, its hash recorded and never the token", async () => {
    const op = await makeOperator();
    const r = await claim(op, SETUP_TOKEN, "Operator");
    expect(r.res.status).toBe(303);
    const [user] = userRows(op);
    expect(user?.username).toBe("operator");
    expect(user?.password_hash).toMatch(/^\$argon2id\$/);
    const state = op.db.prepare("SELECT * FROM setup_state").get() as {
      id: number;
      claimed_at: number;
      setup_token_hash_used: string;
    };
    expect(state).toMatchObject({
      id: 1,
      claimed_at: T0,
      setup_token_hash_used: sha256(SETUP_TOKEN),
    });
    for (const table of ["users", "setup_state", "sessions"]) {
      const dump = JSON.stringify(op.db.prepare(`SELECT * FROM ${table}`).all());
      expect(dump).not.toContain(SETUP_TOKEN);
      expect(dump).not.toContain(PASSWORD);
    }
  });

  it("is single use: the same token is refused with 403 after the claim", async () => {
    const op = await makeOperator();
    expect((await claim(op, SETUP_TOKEN)).res.status).toBe(303);
    const again = await claim(op, SETUP_TOKEN, "second");
    expect(again.res.status).toBe(403);
    expect(userRows(op)).toHaveLength(1);
  });

  it("stays burned even if the operator row is later removed: the used hash is what refuses", async () => {
    const op = await makeOperator();
    expect((await claim(op, SETUP_TOKEN)).res.status).toBe(303);
    op.db.prepare("DELETE FROM users").run();
    const replay = await claim(op, SETUP_TOKEN);
    expect(replay.res.status).toBe(403);
    expect(userRows(op)).toHaveLength(0);
    op.env.OBSIDIAN_TC_AS_SETUP_TOKEN = `${SETUP_TOKEN}-rotated`;
    expect((await claim(op, `${SETUP_TOKEN}-rotated`)).res.status).toBe(303);
  });

  it("expires 24 hours after the server started", async () => {
    const op = await makeOperator();
    op.clock.t = T0 + 24 * HOUR - 1000;
    const page = await get(op, "/oauth/setup");
    expect(page.res.status).toBe(200);
    op.clock.t = T0 + 24 * HOUR + 1000;
    expect((await claim(op, SETUP_TOKEN)).res.status).toBe(403);
    expect((await get(op, "/oauth/setup")).res.status).toBe(403);
    expect(userRows(op)).toHaveLength(0);
  });

  it("limits guesses: after ten wrong tokens even the right one is refused with 429", async () => {
    const op = await makeOperator();
    for (let i = 0; i < 10; i++) expect((await claim(op, `wrong-${i}`)).res.status).toBe(403);
    const blocked = await claim(op, SETUP_TOKEN);
    expect(blocked.res.status).toBe(429);
    expect(userRows(op)).toHaveLength(0);
    op.clock.t += 16 * 60_000;
    expect((await claim(op, SETUP_TOKEN)).res.status).toBe(303);
  });

  it("enforces the password policy and the confirmation before claiming", async () => {
    const op = await makeOperator();
    const short = await submit(op, "/oauth/setup", {
      token: SETUP_TOKEN,
      username: "operator",
      password: "short",
      confirm: "short",
    });
    expect(short.res.status).toBe(400);
    expect(short.text).toMatch(/12/);
    const mismatch = await submit(op, "/oauth/setup", {
      token: SETUP_TOKEN,
      username: "operator",
      password: PASSWORD,
      confirm: `${PASSWORD}!`,
    });
    expect(mismatch.res.status).toBe(400);
    expect(userRows(op)).toHaveLength(0);
    // The token was not burned by a form mistake.
    expect((await claim(op, SETUP_TOKEN)).res.status).toBe(303);
  });
});
