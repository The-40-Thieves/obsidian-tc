// GH #1433 review: the embed batching defaults are provider-dependent, and the schema-resolved
// provider is NOT final. `applyStickyEmbeddings` runs later — at boot and in five CLI commands —
// and restores an unconfigured install's EXISTING provider. It fires exactly when `provider` was
// absent, which is precisely when the schema default had already made it "local", so a lowering
// applied once in finalizeConfig left an ollama/openai install that merely omits `provider`
// running at 512/1 and indexing slower for no reason. RED before the fix: case 1 below keeps
// 512/1 after sticky resolution puts the provider back to "ollama".
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { applyStickyEmbeddings } from "../src/embeddings/sticky-provider";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("otc-batch-sticky-");
});
afterEach(() => {
  rmTemp(dir);
});

/** Same hand-built fixture shape embeddings-sticky-provider.test.ts uses — sticky resolution only
 *  ever reads `model`, `dimensions` and `is_active`, so real indexing is unnecessary. */
function seedChunkEmbedding(db: Database, model: string, dimensions = 768): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
     VALUES ('c1', 'main', 'a.md', '0', '[]', 'x', 'hash', 1, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
     VALUES ('c1', ?, ?, ?, 1, ?)`,
  ).run(model, dimensions, Buffer.alloc(16), now);
}

function writeConfig(embeddings?: Record<string, unknown>): string {
  const p = join(dir, "config.json");
  writeFileSync(
    p,
    JSON.stringify({
      cacheDir: ".otc-test-cache",
      vaults: [{ id: "main", path: "/tmp/main" }],
      ...(embeddings === undefined ? {} : { embeddings }),
    }),
    "utf8",
  );
  return p;
}

function stickyDb(model: string): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  seedChunkEmbedding(db, model);
  return db;
}

describe("embed batching defaults survive sticky provider resolution (GH #1433)", () => {
  it("restores 2048/4 when sticky resolution puts an unconfigured install back on ollama", () => {
    const cfg = loadConfig(writeConfig());
    // finalizeConfig saw the schema default "local" and lowered accordingly.
    expect(cfg.embeddings.provider).toBe("local");
    expect(cfg.embeddings.maxBatchTokens).toBe(512);
    expect(cfg.embeddings.concurrency).toBe(1);

    const resolution = applyStickyEmbeddings(cfg, stickyDb("ollama:nomic-embed-text"));

    expect(resolution.source).toBe("kept-from-index");
    expect(cfg.embeddings.provider).toBe("ollama");
    expect(cfg.embeddings.maxBatchTokens).toBe(2048);
    expect(cfg.embeddings.concurrency).toBe(4);
  });

  it("restores 2048/4 for a kept hosted provider too", () => {
    const cfg = loadConfig(writeConfig());
    applyStickyEmbeddings(cfg, stickyDb("openai:text-embedding-3-small"));
    expect(cfg.embeddings.provider).toBe("openai");
    expect(cfg.embeddings.maxBatchTokens).toBe(2048);
    expect(cfg.embeddings.concurrency).toBe(4);
  });

  // The other direction: nothing to keep, so the provider stays local and the lowered pair must
  // survive the second derivation rather than bouncing back to the schema defaults.
  it("keeps 512/1 when sticky resolution finds nothing and the provider stays local", () => {
    const cfg = loadConfig(writeConfig());
    const db = openMemoryDb();
    provisionCacheDb(db);
    const resolution = applyStickyEmbeddings(cfg, db);
    expect(resolution.source).toBe("default");
    expect(cfg.embeddings.provider).toBe("local");
    expect(cfg.embeddings.maxBatchTokens).toBe(512);
    expect(cfg.embeddings.concurrency).toBe(1);
  });

  it("keeps 512/1 when the kept identity is the local family itself", () => {
    const cfg = loadConfig(writeConfig());
    applyStickyEmbeddings(cfg, stickyDb("local:nomic-embed-text-v1.5:q8"));
    expect(cfg.embeddings.provider).toBe("local");
    expect(cfg.embeddings.maxBatchTokens).toBe(512);
    expect(cfg.embeddings.concurrency).toBe(1);
  });

  // An explicit value must survive BOTH derivations, in either provider direction.
  it("never overrides an explicit value across sticky resolution", () => {
    const cfg = loadConfig(writeConfig({ maxBatchTokens: 512, concurrency: 8 }));
    expect(cfg.embeddings.provider).toBe("local");
    applyStickyEmbeddings(cfg, stickyDb("ollama:nomic-embed-text"));
    expect(cfg.embeddings.provider).toBe("ollama");
    expect(cfg.embeddings.maxBatchTokens).toBe(512);
    expect(cfg.embeddings.concurrency).toBe(8);
  });

  // An explicit provider skips sticky resolution entirely, so this is the plain lowered case —
  // worth pinning because it is the path an operator who opted into "local" actually takes.
  it("an explicit local provider is unaffected by sticky resolution", () => {
    const cfg = loadConfig(writeConfig({ provider: "local" }));
    const resolution = applyStickyEmbeddings(cfg, stickyDb("ollama:nomic-embed-text"));
    expect(resolution.source).toBe("configured");
    expect(cfg.embeddings.provider).toBe("local");
    expect(cfg.embeddings.maxBatchTokens).toBe(512);
    expect(cfg.embeddings.concurrency).toBe(1);
  });
});
