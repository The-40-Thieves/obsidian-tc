// `obsidian-tc provenance verify`, driven through the functions cli.ts dispatches to, against a real
// config file, a real cache.db and a real auth registry on disk (an EdDSA key made by `auth
// rotate-key --alg EdDSA`). Records are appended with the same store the server uses.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authDbPath } from "../src/auth/registry";
import { openAuthRegistry } from "../src/auth/registry-open";
import { parseCliArgs } from "../src/cli/args";
import { run_auth } from "../src/cli/commands/auth";
import { run_provenance } from "../src/cli/commands/provenance";
import { resolveServeConfig } from "../src/cli/resolve-config";
import { openConfiguredDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { registrySignerSource } from "../src/provenance/signer";
import { appendProvenance } from "../src/provenance/store";
import { rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

function deployment() {
  const root = mkdtempSync(join(tmpdir(), "prov-cli-"));
  dirs.push(root);
  const vault = join(root, "vault");
  mkdirSync(vault);
  const cacheDir = join(root, "cache");
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      vaults: [
        { id: "main", path: vault },
        { id: "second", path: vault },
      ],
      cacheDir,
      auth: { mode: "jwt", jwtSecret: SECRET },
    }),
  );
  return { cacheDir, configPath };
}

let out = "";
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out += String(c);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  // run_provenance reports failure through the exit code; do not let it fail the test process.
  process.exitCode = undefined;
});

async function rotateEdDsa(configPath: string) {
  await run_auth({ kind: "auth", sub: "rotate-key", configPath, alg: "EdDSA" } as never);
}

/** Append `n` records to `vault`'s chain in the deployment's cache.db, signed when `sign`. */
async function seed(configPath: string, vault: string, n: number, sign: boolean) {
  const cfg = resolveServeConfig(configPath);
  const opened = await openAuthRegistry(cfg);
  const db = await openConfiguredDatabase(cfg, "cache.db");
  try {
    provisionCacheDb(db);
    const signer = sign ? registrySignerSource(opened.registry)() : undefined;
    for (let i = 1; i <= n; i++) {
      appendProvenance(
        db,
        {
          vaultId: vault,
          ts: 1_800_000_000_000 + i,
          tool: "write_note",
          outcome: "ok",
          paths: [{ path: `n${i}.md`, before: "absent", after: "a".repeat(64) }],
          pathsOmitted: 0,
          verified: { host: "h", server_version: "0" },
          unauthenticated: {},
          self_reported: {},
        },
        signer,
      );
    }
  } finally {
    db.close?.();
    opened.close();
  }
}

async function mutate(configPath: string, sql: string) {
  const cfg = resolveServeConfig(configPath);
  const db = await openConfiguredDatabase(cfg, "cache.db");
  try {
    db.exec(sql);
  } finally {
    db.close?.();
  }
}

const verify = async (configPath: string, over: Record<string, unknown> = {}) => {
  out = "";
  await run_provenance({ kind: "provenance", sub: "verify", configPath, ...over } as never);
  return out;
};

describe("provenance argv", () => {
  it("parses verify with its flags and a positional config path", () => {
    expect(parseCliArgs(["provenance", "verify", "c.json"])).toMatchObject({
      kind: "provenance",
      sub: "verify",
      configPath: "c.json",
      json: false,
      allowUnsigned: false,
    });
    expect(
      parseCliArgs([
        "provenance",
        "verify",
        "--vault",
        "main",
        "--allow-unsigned",
        "--json",
        "--config",
        "c.json",
      ]),
    ).toMatchObject({
      vault: "main",
      allowUnsigned: true,
      json: true,
      configPath: "c.json",
    });
  });

  it("a flag's value is never taken for the config path; bad subcommands are errors", () => {
    const c = parseCliArgs(["provenance", "verify", "--vault", "main"]);
    expect(c).toMatchObject({ vault: "main" });
    expect((c as { configPath?: string }).configPath).toBeUndefined();
    expect(parseCliArgs(["provenance"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["provenance", "frobnicate"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["provenance", "verify", "--vault"])).toMatchObject({ kind: "error" });
  });
});

describe("provenance verify", () => {
  it("reports an intact, signed chain as OK and exits 0", async () => {
    const d = deployment();
    await rotateEdDsa(d.configPath);
    await seed(d.configPath, "main", 3, true);
    const text = await verify(d.configPath);
    expect(text).toContain("vault main: 3 records (3 signed, 0 unsigned): OK");
    expect(process.exitCode).toBeUndefined();
  });

  it("says so when there is nothing to verify", async () => {
    const d = deployment();
    expect(await verify(d.configPath)).toContain("no provenance records");
    expect(process.exitCode).toBeUndefined();
  });

  it("a removed last record FAILS, names the head, and exits 1", async () => {
    const d = deployment();
    await rotateEdDsa(d.configPath);
    await seed(d.configPath, "main", 3, true);
    await mutate(d.configPath, "DELETE FROM write_provenance WHERE seq = 3");
    const text = await verify(d.configPath);
    expect(text).toContain("FAILED");
    expect(text).toContain("head_mismatch");
    expect(process.exitCode).toBe(1);
  });

  it("--json carries ok and the per-vault problems; --vault limits the run", async () => {
    const d = deployment();
    await rotateEdDsa(d.configPath);
    await seed(d.configPath, "main", 2, true);
    await seed(d.configPath, "second", 2, true);
    await mutate(
      d.configPath,
      "UPDATE write_provenance SET body = body || ' ' WHERE vault_id = 'second' AND seq = 1",
    );
    const all = JSON.parse(await verify(d.configPath, { json: true }));
    expect(all.ok).toBe(false);
    expect(all.vaults.map((v: { vault: string; ok: boolean }) => [v.vault, v.ok])).toEqual([
      ["main", true],
      ["second", false],
    ]);
    expect(all.vaults[1].problems[0]).toMatchObject({ code: "hash_mismatch", seq: 1 });
    process.exitCode = undefined;
    const only = JSON.parse(await verify(d.configPath, { json: true, vault: "main" }));
    expect(only.ok).toBe(true);
    expect(only.vaults).toHaveLength(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("unsigned records fail unless --allow-unsigned", async () => {
    const d = deployment();
    await seed(d.configPath, "main", 2, false);
    expect(await verify(d.configPath)).toContain("unsigned");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const lax = await verify(d.configPath, { allowUnsigned: true });
    expect(lax).toContain("OK");
    expect(process.exitCode).toBeUndefined();
  });

  it("a key rotated out since the records were written still verifies them", async () => {
    const d = deployment();
    await rotateEdDsa(d.configPath);
    await seed(d.configPath, "main", 2, true);
    await run_auth({
      kind: "auth",
      sub: "rotate-key",
      configPath: d.configPath,
      alg: "EdDSA",
      graceSeconds: 0,
    } as never);
    await seed(d.configPath, "main", 1, true);
    const text = await verify(d.configPath);
    expect(text).toContain("vault main: 3 records (3 signed, 0 unsigned): OK");
  });

  it("refuses, naming the registry, when auth.db is lost", async () => {
    const d = deployment();
    await rotateEdDsa(d.configPath);
    await seed(d.configPath, "main", 1, true);
    rmSync(authDbPath(d.cacheDir));
    await expect(verify(d.configPath)).rejects.toThrow(/cannot verify signatures/);
  });
});
