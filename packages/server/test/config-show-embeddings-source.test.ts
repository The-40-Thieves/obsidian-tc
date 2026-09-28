// GH #995 fix round 2 (finding 5): `config show` used to dump the SCHEMA-resolved
// `embeddings.provider` (e.g. "local") with no indication that a real boot would keep a different,
// EXISTING index's provider instead — and re-saving that dump made "local" explicit, disabling
// sticky resolution on the next boot (the exact silent-switch class this PR exists to close). This
// file proves `config show` reports the EFFECTIVE provider/model/dimensions and its `source`
// (configured | kept-from-index | ambiguous-orphaned-index | default) as an ANNOTATION separate
// from the plain `embeddings` block, so `embeddings.provider` itself never changes value and a
// re-save can never pin a kept value as if the user had configured it.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run_config_show } from "../src/cli/commands/config-show";
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

async function runConfigShow(configPath: string): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  try {
    await run_config_show({ kind: "config-show", configPath });
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(chunks.join("")) as Record<string, unknown>;
}

describe("config show — effective embeddings provider + source (GH #995 fix round 2, finding 5)", () => {
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

  it("reports source 'kept-from-index' and the KEPT identity, without changing embeddings.provider", async () => {
    const vaultDir = tmpDir("otc-config-show-vault-");
    const cacheDir = tmpDir("otc-config-show-cache-");
    const confDir = tmpDir("otc-config-show-conf-");
    const configPath = join(confDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ cacheDir, vaults: [{ id: "main", path: vaultDir }] }),
    );
    await seedOllamaCache(cacheDir);

    const out = await runConfigShow(configPath);
    const embeddings = out.embeddings as Record<string, unknown>;
    const effective = out.embeddingsEffective as Record<string, unknown>;

    // The plain config block still shows the SCHEMA-resolved value untouched — never the kept one.
    expect(embeddings.provider).toBe("local");

    expect(effective.source).toBe("kept-from-index");
    expect(effective.provider).toBe("ollama");
    expect(effective.model).toBe("nomic-embed-text");
    expect(effective.dimensions).toBe(SEEDED_DIMENSIONS);
    // Must read as NOT part of the user's config — a copy-paste hazard warning.
    expect(String(effective.note)).toMatch(/not part of your config|do not copy/i);
  });

  it("reports source 'default' on a genuinely fresh install (no cache db yet)", async () => {
    const vaultDir = tmpDir("otc-config-show-vault2-");
    const cacheDir = join(tmpDir("otc-config-show-cache2-"), "nested-unused");
    const confDir = tmpDir("otc-config-show-conf2-");
    const configPath = join(confDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ cacheDir, vaults: [{ id: "main", path: vaultDir }] }),
    );

    const out = await runConfigShow(configPath);
    const effective = out.embeddingsEffective as Record<string, unknown>;
    expect(effective.source).toBe("default");
    expect(effective.provider).toBe("local");
  });

  it("reports source 'configured' when embeddings.provider is explicit — INCLUDING an explicit 'local' with ollama rows present", async () => {
    const vaultDir = tmpDir("otc-config-show-vault3-");
    const cacheDir = tmpDir("otc-config-show-cache3-");
    const confDir = tmpDir("otc-config-show-conf3-");
    const configPath = join(confDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        cacheDir,
        vaults: [{ id: "main", path: vaultDir }],
        embeddings: { provider: "local" },
      }),
    );
    await seedOllamaCache(cacheDir);

    const out = await runConfigShow(configPath);
    const embeddings = out.embeddings as Record<string, unknown>;
    const effective = out.embeddingsEffective as Record<string, unknown>;
    expect(embeddings.provider).toBe("local");
    expect(effective.source).toBe("configured");
    expect(effective.provider).toBe("local");
  });

  it("reports source 'ambiguous-orphaned-index' for a renamed vault id, still without mutating embeddings.provider", async () => {
    const vaultDir = tmpDir("otc-config-show-vault4-");
    const cacheDir = tmpDir("otc-config-show-cache4-");
    const confDir = tmpDir("otc-config-show-conf4-");
    const configPath = join(confDir, "config.json");
    // Config now names "notes"; the seeded rows are still under "main".
    writeFileSync(
      configPath,
      JSON.stringify({ cacheDir, vaults: [{ id: "notes", path: vaultDir }] }),
    );
    await seedOllamaCache(cacheDir);

    const out = await runConfigShow(configPath);
    const embeddings = out.embeddings as Record<string, unknown>;
    const effective = out.embeddingsEffective as Record<string, unknown>;
    expect(embeddings.provider).toBe("local");
    expect(effective.source).toBe("ambiguous-orphaned-index");
  });
});
