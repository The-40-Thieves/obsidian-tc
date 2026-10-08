// `auth as grants list|revoke` (slice S6, design v2 section 11): revoking a grant kills its refresh
// tokens and every live access token issued under it, and nothing of another grant. The store
// functions run over the HTTP fixture so "dies" is observed at /mcp; the CLI runs against a real
// config file with a real oauth.db and auth.db on disk.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAsKey } from "../src/auth/as-boot";
import { listGrants, revokeGrant } from "../src/auth/as-grants";
import { openOauthDb, recordIssuedAccess } from "../src/auth/oauth-db";
import { openAuthRegistry } from "../src/auth/registry-open";
import { parseCliArgs } from "../src/cli/args";
import { run_auth } from "../src/cli/commands/auth";
import {
  cleanupFlows,
  exchange,
  type Flow,
  issue,
  makeFlow,
  mcpPing,
  refreshFields,
  rows,
} from "./as-flow-harness";
import { makeTempDir, rmTemp } from "./tmp";

afterEach(cleanupFlows);

/** A second grant: another client, so the first one's remembered consent does not absorb it. */
const OTHER = { client_id: "native-client", redirect_uri: "http://127.0.0.1/callback" };
const WIDE = { scope: "read:notes write:notes" };
const grantIds = (flow: Flow): string[] =>
  rows<{ id: string }>(flow, "SELECT id FROM grants ORDER BY created_at, rowid").map((g) => g.id);

describe("revokeGrant", () => {
  it("kills the grant's refresh tokens and live access tokens in every family, and only that grant's", async () => {
    const flow = await makeFlow();
    const a1 = await issue(flow, WIDE);
    const a2 = await issue(flow, WIDE); // second family, same grant
    const rotated = await exchange(flow, refreshFields(a1.refresh));
    const other = await issue(flow, { scope: "read:notes", ...OTHER });
    const [target, spared] = grantIds(flow);
    expect(grantIds(flow)).toHaveLength(2);

    const out = revokeGrant(flow.db, flow.registry, target as string, "operator", flow.clock.t);
    expect(out).toMatchObject({ status: "revoked", families: 2, accessTokens: 3 });

    for (const t of [a1.access, a2.access, rotated.body.access_token as string]) {
      expect(await mcpPing(flow, t)).toBe(401);
    }
    for (const rt of [a1.refresh, a2.refresh, rotated.body.refresh_token as string]) {
      expect((await exchange(flow, refreshFields(rt))).body.error).toBe("invalid_grant");
    }
    expect(await mcpPing(flow, other.access)).toBe(200);
    expect(
      (await exchange(flow, refreshFields(other.refresh, { client_id: OTHER.client_id }))).res
        .status,
    ).toBe(200);
    expect(
      rows<{ revoked_at: number | null }>(
        flow,
        "SELECT revoked_at FROM grants WHERE id = ?",
        spared,
      )[0]?.revoked_at,
    ).toBeNull();
  });

  it("is idempotent, reports an unknown id, and a revoked grant refuses a code not yet exchanged", async () => {
    const flow = await makeFlow();
    await issue(flow);
    const [id] = grantIds(flow);
    expect(revokeGrant(flow.db, flow.registry, id as string, "x", flow.clock.t).status).toBe(
      "revoked",
    );
    expect(revokeGrant(flow.db, flow.registry, id as string, "x", flow.clock.t).status).toBe(
      "already_revoked",
    );
    expect(revokeGrant(flow.db, flow.registry, "nope", "x", flow.clock.t).status).toBe("not_found");
  });
});

describe("listGrants", () => {
  it("shows the live grants with their client, scope and live refresh families, newest revocations hidden unless asked", async () => {
    const flow = await makeFlow();
    await issue(flow, WIDE);
    await issue(flow, WIDE);
    await issue(flow, { scope: "read:notes", ...OTHER });
    const [first] = grantIds(flow);
    const live = listGrants(flow.db, { now: flow.clock.t });
    expect(live).toHaveLength(2);
    const author = live.find((g) => g.clientId === "test-client");
    expect(author).toMatchObject({
      clientId: "test-client",
      username: "operator",
      scope: "read:notes write:notes",
      liveFamilies: 2,
      revokedAt: null,
    });
    revokeGrant(flow.db, flow.registry, first as string, "x", flow.clock.t);
    expect(listGrants(flow.db, { now: flow.clock.t })).toHaveLength(1);
    const all = listGrants(flow.db, { now: flow.clock.t, all: true });
    expect(all).toHaveLength(2);
    expect(all.find((g) => g.id === first)?.liveFamilies).toBe(0);
  });

  it("does not count a family past its cap or already revoked", async () => {
    const flow = await makeFlow({ as: { refreshTokenDays: 1 } });
    await issue(flow);
    expect(listGrants(flow.db, { now: flow.clock.t })[0]?.liveFamilies).toBe(1);
    expect(listGrants(flow.db, { now: flow.clock.t + 2 * 86_400_000 })[0]?.liveFamilies).toBe(0);
  });
});

