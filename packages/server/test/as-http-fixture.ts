// The real HTTP app with the authorization-server routes mounted by createHttpApp itself — the
// fixture for tests whose subject IS createHttpApp's wiring (the client-ip policy, the GH #1477
// family-revocation sink), which the mount-level as-flow harness cannot cover.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { FolderAcl } from "../src/acl";
import "../src/auth/as-issuing";
import { claimOperator } from "../src/auth/as-operator-store";
import { hashPassword } from "../src/auth/as-password";
import { authKeysDir, createAuthRegistry } from "../src/auth/registry";
import { generateSigningKey } from "../src/auth/signing-keys";
import { provisionAuthDb, provisionCacheDb, provisionOauthDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { ToolRegistry } from "../src/mcp/registry";
import type { MetricsRecorder } from "../src/metrics/registry";
import { createHttpApp, type HttpApp } from "../src/transports/http";
import { ISSUER, PASSWORD, RESOURCE } from "./as-operator-harness";
import { openMemoryDb } from "./helpers";
import { makeTempDir } from "./tmp";

export interface AsHttpFixture {
  dir: string;
  handle: HttpApp;
  cacheDb: Database;
  url: (path: string) => string;
}

function fixtureAuth(dir: string, as?: Record<string, unknown>) {
  return ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: dir }],
    auth: {
      mode: "jwt",
      jwtSecret: "test-only-secret-not-a-real-credential-0123456789",
      resource: RESOURCE,
      as: { enabled: true, issuer: ISSUER, ...as },
    },
  }).auth as never;
}

/** createHttpApp over in-memory dbs and one temp-dir vault. `as` merges into the `auth.as` config;
 *  `rotateAsKey` installs an AS signing key (tests that hit /oauth/token need one). Cleanup —
 *  handle.close() and removing `dir` — is the caller's, so each test keeps its own discipline. */
export async function asHttpFixture(opts: {
  tempPrefix: string;
  as?: Record<string, unknown>;
  rotateAsKey?: boolean;
  http?: { trustedProxies?: string[]; forwardedHeader?: string };
  metrics?: MetricsRecorder;
}): Promise<AsHttpFixture> {
  const dir = makeTempDir(opts.tempPrefix);
  const auth = fixtureAuth(dir, opts.as);
  const authDb = openMemoryDb();
  provisionAuthDb(authDb);
  const registry = createAuthRegistry(authDb, { keysDir: authKeysDir(dir) });
  if (opts.rotateAsKey) {
    registry.rotateKey({
      purpose: "as",
      alg: "ES256",
      generated: await generateSigningKey("ES256"),
      graceSeconds: 0,
    });
  }
  const oauthDb = openMemoryDb();
  provisionOauthDb(oauthDb, { version: "t" });
  claimOperator(oauthDb, {
    username: "operator",
    passwordHash: await hashPassword(PASSWORD),
    now: Date.now(),
  });
  const cacheDb = openMemoryDb();
  provisionCacheDb(cacheDb);
  const handle: HttpApp = createHttpApp({
    name: "obsidian-tc",
    version: "t",
    registry: new ToolRegistry(),
    auth,
    db: cacheDb,
    oauthDb,
    authRegistry: registry,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    enableDnsRebindingProtection: false,
    ...(opts.metrics ? { metrics: opts.metrics } : {}),
    ...(opts.http ?? {}),
  } as never);
  return { dir, handle, cacheDb, url: (path) => `${ISSUER}${path}` };
}
