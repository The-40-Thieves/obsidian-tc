import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, describe, expect, it } from "vitest";
import { authKeysDir, createAuthRegistry } from "../src/auth/registry";
import { openAuthRegistry } from "../src/auth/registry-open";
import { openDatabase } from "../src/db/open";
import { provisionAuthDb } from "../src/db/provision";
import { MetricsRecorder } from "../src/metrics/registry";
import { wireTransports } from "../src/runtime/transport-wiring";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

function configFor(auth: Record<string, unknown>) {
  const root = makeTempDir("tw-auth-");
  dirs.push(root);
  const config = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: root }],
    cacheDir: join(root, "cache"),
    auth,
    transports: { stdio: false, http: { enabled: false } },
    observability: { prometheus: { enabled: true, bind: "127.0.0.1", port: 0 } },
  });
  return { config, cacheDir: config.cacheDir };
}

const deps = (config: ReturnType<typeof configFor>["config"], metrics: MetricsRecorder) =>
  ({
    config,
    version: "t",
    registry: {},
    vaultRegistry: {},
    db: openMemoryDb(),
    firstVaultId: "v1",
    acl: {},
    jobQueue: {},
    metrics,
  }) as unknown as Parameters<typeof wireTransports>[0];

describe("wireTransports: auth registry", () => {
  it("refuses to boot a jwt server with no secret, no JWKS and no registry key", async () => {
    const { config } = configFor({ mode: "jwt" });
    await expect(wireTransports(deps(config, new MetricsRecorder()))).rejects.toThrow(
      /no signing key.*auth rotate-key/,
    );
  });

  it("boots from registry keys alone (no jwtSecret) and binds the key gauge to that registry", async () => {
    const { config, cacheDir } = configFor({ mode: "jwt", jwtSecret: SECRET });
    // Seed: a rotation while the secret was configured retires the `config` key.
    const seeded = await openAuthRegistry(config);
    seeded.registry.rotateKey({ graceSeconds: 0 });
    seeded.registry.rotateKey({ graceSeconds: 3600 });
    seeded.close();

    // The secret is now removed from the config.
    const bare = ServerConfigSchema.parse({ ...config, auth: { mode: "jwt" }, cacheDir });
    const metrics = new MetricsRecorder();
    const wiring = await wireTransports(deps(bare, metrics));
    try {
      expect(wiring.authRegistry).toBeDefined();
      const text = await metrics.metrics();
      expect(text).toContain('obsidian_tc_auth_keys{state="active"} 1');
      expect(text).toContain('obsidian_tc_auth_keys{state="retiring"} 1');
      expect(text).toContain('obsidian_tc_auth_keys{state="retired"} 1');
    } finally {
      await wiring.close();
    }
  });

  it("server start persists a window that elapsed while the server was down", async () => {
    const { config, cacheDir } = configFor({ mode: "jwt", jwtSecret: SECRET });
    const seeded = await openAuthRegistry(config, { now: () => Date.now() - 2 * 3_600_000 });
    const r = seeded.registry.rotateKey({ graceSeconds: 60 }); // ended ~2h - 60s ago
    seeded.close();
    const wiring = await wireTransports(deps(config, new MetricsRecorder()));
    try {
      const db = await openDatabase(join(cacheDir, "auth.db"));
      const row = db.prepare("SELECT state FROM auth_keys WHERE kid = ?").get(r.previousKid) as {
        state: string;
      };
      db.close?.();
      expect(row.state).toBe("retired");
    } finally {
      await wiring.close();
    }
  });

  it("a configured secret alone (registry never initialised) still boots, as before", async () => {
    const { config } = configFor({ mode: "jwt", jwtSecret: SECRET });
    const metrics = new MetricsRecorder();
    const wiring = await wireTransports(deps(config, metrics));
    try {
      // The implicit config key is the one active key.
      expect(await metrics.metrics()).toContain('obsidian_tc_auth_keys{state="active"} 1');
    } finally {
      await wiring.close();
    }
  });
});

describe("obsidian_tc_auth_keys gauge", () => {
  it("reports effective counts per state, and emits nothing while unbound", async () => {
    expect(await new MetricsRecorder().metrics()).not.toMatch(/^obsidian_tc_auth_keys\{/m);

    const db = openMemoryDb();
    provisionAuthDb(db);
    const dir = makeTempDir("tw-gauge-");
    dirs.push(dir);
    const clock = { t: 1_800_000_000_000 };
    const registry = createAuthRegistry(db, {
      configSecret: SECRET,
      keysDir: authKeysDir(dir),
      now: () => clock.t,
    });
    const rec = new MetricsRecorder();
    rec.bindAuthKeys(() => registry.keyCounts());
    registry.rotateKey({ graceSeconds: 60 });
    let text = await rec.metrics();
    expect(text).toContain('obsidian_tc_auth_keys{state="active"} 1');
    expect(text).toContain('obsidian_tc_auth_keys{state="retiring"} 1');
    expect(text).toContain('obsidian_tc_auth_keys{state="retired"} 0');

    clock.t += 61_000;
    text = await rec.metrics();
    expect(text).toContain('obsidian_tc_auth_keys{state="retiring"} 0');
    expect(text).toContain('obsidian_tc_auth_keys{state="retired"} 1');
  });
});
