// GH #1014 fix round (Medium 4): `obsidian-tc index` (and `consolidate`/`memory-import --apply`,
// which share the same `resolveCliVaultIdentity` helper — cli/shared.ts) wrote vault-scoped rows
// without ever resolving vault identity, since only `wireStores` (the `serve` boot path) called
// `resolveAndApplyVaultIdentity`. RED on pre-fix main: a config `id` rename followed directly by
// `obsidian-tc index` (no `serve` first) left the old id's rows unresolved and orphaned, rather
// than re-keying them to the new id the way boot already does.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run_index } from "../src/cli/commands/index";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { normalizeRealpathForIdentity } from "../src/vault/identity";
import { canonicalizeVaultRoot } from "../src/vault/registry";
import { rmTemp } from "./tmp";

describe("run_index — GH #1014 vault identity resolution (CLI one-shot path)", () => {
  const tmpDirs: string[] = [];
  const tmpDir = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmTemp(d);
      } catch {
        // best-effort, matching every other buildServerRuntime/CLI temp-dir test in this suite.
      }
    }
  });

  it("a config id rename followed by `index` (no serve first) re-keys existing rows to the new id instead of leaving them orphaned", async () => {
    const vaultDir = tmpDir("otc-cli-index-rename-vault-");
    const cacheDir = tmpDir("otc-cli-index-rename-cache-");
    const confDir = tmpDir("otc-cli-index-rename-conf-");
    // Stored exactly as production stores it: realpath, then case-folded on case-insensitive
    // filesystems (macOS/Windows) — seeding the raw realpath would never match there.
    const root = normalizeRealpathForIdentity(canonicalizeVaultRoot(vaultDir));

    // Seed cache.db exactly as a prior `index`/`serve` run under the OLD id would have left it:
    // vault_identity already recording this root under "old-id", and one chunk row under it.
    const seedDb = await openDatabase(join(cacheDir, "cache.db"));
    provisionCacheDb(seedDb);
    const now = Date.now();
    seedDb
      .prepare(
        "INSERT INTO vault_identity (vault_id, root_realpath, created_at, updated_at) VALUES ('old-id', ?, ?, ?)",
      )
      .run(root, now, now);
    seedDb
      .prepare(
        `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
         VALUES ('c1', 'old-id', 'a.md', '0', '[]', 'x', 'hash', 1, ?, ?)`,
      )
      .run(now, now);
    seedDb.close?.();

    // Config now names the SAME path under a NEW id — a rename, config-side only (no serve ran
    // in between).
    const configPath = join(confDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ cacheDir, vaults: [{ id: "new-id", path: vaultDir }] }),
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      // The vault dir itself has no notes — indexVaultRecorded finds nothing to (re)index, so this
      // exercises identity resolution without needing any real embedding provider reachable.
      await run_index({ kind: "index", input: configPath });
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }

    const probeDb = await openDatabase(join(cacheDir, "cache.db"), undefined, { readonly: true });
    try {
      // Re-keyed to the new id, not left under the old one nor duplicated.
      expect(probeDb.prepare("SELECT vault_id FROM chunks WHERE id = 'c1'").get()).toEqual({
        vault_id: "new-id",
      });
      expect((probeDb.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n).toBe(
        1,
      );
      expect(
        probeDb.prepare("SELECT 1 FROM vault_identity WHERE vault_id = 'old-id'").get(),
      ).toBeUndefined();
      expect(
        probeDb.prepare("SELECT 1 FROM vault_identity WHERE vault_id = 'new-id'").get(),
      ).toBeDefined();
    } finally {
      probeDb.close?.();
    }
  });
});