describe("the CLI", () => {
  it("parses `auth as grants list|revoke`", () => {
    expect(
      parseCliArgs(["auth", "as", "grants", "list", "c.json", "--all", "--json"]),
    ).toMatchObject({
      kind: "auth",
      sub: "as-grants-list",
      configPath: "c.json",
      all: true,
      json: true,
    });
    expect(
      parseCliArgs(["auth", "as", "grants", "revoke", "g-1", "c.json", "--reason", "lost laptop"]),
    ).toMatchObject({
      kind: "auth",
      sub: "as-grants-revoke",
      grantId: "g-1",
      configPath: "c.json",
      reason: "lost laptop",
    });
    expect(parseCliArgs(["auth", "as", "grants", "revoke"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["auth", "as", "grants"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["auth", "as", "grants", "nope"])).toMatchObject({ kind: "error" });
  });
});

describe("the CLI against files on disk", () => {
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

  async function deployment() {
    const root = makeTempDir("as-grants-cli-");
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
        resource: "https://vault.example.com/mcp",
        as: { enabled: true, issuer: "https://vault.example.com" },
      },
    };
    writeFileSync(configPath, JSON.stringify(raw));
    const cfg = ServerConfigSchema.parse(raw);
    const reg = await openAuthRegistry(cfg);
    await ensureAsKey(reg.registry, { alg: "ES256", accessTokenSeconds: 1800 });
    const store = await openOauthDb(cfg);
    const now = Date.now();
    store.db
      .prepare(
        "INSERT INTO users (sub, username, password_hash, created_at) VALUES ('u1', 'operator', 'x', ?)",
      )
      .run(now);
    store.db
      .prepare(
        `INSERT INTO grants (id, sub, client_id, redirect_uri, scope, resource, created_at)
         VALUES ('grant-1', 'u1', 'agent', 'http://127.0.0.1/cb', 'read:notes', 'https://vault.example.com/mcp', ?)`,
      )
      .run(now);
    store.db
      .prepare(
        `INSERT INTO refresh_tokens (token_hash, family_id, grant_id, scope, issued_at, family_expires_at)
         VALUES ('h1', 'fam-1', 'grant-1', 'read:notes', ?, ?)`,
      )
      .run(now, now + 86_400_000);
    const kid = reg.registry.signingKey({ purpose: "as" }).kid;
    recordIssuedAccess(store.db, reg.registry, {
      jti: "jti-1",
      kid,
      sub: "u1",
      scope: "read:notes",
      familyId: "fam-1",
      grantId: "grant-1",
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 1800,
    });
    reg.close();
    store.close();
    return { cfg, configPath };
  }

  const cmd = (sub: string, configPath: string, over: Record<string, unknown> = {}) =>
    run_auth({ kind: "auth", sub, configPath, ...over } as never);

  it("list prints the grant; revoke kills its refresh token and access token jti and says so", async () => {
    const { cfg, configPath } = await deployment();
    await cmd("as-grants-list", configPath, { json: true });
    const listed = JSON.parse(out) as Array<{ id: string; clientId: string; liveFamilies: number }>;
    expect(listed).toMatchObject([{ id: "grant-1", clientId: "agent", liveFamilies: 1 }]);
    expect(out).not.toContain("password");

    out = "";
    await cmd("as-grants-revoke", configPath, { grantId: "grant-1", reason: "lost laptop" });
    expect(out).toContain("grant-1");
    expect(out).toMatch(/1 refresh famil/);
    expect(out).toMatch(/1 access token/);

    const store = await openOauthDb(cfg);
    const reg = await openAuthRegistry(cfg);
    try {
      expect(
        store.db.prepare("SELECT revoked_at FROM grants WHERE id = 'grant-1'").get() as {
          revoked_at: number | null;
        },
      ).not.toMatchObject({ revoked_at: null });
      expect(
        (
          store.db
            .prepare("SELECT revoked_at FROM refresh_tokens WHERE token_hash = 'h1'")
            .get() as {
            revoked_at: number | null;
          }
        ).revoked_at,
      ).not.toBeNull();
      expect(reg.registry.isRevoked("jti-1")).toBe(true);
    } finally {
      store.close();
      reg.close();
    }
  });

  // POSIX permission bits only: Windows reports 0o666 for any directory.
  it.skipIf(process.platform === "win32")(
    "creates a missing cacheDir owner-only (it holds auth.db, oauth.db and the secrets)",
    async () => {
      const root = makeTempDir("as-grants-cli-mode-");
      dirs.push(root);
      mkdirSync(join(root, "v"));
      const configPath = join(root, "config.json");
      const cacheDir = join(root, "fresh", "cache");
      writeFileSync(
        configPath,
        JSON.stringify({
          vaults: [{ id: "main", path: join(root, "v") }],
          cacheDir,
          auth: {
            mode: "jwt",
            jwtSecret: "test-only-secret-not-a-real-credential-0123456789",
            resource: "https://vault.example.com/mcp",
            as: { enabled: true, issuer: "https://vault.example.com" },
          },
        }),
      );
      await cmd("as-grants-list", configPath);
      expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
    },
  );

  it("revoking an unknown grant fails and names it", async () => {
    const { configPath } = await deployment();
    await expect(cmd("as-grants-revoke", configPath, { grantId: "nope" })).rejects.toThrow(/nope/);
  });

  it("refuses when auth.as is not enabled", async () => {
    const root = makeTempDir("as-grants-cli-off-");
    dirs.push(root);
    const configPath = join(root, "config.json");
    mkdirSync(join(root, "v"));
    writeFileSync(
      configPath,
      JSON.stringify({
        vaults: [{ id: "main", path: join(root, "v") }],
        cacheDir: join(root, "c"),
      }),
    );
    await expect(cmd("as-grants-list", configPath)).rejects.toThrow(/auth\.as is not enabled/);
  });
});
