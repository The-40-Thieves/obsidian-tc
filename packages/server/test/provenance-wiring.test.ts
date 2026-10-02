// The composition root records writes: buildServerRuntime (the real wiring server start runs) must
// hand dispatch a recorder, sign with the auth registry's active EdDSA key when an HTTP jwt server
// has one, record unsigned when it does not, and record nothing when `provenance.enabled` is false.
// Everything below dispatches a real write_note through the runtime's own registry and reads the
// chain back from the cache.db the runtime wrote.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAuthRegistry } from "../src/auth/registry-open";
import { generateSigningKey } from "../src/auth/signing-keys";
import { configFromVaultPath } from "../src/cli/args";
import { openConfiguredDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import type { CallerContext } from "../src/mcp/registry";
import { inspectProvenance } from "../src/provenance/inspect";
import { buildServerRuntime, type ServerRuntime } from "../src/runtime/server-runtime";
import { openMemoryDb } from "./helpers";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const dirs: string[] = [];
const runtimes: ServerRuntime[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close("test");
  for (const d of dirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      // A still-open sqlite handle can make Windows refuse the unlink; the assertions already ran.
    }
  }
});

const tmp = (prefix: string): string => {
  const d = makeTempDir(prefix);
  dirs.push(d);
  return d;
};

function baseConfig() {
  const vaultDir = tmp("prov-wire-vault-");
  const config = configFromVaultPath(vaultDir);
  config.cacheDir = tmp("prov-wire-cache-");
  return { config, vaultDir };
}

async function writeThrough(runtime: ServerRuntime, path: string, content: string) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const ctx: CallerContext = {
    caller: "wiring-test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "main",
    db,
  };
  return runtime.registry.dispatch("write_note", { vault: "main", path, content }, ctx);
}

async function chain(config: ReturnType<typeof baseConfig>["config"]) {
  const db = await openConfiguredDatabase(config, "cache.db", { readonly: true });
  try {
    return db.prepare("SELECT body, kid, sig FROM write_provenance ORDER BY seq").all() as Array<{
      body: string;
      kid: string | null;
      sig: string | null;
    }>;
  } finally {
    db.close?.();
  }
}

/** get_provenance through the runtime's own registry, reading the cache.db the runtime wrote. */
async function queryThrough(
  runtime: ServerRuntime,
  config: ReturnType<typeof baseConfig>["config"],
  path: string,
) {
  const db = await openConfiguredDatabase(config, "cache.db", { readonly: true });
  try {
    const ctx: CallerContext = {
      caller: "wiring-test",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "main",
      db,
    };
    return await runtime.registry.dispatch(
      "get_provenance",
      { vault: "main", path, include_verification: true },
      ctx,
    );
  } finally {
    db.close?.();
  }
}

describe("provenance wiring (buildServerRuntime)", () => {
  it(
    "records a write_note through the real runtime, unsigned with no registry key",
    async () => {
      const { config, vaultDir } = baseConfig();
      const runtime = await buildServerRuntime(config, join(vaultDir, "config.json"));
      runtimes.push(runtime);
      const res = await writeThrough(runtime, "wired.md", "wired content");
      expect(res.ok).toBe(true);
      const rows = await chain(config);
      expect(rows).toHaveLength(1);
      const body = JSON.parse((rows[0] as { body: string }).body);
      expect(body).toMatchObject({ vault: "main", tool: "write_note", outcome: "ok" });
      expect(body.paths).toEqual([
        { path: "wired.md", before: "absent", after: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ]);
      // The host is the resolved salted digest, never the raw hostname; the version is the server's.
      expect(body.verified.host).toMatch(/^[0-9a-f]{32}$/);
      expect(body.verified.server_version).toMatch(/^\d+\.\d+\.\d+/);
      expect(rows[0]?.kid).toBeNull();
      expect(readFileSync(join(vaultDir, "wired.md"), "utf8")).toContain("wired content");
      // The query tool is registered by the same wiring and reads the record back: unsigned here.
      const q = await queryThrough(runtime, config, "wired.md");
      expect(q.ok && (q.data as { records: unknown[] }).records).toMatchObject([
        { tool: "write_note", verification: { signature: "unsigned", chain_link: "ok" } },
      ]);
      expect(JSON.stringify(rows)).not.toContain("wired content");
    },
    stallTimeout(30_000),
  );

  it(
    "records nothing when provenance.enabled is false",
    async () => {
      const { config, vaultDir } = baseConfig();
      config.provenance.enabled = false;
      const runtime = await buildServerRuntime(config, join(vaultDir, "config.json"));
      runtimes.push(runtime);
      expect((await writeThrough(runtime, "quiet.md", "x")).ok).toBe(true);
      const r = await inspectProvenance(config);
      expect(r.vaults).toEqual([]);
    },
    stallTimeout(30_000),
  );

  it(
    "signs with the registry's active EdDSA key on a jwt HTTP server, and verify accepts it",
    async () => {
      const { config, vaultDir } = baseConfig();
      config.auth = { ...config.auth, mode: "jwt", jwtSecret: SECRET };
      config.transports = {
        ...config.transports,
        stdio: false,
        http: { ...config.transports.http, enabled: true, host: "127.0.0.1", port: 0 },
      };
      const opened = await openAuthRegistry(config);
      opened.registry.rotateKey({
        alg: "EdDSA",
        graceSeconds: 0,
        generated: await generateSigningKey("EdDSA"),
      });
      opened.close();

      const runtime = await buildServerRuntime(config, join(vaultDir, "config.json"));
      runtimes.push(runtime);
      expect((await writeThrough(runtime, "signed.md", "s")).ok).toBe(true);
      const rows = await chain(config);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kid).not.toBeNull();
      expect(rows[0]?.sig).not.toBeNull();
      const r = await inspectProvenance(config);
      expect(r).toMatchObject({ ok: true, signingKeyActive: true });
      expect(r.vaults[0]).toMatchObject({ records: 1, signed: 1, unsigned: 0 });
      // get_provenance verifies with the SAME registry keys the recorder signs under.
      const q = await queryThrough(runtime, config, "signed.md");
      expect(q.ok && (q.data as { records: unknown[] }).records).toMatchObject([
        { verification: { ok: true, signature: "valid", chain_link: "ok", problems: [] } },
      ]);
    },
    stallTimeout(30_000),
  );
});
