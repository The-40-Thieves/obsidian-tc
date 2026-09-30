// Signing-key registry: several keys valid at once, looked up by the token's `kid`.
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProtectedHeader, SignJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { AuthRejection } from "../src/auth/jwt";
import { authKeysDir, CONFIG_KID, createAuthRegistry } from "../src/auth/registry";
import { createTokenVerifier } from "../src/auth/verifier";
import { signAndRecord } from "../src/cli/commands/token-mint";
import { provisionAuthDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

function fixture() {
  const db = openMemoryDb();
  provisionAuthDb(db);
  const dir = mkdtempSync(join(tmpdir(), "auth-keys-"));
  dirs.push(dir);
  const clock = { t: 1_800_000_000_000 };
  const registry = createAuthRegistry(db, {
    configSecret: SECRET,
    keysDir: authKeysDir(dir),
    now: () => clock.t,
  });
  const verifier = createTokenVerifier({ secret: SECRET, registry });
  return { db, dir, clock, registry, verifier };
}

const claims = () => {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "agent-1", scopes: ["read:notes"], iat: now, exp: now + 3600 };
};
const withConfigKey = (header: Record<string, unknown>) =>
  new SignJWT(claims())
    .setProtectedHeader({ alg: "HS256", ...header })
    .sign(new TextEncoder().encode(SECRET));

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthRejection) return e.reason;
    throw e;
  }
  return "accepted";
}

describe("empty registry = the configured secret, unchanged", () => {
  it("verifies tokens with no kid, kid=config, or any other kid header", async () => {
    const { verifier } = fixture();
    for (const header of [{}, { kid: CONFIG_KID }, { kid: "whatever-an-old-minter-used" }]) {
      expect(await reasonOf(verifier.verify(await withConfigKey(header)))).toBe("accepted");
    }
  });

  it("mint signs with the config key and stamps kid=config until a rotation", async () => {
    const { registry } = fixture();
    const token = await signAndRecord(registry, claims());
    expect(decodeProtectedHeader(token).kid).toBe(CONFIG_KID);
  });
});

describe("rotate-key with grace 0 (immediate)", () => {
  it("enrols the config key, retires it, and the new key is the only signer", async () => {
    const { registry, verifier } = fixture();
    const old = await signAndRecord(registry, claims());
    const r = registry.rotateKey();
    expect(r.previousKid).toBe(CONFIG_KID);

    expect(
      registry.listKeys().map((k) => [k.kid === CONFIG_KID ? "config" : "new", k.state]),
    ).toEqual([
      ["config", "retired"],
      ["new", "active"],
    ]);
    expect(await reasonOf(verifier.verify(old))).toBe("key_retired");
    // An old token that never had a kid header rides on the config key, so it dies with it.
    expect(await reasonOf(verifier.verify(await withConfigKey({})))).toBe("key_retired");

    const fresh = await signAndRecord(registry, claims());
    expect(decodeProtectedHeader(fresh).kid).toBe(r.kid);
    expect(await reasonOf(verifier.verify(fresh))).toBe("accepted");
  });

  it("an unknown kid is refused once the registry is in use", async () => {
    const { registry, verifier } = fixture();
    registry.rotateKey();
    expect(await reasonOf(verifier.verify(await withConfigKey({ kid: "k_forged" })))).toBe(
      "unknown_key",
    );
  });
});

describe("rotate-key with a grace window: two keys valid at once", () => {
  it("accepts the retiring key until retire_after, then refuses it", async () => {
    const { registry, verifier, clock } = fixture();
    const old = await signAndRecord(registry, claims());
    const r = registry.rotateKey({ graceSeconds: 600 });
    const fresh = await signAndRecord(registry, claims());
    expect(r.previousRetireAfter).toBe(clock.t + 600_000);

    // both valid simultaneously
    expect(await reasonOf(verifier.verify(old))).toBe("accepted");
    expect(await reasonOf(verifier.verify(fresh))).toBe("accepted");
    expect(registry.listKeys().map((k) => k.state)).toEqual(["retiring", "active"]);

    clock.t += 601_000;
    expect(await reasonOf(verifier.verify(old))).toBe("key_retired");
    expect(await reasonOf(verifier.verify(fresh))).toBe("accepted");
  });

  it("a later rotation settles an elapsed window to retired and keeps one active key", () => {
    const { registry, clock } = fixture();
    registry.rotateKey({ graceSeconds: 60 });
    clock.t += 120_000;
    registry.rotateKey({ graceSeconds: 60 });
    const states = registry.listKeys().map((k) => k.state);
    expect(states.filter((s) => s === "active")).toHaveLength(1);
    expect(states).toEqual(["retired", "retiring", "active"]);
  });

  it("the schema refuses a second active key outright", () => {
    const { db, registry } = fixture();
    registry.rotateKey();
    expect(() =>
      db
        .prepare(
          "INSERT INTO auth_keys (kid, key_ref, created_at, state) VALUES ('k_dup', 'file:k_dup.key', 1, 'active')",
        )
        .run(),
    ).toThrow();
  });
});

describe("secret hygiene", () => {
  it("stores no key material in the database and writes the key file 0600", () => {
    const { db, dir, registry } = fixture();
    const r = registry.rotateKey();
    const file = join(authKeysDir(dir), `${r.kid}.key`);
    const secret = readFileSync(file, "utf8").trim();
    expect(secret.length).toBeGreaterThanOrEqual(32);
    const dump = JSON.stringify(db.prepare("SELECT * FROM auth_keys").all());
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(SECRET);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(authKeysDir(dir)).mode & 0o777).toBe(0o700);
    }
  });

  it("refuses a key file readable by group or other", async () => {
    if (process.platform === "win32") return;
    const { db, dir, registry } = fixture();
    registry.rotateKey();
    const fresh = await signAndRecord(registry, claims());
    const file = readdirSync(authKeysDir(dir)).find((f) => f.endsWith(".key"));
    chmodSync(join(authKeysDir(dir), file as string), 0o644);
    // A registry built after the mode change has no cached secret, so it must read the file, and
    // must refuse to.
    const cold = createAuthRegistry(db, { configSecret: SECRET, keysDir: authKeysDir(dir) });
    const verifier = createTokenVerifier({ secret: SECRET, registry: cold });
    expect(await reasonOf(verifier.verify(fresh))).toBe("misconfigured");
  });
});
