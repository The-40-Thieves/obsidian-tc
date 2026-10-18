import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { loadGitSyncConfig } from "../src/git-sync/env";
import { ToolRegistry } from "../src/mcp/registry";
import { MetricsRecorder } from "../src/metrics/registry";
import { wireTransports } from "../src/runtime/transport-wiring";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET_VARIABLE = "OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET";
const SECRET = "wiring-test-webhook-secret-0123456789abcdef";
const SHORT = "short-secret-value-0123";
const BODY = '{"ref":"refs/heads/main"}';
const JWT_SECRET = "test-only-secret-not-a-real-credential-0123456789";

const dirs: string[] = [];
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[SECRET_VARIABLE];
});

afterEach(() => {
  if (saved === undefined) delete process.env[SECRET_VARIABLE];
  else process.env[SECRET_VARIABLE] = saved;
  for (const dir of dirs.splice(0)) rmTemp(dir);
});

function configFor(http: { enabled: boolean; port?: number }) {
  const root = makeTempDir("vault-sync-wiring-");
  dirs.push(root);
  const config = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: root }],
    cacheDir: join(root, "cache"),
    auth: { mode: "jwt", jwtSecret: JWT_SECRET },
    transports: {
      stdio: false,
      http: { ...http, host: "127.0.0.1" },
    },
    observability: { prometheus: { enabled: false } },
  });
  return { config, root, cacheDir: config.cacheDir };
}

function deps(config: ReturnType<typeof configFor>["config"]) {
  return {
    config,
    version: "t",
    registry: new ToolRegistry(),
    vaultRegistry: {},
    db: openMemoryDb(),
    firstVaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    jobQueue: {},
    metrics: new MetricsRecorder(),
  } as unknown as Parameters<typeof wireTransports>[0];
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("vault-sync webhook: startup validation", () => {
  it("refuses to start with a short secret even when HTTP is disabled", async () => {
    process.env[SECRET_VARIABLE] = SHORT;
    const { config } = configFor({ enabled: false });

    const failure = await wireTransports(deps(config)).then(
      () => "started",
      (error: Error) => error.message,
    );

    expect(failure).toContain(SECRET_VARIABLE);
    expect(failure).not.toContain(SHORT);
  });

  it("makes loadGitSyncConfig refuse the same short secret", () => {
    const { root, cacheDir } = configFor({ enabled: false });
    const env = {
      OBSIDIAN_TC_VAULT_GIT_URL: "file:///tmp/origin.git",
      OBSIDIAN_TC_VAULT_PATH: join(root, "vault"),
      OBSIDIAN_TC_CACHE_DIR: cacheDir,
      [SECRET_VARIABLE]: SHORT,
    };

    expect(() => loadGitSyncConfig(env)).toThrow(SECRET_VARIABLE);
    expect(() => loadGitSyncConfig(env)).not.toThrow(SHORT);
  });
});

describe("vault-sync webhook: production wiring", () => {
  it("routes POST /hooks/vault-sync through wireTransports when the secret is set", async () => {
    process.env[SECRET_VARIABLE] = SECRET;
    const port = await freePort();
    const { config, cacheDir } = configFor({ enabled: true, port });
    const wiring = await wireTransports(deps(config));
    try {
      const signature = `sha256=${createHmac("sha256", SECRET).update(BODY).digest("hex")}`;

      const response = await fetch(`http://127.0.0.1:${port}/hooks/vault-sync`, {
        method: "POST",
        headers: { host: `127.0.0.1:${port}`, "x-hub-signature-256": signature },
        body: BODY,
      });

      expect(response.status).toBe(202);
      expect(existsSync(join(cacheDir, "git-sync", "trigger"))).toBe(true);
    } finally {
      await wiring.close();
    }
  });

  it("does not route the path through wireTransports when the secret is unset", async () => {
    delete process.env[SECRET_VARIABLE];
    const port = await freePort();
    const { config, cacheDir } = configFor({ enabled: true, port });
    const wiring = await wireTransports(deps(config));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/hooks/vault-sync`, {
        method: "POST",
        headers: { host: `127.0.0.1:${port}` },
        body: BODY,
      });

      expect(response.status).toBe(404);
      expect(existsSync(join(cacheDir, "git-sync"))).toBe(false);
    } finally {
      await wiring.close();
    }
  });
});
