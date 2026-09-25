// THE-1122 review — `probeStoredEmbeddingsProvider`, the DB-touching half of the upgrade-note
// feature (doctor-embeddings-upgrade-note.test.ts covers the pure check-factory half). Mirrors
// doctor-db-space.test.ts's real-file-probe shape.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeStoredEmbeddingsProvider } from "../src/cli/commands/doctor-probes";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";

describe("probeStoredEmbeddingsProvider", () => {
  it("returns undefined when cache.db does not exist yet (a fresh install)", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-storedprovider-missing-"));
    try {
      expect(await probeStoredEmbeddingsProvider(cacheDir, 5000)).toBeUndefined();
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("returns undefined when cache.db exists but vec_index_fingerprint has never been written", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-storedprovider-no-fp-"));
    try {
      const db = await openDatabase(join(cacheDir, "cache.db"));
      provisionCacheDb(db, { version: "test" });
      db.close?.();
      expect(await probeStoredEmbeddingsProvider(cacheDir, 5000)).toBeUndefined();
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("reads the provider (field 0 of the pipe-delimited fingerprint) off a real stored row", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-storedprovider-real-"));
    try {
      const db = await openDatabase(join(cacheDir, "cache.db"));
      provisionCacheDb(db, { version: "test" });
      db.exec(
        "CREATE TABLE IF NOT EXISTS vec_index_fingerprint (id INTEGER PRIMARY KEY CHECK (id = 1), fingerprint TEXT NOT NULL)",
      );
      db.prepare(
        "INSERT INTO vec_index_fingerprint (id, fingerprint) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint",
      ).run("ollama|nomic-embed-text|768|cosine|1|3|v1|");
      db.close?.();

      expect(await probeStoredEmbeddingsProvider(cacheDir, 5000)).toBe("ollama");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
