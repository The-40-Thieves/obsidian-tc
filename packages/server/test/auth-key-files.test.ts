// Key-file trust: a signing key read from disk is only trusted if it is a regular file we own, not
// group/other-accessible, reached without following a symlink, inside a real 0700 directory. The
// check happens on the OPEN file descriptor (no stat-then-read gap) and is repeated on every use, so
// a chmod after startup is noticed within one verify.
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AuthRejection } from "../src/auth/jwt";
import { createKeyFile, KeyFileError, readKeyFile } from "../src/auth/key-files";
import { authKeysDir, createAuthRegistry, KEY_FILE_CACHE_TTL_MS } from "../src/auth/registry";
import { createTokenVerifier } from "../src/auth/verifier";
import { signAndRecord } from "../src/cli/commands/token-mint";
import { provisionAuthDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const posix = process.platform !== "win32";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

function fixture() {
  const dir = makeTempDir("auth-keyfiles-");
  dirs.push(dir);
  const db = openMemoryDb();
  provisionAuthDb(db);
  // Injected clock: a validated key is reused for KEY_FILE_CACHE_TTL_MS, so a test that changes the
  // file after a successful verify steps past that window to make the change observable.
  const clock = { t: Date.now() };
  const registry = createAuthRegistry(db, {
    configSecret: SECRET,
    keysDir: authKeysDir(dir),
    now: () => clock.t,
  });
  const verifier = createTokenVerifier({ secret: SECRET, registry });
  const pastWindow = () => {
    clock.t += KEY_FILE_CACHE_TTL_MS + 1;
  };
  return { dir, db, registry, verifier, keys: authKeysDir(dir), clock, pastWindow };
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
const keyFile = (keys: string) =>
  join(keys, readdirSync(keys).find((f) => f.endsWith(".key")) as string);

describe.skipIf(!posix)("key files are trusted only through the open descriptor", () => {
  it("refuses a key file that is a symlink to a well-behaved 0600 file", async () => {
    const { dir, registry, verifier, keys, pastWindow } = fixture();
    registry.rotateKey();
    const token = await signAndRecord(registry, claims());
    expect(await reasonOf(verifier.verify(token))).toBe("accepted");

    const file = keyFile(keys);
    const elsewhere = join(dir, "elsewhere.key");
    writeFileSync(elsewhere, readFileSync(file), { mode: 0o600 });
    rmSync(file);
    symlinkSync(elsewhere, file);
    expect(statSync(elsewhere).mode & 0o777).toBe(0o600);
    pastWindow();
    expect(await reasonOf(verifier.verify(token))).toBe("misconfigured");
    expect(() => readKeyFile(file)).toThrow(KeyFileError);
  });

  it("refuses an auth-keys directory that is a symlink", async () => {
    const { dir, registry, verifier, keys, pastWindow } = fixture();
    registry.rotateKey();
    const token = await signAndRecord(registry, claims());
    const real = join(dir, "real-keys");
    renameSync(keys, real);
    symlinkSync(real, keys);
    pastWindow();
    expect(await reasonOf(verifier.verify(token))).toBe("misconfigured");
    expect(() => registry.rotateKey()).toThrow(/symlink|real directory/);
  });

  it("detects a chmod 0644 made AFTER the key was first used, once the reuse window has passed", async () => {
    const { registry, verifier, keys, pastWindow } = fixture();
    registry.rotateKey();
    const token = await signAndRecord(registry, claims());
    expect(await reasonOf(verifier.verify(token))).toBe("accepted"); // secret now used once
    chmodSync(keyFile(keys), 0o644);
    pastWindow();
    expect(await reasonOf(verifier.verify(token))).toBe("misconfigured");
    chmodSync(keyFile(keys), 0o600);
    expect(await reasonOf(verifier.verify(token))).toBe("accepted");
  });

  it("reuses a validated key for at most KEY_FILE_CACHE_TTL_MS: inside the window a chmod is not yet seen, at the edge it is", async () => {
    const { registry, verifier, keys, clock } = fixture();
    registry.rotateKey();
    const token = await signAndRecord(registry, claims());
    expect(await reasonOf(verifier.verify(token))).toBe("accepted");
    chmodSync(keyFile(keys), 0o644);
    clock.t += KEY_FILE_CACHE_TTL_MS - 1;
    expect(await reasonOf(verifier.verify(token))).toBe("accepted"); // the documented staleness
    clock.t += 1;
    expect(await reasonOf(verifier.verify(token))).toBe("misconfigured");
  });

  it("does not cache a failed read: a bad file stays refused until it is fixed", async () => {
    const { registry, verifier, keys, pastWindow } = fixture();
    registry.rotateKey();
    const token = await signAndRecord(registry, claims());
    chmodSync(keyFile(keys), 0o644);
    pastWindow();
    expect(await reasonOf(verifier.verify(token))).toBe("misconfigured");
    expect(await reasonOf(verifier.verify(token))).toBe("misconfigured");
  });

  it("refuses a too-open keys directory on verify, and tightens it on rotate", async () => {
    const { registry, verifier, keys, pastWindow } = fixture();
    registry.rotateKey();
    const token = await signAndRecord(registry, claims());
    chmodSync(keys, 0o755);
    pastWindow(); // signing above validated the key; step past the reuse window
    expect(await reasonOf(verifier.verify(token))).toBe("misconfigured");
    registry.rotateKey();
    expect(statSync(keys).mode & 0o777).toBe(0o700);
  });

  it("creates key files 0600 in a 0700 directory, and never through an existing symlink", () => {
    const { dir, keys } = fixture();
    mkdirSync(keys, { mode: 0o700 });
    const target = join(dir, "victim");
    writeFileSync(target, "precious");
    const path = join(keys, "k_planted.key");
    symlinkSync(target, path);
    expect(() => createKeyFile(path, "s".repeat(43))).toThrow();
    expect(readFileSync(target, "utf8")).toBe("precious");

    const fresh = join(keys, "k_fresh.key");
    createKeyFile(fresh, "s".repeat(43));
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
    expect(() => createKeyFile(fresh, "again")).toThrow(); // O_EXCL: never overwrites
  });

  it("refuses an empty key file rather than signing with an empty secret", () => {
    const { keys } = fixture();
    mkdirSync(keys, { mode: 0o700 });
    const path = join(keys, "k_empty.key");
    writeFileSync(path, "\n", { mode: 0o600 });
    expect(() => readKeyFile(path)).toThrow(KeyFileError);
  });

  it("gives every refusal a structured reason, whatever text the path carries", () => {
    const { keys } = fixture();
    const odd = join(keys, "x is corrupt and is empty");
    mkdirSync(odd, { recursive: true, mode: 0o700 });
    const reasonOf = (path: string): unknown => {
      try {
        readKeyFile(path);
      } catch (e) {
        return e instanceof KeyFileError ? e.reason : "not a KeyFileError";
      }
      return "no error";
    };
    expect(reasonOf(join(odd, "absent.key"))).toBe("missing");
    writeFileSync(join(odd, "empty.key"), "\n", { mode: 0o600 });
    expect(reasonOf(join(odd, "empty.key"))).toBe("empty");
    writeFileSync(join(odd, "open.key"), "k", { mode: 0o600 });
    chmodSync(join(odd, "open.key"), 0o644);
    expect(reasonOf(join(odd, "open.key"))).toBe("exposed");
  });
});

describe("key-file trust on Windows is documented, not silently skipped", () => {
  it("the module exposes the limitation for doctor to report", async () => {
    const { KEY_FILE_TRUST_ENFORCED } = await import("../src/auth/key-files");
    expect(KEY_FILE_TRUST_ENFORCED).toBe(posix);
  });
});
