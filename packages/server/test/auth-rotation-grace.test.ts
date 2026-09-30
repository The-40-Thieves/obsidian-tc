// Rotation grace window: the config-level default, the reaper (retiring -> retired), and the two
// properties that must hold whether or not the reaper ever ran: a key stops verifying at
// `retire_after`, and verification and minting need nothing but registry keys once the `config`
// key is retired.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProtectedHeader, SignJWT } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRejection } from "../src/auth/jwt";
import { authKeysDir, CONFIG_KID, createAuthRegistry } from "../src/auth/registry";
import { openAuthRegistry } from "../src/auth/registry-open";
import { createTokenVerifier } from "../src/auth/verifier";
import { parseCliArgs } from "../src/cli/args";
import { run_auth } from "../src/cli/commands/auth";
import { run_token_mint, signAndRecord } from "../src/cli/commands/token-mint";
import { provisionAuthDb } from "../src/db/provision";
import { createMetricsApp } from "../src/metrics/endpoint";
import { MetricsRecorder } from "../src/metrics/registry";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const T0 = 1_800_000_000_000;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

function fixture(opts: { configSecret?: string | null } = {}) {
  const db = openMemoryDb();
  provisionAuthDb(db);
  const dir = mkdtempSync(join(tmpdir(), "auth-grace-"));
  dirs.push(dir);
  const clock = { t: T0 };
  const configSecret = opts.configSecret === null ? undefined : (opts.configSecret ?? SECRET);
  const make = (secret: string | undefined) =>
    createAuthRegistry(db, {
      ...(secret !== undefined ? { configSecret: secret } : {}),
      keysDir: authKeysDir(dir),
      now: () => clock.t,
    });
  const registry = make(configSecret);
  return {
    db,
    dir,
    clock,
    registry,
    make,
    verifier: createTokenVerifier({ ...(configSecret ? { secret: configSecret } : {}), registry }),
  };
}

const claims = () => {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "agent-1", scopes: ["read:notes"], iat: now, exp: now + 3600 };
};

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthRejection) return e.reason;
    throw e;
  }
  return "accepted";
}

const stateOf = (r: ReturnType<typeof fixture>["registry"], kid: string) =>
  r.listKeys().find((k) => k.kid === kid)?.state;

describe("reaper: persists retiring -> retired", () => {
  it("leaves a key inside its window alone and retires it at retire_after", () => {
    const { registry, clock } = fixture();
    const r = registry.rotateKey({ graceSeconds: 60 });
    const old = r.previousKid as string;
    expect(stateOf(registry, old)).toBe("retiring");

    clock.t = T0 + 59_999;
    expect(registry.reapRetired()).toBe(0);
    expect(stateOf(registry, old)).toBe("retiring");

    clock.t = T0 + 60_000; // exactly retire_after: the verifier already refuses here
    expect(registry.reapRetired()).toBe(1);
    expect(stateOf(registry, old)).toBe("retired");
    expect(stateOf(registry, r.kid)).toBe("active");
    expect(registry.reapRetired()).toBe(0); // idempotent
  });

  it("never touches an active or an already-retired key", () => {
    const { registry, clock } = fixture();
    registry.rotateKey(); // config -> retired immediately
    const before = registry.listKeys().map((k) => [k.kid, k.state, k.retireAfter]);
    clock.t = T0 + 10 * 86_400_000;
    expect(registry.reapRetired()).toBe(0);
    expect(registry.listKeys().map((k) => [k.kid, k.state, k.retireAfter])).toEqual(before);
  });

  it("rotate settles an earlier elapsed window (rotation is one reaper trigger)", () => {
    const { registry, clock } = fixture();
    const first = registry.rotateKey({ graceSeconds: 60 });
    clock.t = T0 + 120_000;
    registry.rotateKey({ graceSeconds: 60 });
    expect(stateOf(registry, first.previousKid as string)).toBe("retired");
  });

  it("server start (openAuthRegistry with reap) persists an elapsed window", async () => {
    const root = mkdtempSync(join(tmpdir(), "auth-grace-open-"));
    dirs.push(root);
    const cfg = {
      cacheDir: join(root, "cache"),
      db: {},
      auth: { mode: "jwt", jwtSecret: SECRET },
    } as never;
    const clock = { t: T0 };
    const first = await openAuthRegistry(cfg, { now: () => clock.t });
    const r = first.registry.rotateKey({ graceSeconds: 30 });
    first.close();
    clock.t = T0 + 31_000;
    const reopened = await openAuthRegistry(cfg, { now: () => clock.t, reapRetired: true });
    try {
      expect(stateOf(reopened.registry, r.previousKid as string)).toBe("retired");
    } finally {
      reopened.close();
    }
  });

  it("keyCounts reports the EFFECTIVE state: an elapsed window counts as retired before any reap", () => {
    const { registry, clock } = fixture();
    registry.rotateKey({ graceSeconds: 60 });
    expect(registry.keyCounts()).toEqual({ active: 1, retiring: 1, retired: 0 });
    clock.t = T0 + 61_000;
    expect(stateOf(registry, CONFIG_KID)).toBe("retiring"); // row not yet rewritten
    expect(registry.keyCounts()).toEqual({ active: 1, retiring: 0, retired: 1 });
    registry.reapRetired();
    expect(registry.keyCounts()).toEqual({ active: 1, retiring: 0, retired: 1 });
  });
});

