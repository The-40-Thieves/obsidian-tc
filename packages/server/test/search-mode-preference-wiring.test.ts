// retrieval.useSearchModePreference through the composition root (`buildServerRuntime`), the only
// place the flag and the experiential store meet. A unit test constructing registerM2Tools itself
// would pass whether or not tool-wiring.ts ever threads the flag, so this goes through the real
// runtime: flag off adds nothing, flag on reports a source, and only a seeded profile for THIS
// caller turns the source into `preference`.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { experientialMigrations } from "../src/cli/shared";
import { provisionExperientialDb } from "../src/db/experiential";
import { provisionCacheDb } from "../src/db/provision";
import { applyPreferenceDeltas } from "../src/experiential/reflect";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const dirs: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      /* a still-open sqlite handle can make Windows refuse the unlink; the assertions have run */
    }
  }
});

async function searchWith(flag: boolean, seed: boolean) {
  const vaultDir = tmp("otc-smp-vault-");
  writeFileSync(join(vaultDir, "fox.md"), "# Fox\n\nthe quick brown fox jumps\n");
  const config = configFromVaultPath(vaultDir);
  config.cacheDir = tmp("otc-smp-cache-");
  config.retrieval.useSearchModePreference = flag;
  if (seed) {
    const edb = await provisionExperientialDb(config.cacheDir, experientialMigrations);
    for (let i = 0; i < 6; i++)
      applyPreferenceDeltas(
        edb,
        "main",
        [{ key: "preferred.search_mode", op: "add", value: "search_text", scopeCaller: "test" }],
        1_800_000_000_000 + i,
      );
    edb.close?.();
  }
  const runtime = await buildServerRuntime(config, join(vaultDir, "config.json"));
  try {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const ctx = {
      caller: "test",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "main",
      db,
    };
    const r = await runtime.registry.dispatch(
      "search_vault",
      { vault: "main", query: "fox" },
      ctx as never,
    );
    return (r as { data: Record<string, unknown> }).data;
  } finally {
    await runtime.close("test cleanup");
  }
}

describe("retrieval.useSearchModePreference at the composition root", () => {
  it("off: no mode_source, even with a strong profile stored", async () => {
    const d = await searchWith(false, true);
    expect(d.mode_used).toBeDefined();
    expect("mode_source" in d).toBe(false);
  });

  it("on, no profile: the source is 'default'", async () => {
    const d = await searchWith(true, false);
    expect(d.mode_source).toBe("default");
  });

  it("on, strong profile for this caller: the source is 'preference' and the mode is text", async () => {
    const d = await searchWith(true, true);
    expect(d.mode_source).toBe("preference");
    expect(d.mode_used).toBe("text");
  });
});
