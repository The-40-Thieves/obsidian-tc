import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAsKey } from "../src/auth/as-boot";
import { removeRegisteredClient } from "../src/auth/as-client-admin";
import { insertRegistration } from "../src/auth/as-dcr";
import { createPending, loadPending } from "../src/auth/as-grants";
import { openOauthDb, recordIssuedAccess } from "../src/auth/oauth-db";
import { openAuthRegistry } from "../src/auth/registry-open";
import { parseCliArgs } from "../src/cli/args";
import { run_auth } from "../src/cli/commands/auth";
import { makeTempDir, rmTemp } from "./tmp";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmTemp(dir);
});

async function deployment() {
  const dir = makeTempDir("as-clients-cli-");
  dirs.push(dir);
  const vault = join(dir, "v");
  mkdirSync(vault);
  const raw = {
    vaults: [{ id: "main", path: vault }],
    cacheDir: join(dir, "cache"),
    auth: {
      mode: "jwt",
      jwtSecret: "test-only-secret-not-a-real-credential-0123456789",
      resource: "https://vault.example/mcp",
      as: {
        enabled: true,
        issuer: "https://vault.example",
        clients: [{ clientId: "static", name: "Static", redirectUris: ["https://app.example/cb"] }],
      },
    },
  };
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(raw));
  const cfg = ServerConfigSchema.parse(raw);
  const reg = await openAuthRegistry(cfg);
  await ensureAsKey(reg.registry, { alg: "ES256", accessTokenSeconds: 1800 });
  const store = await openOauthDb(cfg);
  const now = Date.now();
  for (const client of ["dcr_target", "dcr_spared"]) {
    insertRegistration(store.db, {
      clientId: client,
      meta: {
        name: client,
        redirectUris: ["https://app.example/cb"],
        grantTypes: ["authorization_code", "refresh_token"],
        authMethod: "none",
      },
      source: "v4:192.0.2.1",
      now,
      maxClients: 100,
    });
  }
  store.db
    .prepare(
      "INSERT INTO users (sub, username, password_hash, created_at) VALUES ('u', 'operator', 'x', ?)",
    )
    .run(now);
  for (const id of ["target", "spared"]) {
    store.db
      .prepare(
        "INSERT INTO grants (id, sub, client_id, redirect_uri, scope, resource, created_at) VALUES (?, 'u', ?, 'https://app.example/cb', 'read:notes', 'https://vault.example/mcp', ?)",
      )
      .run(id, `dcr_${id}`, now);
    store.db
      .prepare(
        "INSERT INTO refresh_tokens (token_hash, family_id, grant_id, scope, issued_at, family_expires_at) VALUES (?, ?, ?, 'read:notes', ?, ?)",
      )
      .run(`hash_${id}`, `family_${id}`, id, now, now + 86400000);
    recordIssuedAccess(store.db, reg.registry, {
      jti: `jti_${id}`,
      kid: reg.registry.signingKey({ purpose: "as" }).kid,
      sub: "u",
      scope: "read:notes",
      familyId: `family_${id}`,
      grantId: id,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 1800,
    });
  }
  store.close();
  reg.close();
  return { cfg, configPath };
}

describe("auth as clients", () => {
  it("keeps revocation debt durable when the registry fails, and pays it on retry after deletion", async () => {
    const { cfg } = await deployment();
    const store = await openOauthDb(cfg);
    const reg = await openAuthRegistry(cfg);
    try {
      const handle = createPending(
        store.db,
        {
          clientId: "dcr_target",
          redirectUri: "https://app.example/cb",
          scopes: ["read:notes"],
          resource: "https://vault.example/mcp",
          codeChallenge: "A".repeat(43),
          state: null,
        },
        Date.now(),
      ) as string;
      expect(() =>
        removeRegisteredClient(
          store.db,
          {
            revoke: () => {
              throw new Error("registry unavailable");
            },
          },
          "dcr_target",
          "removed",
          Date.now(),
        ),
      ).toThrow("registry unavailable");
      expect(loadPending(store.db, handle, Date.now())).toBeUndefined();
      expect(store.db.prepare("SELECT jti FROM revocation_outbox").all()).toEqual([
        { jti: "jti_target" },
      ]);
      expect(
        removeRegisteredClient(store.db, reg.registry, "dcr_target", "retry", Date.now()).status,
      ).toBe("not_found");
      expect(reg.registry.isRevoked("jti_target")).toBe(true);
      expect(reg.registry.isRevoked("jti_spared")).toBe(false);
      expect(store.db.prepare("SELECT 1 FROM revocation_outbox").all()).toHaveLength(0);
    } finally {
      store.close();
      reg.close();
    }
  });

  it("parses list and remove, including config and reason flags", () => {
    expect(parseCliArgs(["auth", "as", "clients", "list", "c.json", "--json"])).toMatchObject({
      kind: "auth",
      sub: "as-clients-list",
      configPath: "c.json",
      json: true,
    });
    expect(
      parseCliArgs([
        "auth",
        "as",
        "clients",
        "remove",
        "dcr_x",
        "--reason",
        "unused app",
        "--config",
        "c.json",
      ]),
    ).toMatchObject({
      kind: "auth",
      sub: "as-clients-remove",
      clientId: "dcr_x",
      reason: "unused app",
      configPath: "c.json",
    });
    for (const tail of [[], ["remove"], ["unknown"]]) {
      expect(parseCliArgs(["auth", "as", "clients", ...tail])).toMatchObject({ kind: "error" });
    }
  });

  it("lists registrations without secrets and removes only the target, revoking all its tokens with DCR disabled", async () => {
    const { cfg, configPath } = await deployment();
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      output += String(s);
      return true;
    });
    await run_auth({ kind: "auth", sub: "as-clients-list", configPath, json: true } as never);
    expect(JSON.parse(output)).toMatchObject([
      { clientId: "dcr_spared" },
      { clientId: "dcr_target" },
    ]);
    expect(output).not.toMatch(/secret|192\.0\.2|hash_/);
    output = "";
    await run_auth({
      kind: "auth",
      sub: "as-clients-remove",
      clientId: "dcr_target",
      configPath,
      json: true,
    } as never);
    expect(JSON.parse(output)).toMatchObject({
      clientId: "dcr_target",
      status: "removed",
      grants: 1,
    });
    const store = await openOauthDb(cfg);
    const reg = await openAuthRegistry(cfg);
    try {
      expect(
        store.db.prepare("SELECT 1 FROM oauth_clients WHERE client_id = 'dcr_target'").get(),
      ).toBeUndefined();
      expect(
        store.db.prepare("SELECT 1 FROM oauth_clients WHERE client_id = 'dcr_spared'").get(),
      ).toBeDefined();
      expect(
        store.db.prepare("SELECT revoked_at FROM grants WHERE id = 'target'").get(),
      ).not.toMatchObject({ revoked_at: null });
      expect(
        store.db.prepare("SELECT revoked_at FROM refresh_tokens WHERE grant_id = 'target'").get(),
      ).not.toMatchObject({ revoked_at: null });
      expect(reg.registry.isRevoked("jti_target")).toBe(true);
      expect(reg.registry.isRevoked("jti_spared")).toBe(false);
    } finally {
      store.close();
      reg.close();
    }
    for (const clientId of ["static", "https://client.example/metadata", "missing"]) {
      await expect(
        run_auth({ kind: "auth", sub: "as-clients-remove", clientId, configPath } as never),
      ).rejects.toThrow();
    }
  });
});