describe("verifier does not depend on the reaper", () => {
  it("accepts inside the window and refuses outside it, with the row still `retiring`", async () => {
    const { registry, verifier, clock } = fixture();
    const old = await signAndRecord(registry, claims());
    registry.rotateKey({ graceSeconds: 60 });

    clock.t = T0 + 30_000;
    expect(await reasonOf(verifier.verify(old))).toBe("accepted");

    clock.t = T0 + 61_000;
    expect(stateOf(registry, CONFIG_KID)).toBe("retiring"); // no reaper has run
    expect(await reasonOf(verifier.verify(old))).toBe("key_retired");

    registry.reapRetired();
    expect(stateOf(registry, CONFIG_KID)).toBe("retired");
    expect(await reasonOf(verifier.verify(old))).toBe("key_retired");
  });

  it("running the reaper inside the window does not shorten it", async () => {
    const { registry, verifier, clock } = fixture();
    const old = await signAndRecord(registry, claims());
    registry.rotateKey({ graceSeconds: 60 });
    clock.t = T0 + 59_000;
    registry.reapRetired();
    expect(await reasonOf(verifier.verify(old))).toBe("accepted");
  });
});

describe("mint --kid pins minting to an ACTIVE key", () => {
  it("signs with the named active key", async () => {
    const { registry } = fixture();
    const r = registry.rotateKey({ graceSeconds: 60 });
    const token = await signAndRecord(registry, claims(), { kid: r.kid });
    expect(decodeProtectedHeader(token).kid).toBe(r.kid);
  });

  it("refuses a retiring key, even inside its window", async () => {
    const { registry } = fixture();
    const r = registry.rotateKey({ graceSeconds: 60 });
    await expect(
      signAndRecord(registry, claims(), { kid: r.previousKid as string }),
    ).rejects.toThrow(/retiring/);
  });

  it("refuses a retired key", async () => {
    const { registry } = fixture();
    const r = registry.rotateKey();
    await expect(
      signAndRecord(registry, claims(), { kid: r.previousKid as string }),
    ).rejects.toThrow(/retired/);
  });

  it("refuses an unknown kid, and never records a token for a refusal", async () => {
    const { registry } = fixture();
    registry.rotateKey();
    await expect(signAndRecord(registry, claims(), { kid: "k_nope" })).rejects.toThrow(/unknown/);
    expect(registry.listTokens({ includeExpired: true })).toEqual([]);
  });

  it("names the implicit config key while the registry is still empty, and no other kid", async () => {
    const { registry } = fixture();
    const token = await signAndRecord(registry, claims(), { kid: CONFIG_KID });
    expect(decodeProtectedHeader(token).kid).toBe(CONFIG_KID);
    await expect(signAndRecord(registry, claims(), { kid: "k_nope" })).rejects.toThrow(/unknown/);
  });

  it("parses --kid on the command line", () => {
    expect(parseCliArgs(["token", "mint", "--sub", "a", "--kid", "k_abc", "c.json"])).toMatchObject(
      { kind: "token-mint", kid: "k_abc", configPath: "c.json" },
    );
  });
});

