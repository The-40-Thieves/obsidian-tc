import { afterAll, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { authKeysDir, createAuthRegistry } from "../src/auth/registry";
import { generateSigningKey } from "../src/auth/signing-keys";
import { provisionAuthDb, provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const T0 = 1_800_000_000_000;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

function fixture() {
  const db = openMemoryDb();
  provisionAuthDb(db);
  const dir = makeTempDir("auth-jwks-cache-");
  dirs.push(dir);
  const clock = { t: T0 };
  const registry = createAuthRegistry(db, {
    configSecret: SECRET,
    keysDir: authKeysDir(dir),
    now: () => clock.t,
  });
  const rotate = async (alg: "ES256" | "EdDSA", graceSeconds: number) =>
    registry.rotateKey({ alg, generated: await generateSigningKey(alg), graceSeconds });
  return { clock, registry, rotate };
}

async function serve(f: ReturnType<typeof fixture>) {
  const cacheDb = openMemoryDb();
  provisionCacheDb(cacheDb);
  const handle = await startHttp({
    name: "obsidian-tc",
    version: "t",
    registry: new ToolRegistry(),
    auth: { mode: "jwt", jwtSecret: SECRET, tokenTtlSeconds: 86400, requireJti: false } as never,
    db: cacheDb,
    authRegistry: f.registry,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
  });
  const get = (headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${handle.port}/.well-known/jwks.json`, { headers });
  return { handle, get };
}

describe("jwks.json Cache-Control bound", () => {
  it("with no retiring key published, keeps the 60 s default", async () => {
    const f = fixture();
    await f.rotate("ES256", 0);
    const s = await serve(f);
    try {
      expect((await s.get()).headers.get("cache-control")).toBe("public, max-age=60");
    } finally {
      await s.handle.close();
    }
  });

  it("caps max-age at the whole seconds left until a retiring key's retire_after", async () => {
    const f = fixture();
    await f.rotate("ES256", 0);
    await f.rotate("EdDSA", 30); // ES256 retires at T0 + 30 s
    f.clock.t = T0 + 4_500; // 25.5 s left
    const s = await serve(f);
    try {
      const res = await s.get();
      expect(((await res.json()) as { keys: unknown[] }).keys).toHaveLength(2);
      expect(res.headers.get("cache-control")).toBe("public, max-age=25");
    } finally {
      await s.handle.close();
    }
  });

  it("a retirement further out than 60 s does not raise the default", async () => {
    const f = fixture();
    await f.rotate("ES256", 0);
    await f.rotate("EdDSA", 3600);
    const s = await serve(f);
    try {
      expect((await s.get()).headers.get("cache-control")).toBe("public, max-age=60");
    } finally {
      await s.handle.close();
    }
  });

  it("binds to the EARLIEST retire_after when several keys are retiring", async () => {
    const f = fixture();
    await f.rotate("ES256", 0);
    await f.rotate("EdDSA", 50); // ES256 retires at T0 + 50 s
    f.clock.t = T0 + 10_000;
    await f.rotate("ES256", 20); // the EdDSA key now retires at T0 + 10 s + 20 s = T0 + 30 s
    f.clock.t = T0 + 15_000; // earliest (EdDSA, first ES256 at +50 s) -> 15 s left
    const s = await serve(f);
    try {
      const res = await s.get();
      expect(((await res.json()) as { keys: unknown[] }).keys).toHaveLength(3);
      expect(res.headers.get("cache-control")).toBe("public, max-age=15");
    } finally {
      await s.handle.close();
    }
  });

  it("answers no-cache when a retirement is under a second away", async () => {
    const f = fixture();
    await f.rotate("ES256", 0);
    await f.rotate("EdDSA", 30);
    f.clock.t = T0 + 29_600; // 0.4 s left: still published, but no whole second to cache for
    const s = await serve(f);
    try {
      const res = await s.get();
      expect(((await res.json()) as { keys: unknown[] }).keys).toHaveLength(2);
      expect(res.headers.get("cache-control")).toBe("no-cache");
    } finally {
      await s.handle.close();
    }
  });

  it("ignores a retiring HS256 key: it is not published, so it cannot shorten the cache", async () => {
    const f = fixture();
    await f.rotate("ES256", 30); // the config HS256 key retires at +30 s; only the ES256 key is published
    f.clock.t = T0 + 5_000;
    const s = await serve(f);
    try {
      const res = await s.get();
      expect(((await res.json()) as { keys: unknown[] }).keys).toHaveLength(1);
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    } finally {
      await s.handle.close();
    }
  });

  it("once the window has elapsed the key is gone from the document and the bound lifts", async () => {
    const f = fixture();
    await f.rotate("ES256", 0);
    await f.rotate("EdDSA", 30);
    f.clock.t = T0 + 30_000;
    const s = await serve(f);
    try {
      const res = await s.get();
      expect(((await res.json()) as { keys: unknown[] }).keys).toHaveLength(1);
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    } finally {
      await s.handle.close();
    }
  });
});

describe("jwks.json ETag", () => {
  it("is a strong validator over the key set: stable while unchanged, different after rotation", async () => {
    const f = fixture();
    await f.rotate("ES256", 0);
    const s = await serve(f);
    try {
      const a = await s.get();
      const etag = a.headers.get("etag");
      expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
      expect((await s.get()).headers.get("etag")).toBe(etag);
      await f.rotate("EdDSA", 0);
      expect((await s.get()).headers.get("etag")).not.toBe(etag);
    } finally {
      await s.handle.close();
    }
  });

  it("answers a matching If-None-Match with 304, keeping the validator and the cache bound", async () => {
    const f = fixture();
    await f.rotate("ES256", 0);
    await f.rotate("EdDSA", 30);
    f.clock.t = T0 + 4_500;
    const s = await serve(f);
    try {
      const etag = (await s.get()).headers.get("etag") as string;
      for (const inm of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
        const res = await s.get({ "if-none-match": inm });
        expect(res.status, inm).toBe(304);
        expect(res.headers.get("etag")).toBe(etag);
        expect(res.headers.get("cache-control")).toBe("public, max-age=25");
        expect(await res.text()).toBe("");
      }
      expect((await s.get({ "if-none-match": '"stale"' })).status).toBe(200);
    } finally {
      await s.handle.close();
    }
  });
});
