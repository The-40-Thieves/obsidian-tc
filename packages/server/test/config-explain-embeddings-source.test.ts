// GH #995 fix round 2 (finding 5): `config explain` must also surface the EFFECTIVE embeddings
// provider/model/dimensions and its source, reusing the same `probeEmbeddingsProviderSource`
// resolver `config show` and `doctor` use (not a reimplementation) — as a synthetic
// `embeddings.effective` row, `source: "derived"` (it comes from reading cache.db, not the config
// file), never mutating the real `embeddings.provider` entry's own file/default attribution.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run_config_explain } from "../src/cli/commands/config-explain";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { rmTemp } from "./tmp";

const SEEDED_DIMENSIONS = 768;

async function seedOllamaCache(cacheDir: string): Promise<void> {
  mkdirSync(cacheDir, { recursive: true });
  const db = await openDatabase(join(cacheDir, "cache.db"));
  provisionCacheDb(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
     VALUES ('c1', 'main', 'a.md', '0', '[]', 'x', 'hash', 1, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
     VALUES ('c1', 'ollama:nomic-embed-text', ?, ?, 1, ?)`,
  ).run(SEEDED_DIMENSIONS, Buffer.alloc(SEEDED_DIMENSIONS * 4), now);
  db.close?.();
}

async function runConfigExplainJson(configPath: string): Promise<{
  entries: Array<{ path: string; value: unknown; source: string; detail?: string }>;
  counts: Record<string, number>;
}> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  try {
    await run_config_explain({ kind: "config-explain", configPath, json: true });
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(chunks.join(""));
}

describe("config explain — effective embeddings provider + source (GH #995 fix round 2, finding 5)", () => {
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
        // best-effort
      }
    }
  });

  it("adds an embeddings.effective row reporting 'kept-from-index', without changing embeddings.provider's own attribution", async () => {
    const vaultDir = tmpDir("otc-config-explain-vault-");
    const cacheDir = tmpDir("otc-config-explain-cache-");
    const confDir = tmpDir("otc-config-explain-conf-");
    const configPath = join(confDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ cacheDir, vaults: [{ id: "main", path: vaultDir }] }),
    );
    await seedOllamaCache(cacheDir);

    const out = await runConfigExplainJson(configPath);
    const providerEntry = out.entries.find((e) => e.path === "embeddings.provider");
    const effectiveEntry = out.entries.find((e) => e.path === "embeddings.effective");

    // Unmodified: no `embeddings` block in the file at all -> still attributed "default".
    expect(providerEntry).toMatchObject({ value: "local", source: "default" });

    expect(effectiveEntry).toBeDefined();
    expect(effectiveEntry?.source).toBe("derived");
    expect(String(effectiveEntry?.detail)).toMatch(/kept-from-index/);
    expect(effectiveEntry?.value).toMatchObject({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: SEEDED_DIMENSIONS,
    });
  });

  it("counts the synthetic row under 'derived' in the summary counts", async () => {
    const vaultDir = tmpDir("otc-config-explain-vault2-");
    const cacheDir = tmpDir("otc-config-explain-cache2-");
    const confDir = tmpDir("otc-config-explain-conf2-");
    const configPath = join(confDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ cacheDir, vaults: [{ id: "main", path: vaultDir }] }),
    );
    await seedOllamaCache(cacheDir);

    const withoutRow = await runConfigExplainJson(configPath);
    const derivedEntries = withoutRow.entries.filter((e) => e.source === "derived");
    expect(withoutRow.counts.derived).toBe(derivedEntries.length);
    expect(derivedEntries.some((e) => e.path === "embeddings.effective")).toBe(true);
  });
});