describe("registry keys alone: the configured secret is not needed after the config kid retires", () => {
  it("verifies and mints with no configSecret, and the retired config key is refused as retired", async () => {
    const { registry, make, db, clock } = fixture();
    const legacy = await signAndRecord(registry, claims());
    const r = registry.rotateKey();
    const fresh = await signAndRecord(registry, claims());

    // A new process with the jwtSecret removed from its config.
    const bare = make(undefined);
    const verifier = createTokenVerifier({ registry: bare });
    expect(await reasonOf(verifier.verify(fresh))).toBe("accepted");
    expect(await reasonOf(verifier.verify(legacy))).toBe("key_retired");
    const minted = await signAndRecord(bare, claims());
    expect(decodeProtectedHeader(minted).kid).toBe(r.kid);
    expect(await reasonOf(verifier.verify(minted))).toBe("accepted");
    void db;
    void clock;
  });

  it("with no secret and an EMPTY registry every HS256 token is refused (fail closed)", async () => {
    const { registry, make } = fixture({ configSecret: null });
    void registry;
    const verifier = createTokenVerifier({ registry: make(undefined) });
    const token = await new SignJWT(claims())
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode(SECRET));
    expect(await reasonOf(verifier.verify(token))).toBe("misconfigured");
    await expect(signAndRecord(make(undefined), claims())).rejects.toThrow(/no signing key/);
  });

  it("/metrics on a non-loopback bind verifies from the registry with no jwtSecret configured", async () => {
    const { registry, make } = fixture();
    registry.rotateKey();
    const bare = make(undefined);
    const token = await signAndRecord(bare, claims());
    const app = createMetricsApp({
      recorder: new MetricsRecorder(),
      bind: "0.0.0.0",
      port: 0,
      auth: { mode: "jwt", tokenTtlSeconds: 86400, rotationGraceSeconds: 0, requireJti: false },
      registry: bare,
    });
    const ok = await app.request("/metrics", { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    expect((await app.request("/metrics")).status).toBe(401);
  });
});

describe("grace default from config (auth.rotationGraceSeconds), overridden by --grace", () => {
  let out = "";
  beforeEach(() => {
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out += String(c);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  function deployment(auth: Record<string, unknown>) {
    const root = mkdtempSync(join(tmpdir(), "auth-grace-cfg-"));
    dirs.push(root);
    const vault = join(root, "vault");
    mkdirSync(vault);
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        vaults: [{ id: "main", path: vault }],
        cacheDir: join(root, "cache"),
        auth: { mode: "jwt", jwtSecret: SECRET, ...auth },
      }),
    );
    return { configPath, cacheDir: join(root, "cache") };
  }
  const rotate = async (configPath: string, over: Record<string, unknown> = {}) => {
    out = "";
    await run_auth({ kind: "auth", sub: "rotate-key", configPath, json: true, ...over } as never);
    return JSON.parse(out) as { previous_retire_after: number | null };
  };
  const keysOf = async (configPath: string) => {
    out = "";
    await run_auth({ kind: "auth", sub: "list", keys: true, configPath, json: true } as never);
    return JSON.parse(out) as { state: string }[];
  };

  it("uses auth.rotationGraceSeconds when --grace is omitted", async () => {
    const d = deployment({ rotationGraceSeconds: 3600 });
    const before = Date.now();
    const r = await rotate(d.configPath);
    const window = (r.previous_retire_after as number) - before;
    expect(window).toBeGreaterThanOrEqual(3_600_000);
    expect(window).toBeLessThan(3_600_000 + 10_000);
    expect((await keysOf(d.configPath)).map((k) => k.state)).toEqual(["retiring", "active"]);
  });

  it("lets an explicit --grace 0 override a non-zero config default", async () => {
    const d = deployment({ rotationGraceSeconds: 3600 });
    await rotate(d.configPath, { graceSeconds: 0 });
    expect((await keysOf(d.configPath)).map((k) => k.state)).toEqual(["retired", "active"]);
  });

  it("lets --grace override the config default with a different window", async () => {
    const d = deployment({ rotationGraceSeconds: 3600 });
    const before = Date.now();
    const r = await rotate(d.configPath, { graceSeconds: 60 });
    expect((r.previous_retire_after as number) - before).toBeLessThan(70_000);
  });

  it("defaults to an immediate retirement when neither is set (behaviour preserved)", async () => {
    const d = deployment({});
    await rotate(d.configPath);
    expect((await keysOf(d.configPath)).map((k) => k.state)).toEqual(["retired", "active"]);
  });

  it("run_token_mint --kid refuses a retiring key end to end", async () => {
    const d = deployment({});
    await rotate(d.configPath, { graceSeconds: 600 });
    out = "";
    await run_auth({
      kind: "auth",
      sub: "list",
      keys: true,
      configPath: d.configPath,
      json: true,
    } as never);
    const keys = JSON.parse(out) as { kid: string; state: string }[];
    const retiring = keys.find((k) => k.state === "retiring") as { kid: string };
    await expect(
      run_token_mint({
        kind: "token-mint",
        configPath: d.configPath,
        sub: "a",
        kid: retiring.kid,
        json: true,
      }),
    ).rejects.toThrow(/retiring/);
  });
});
