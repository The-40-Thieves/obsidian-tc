// index.embeddings (GH #1160): the doctor check for chunks carrying more than one active embedding,
// and for vec_chunks disagreeing with the active-embedding count at the configured width. The
// vec_chunks half of the real probe needs sqlite-vec, which node:sqlite cannot load, so that half
// is pinned in bun-smoke/doctor-embedding-integrity.test.ts; here the check's own verdicts are
// driven by states, and the probe's multi-active detection runs against a real cache.db.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { openDatabase } from "../src/db/open";
import { CACHE_MIGRATIONS } from "../src/db/provision";
import {
  type EmbeddingIntegrityState,
  embeddingIntegrityCheck,
  probeEmbeddingIntegrity,
} from "../src/doctor/embedding-integrity";
import { makeTempDir, rmTemp } from "./tmp";

const ctx = { serverVersion: "test" };
const base: EmbeddingIntegrityState = {
  activeEmbeddings: 10,
  configuredWidth: 16,
  activeAtConfiguredWidth: 10,
  multiActiveChunks: 0,
  multiActiveSamples: [],
  vecRows: 10,
};
const run = (s?: EmbeddingIntegrityState | "no-probe") =>
  embeddingIntegrityCheck(s === "no-probe" ? {} : { probe: () => s }).run(ctx);

describe("index.embeddings check", () => {
  it("is ok and says 'not probed' without a probe", async () => {
    const r = await run("no-probe");
    expect(r.status).toBe("ok");
    expect(r.details?.embeddings).toBe("not probed");
  });

  it("is ok when there is no store to inspect yet", async () => {
    expect((await run(undefined)).status).toBe("ok");
  });

  it("is ok when one-per-chunk holds and vec_chunks agrees", async () => {
    const r = await run(base);
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("vec_chunks agrees");
  });

  it("is ok when vec_chunks cannot be read but nothing else is wrong", async () => {
    const r = await run({
      ...base,
      vecRows: undefined,
      vecUnreadable: "sqlite-vec is not loadable",
    });
    expect(r.status).toBe("ok");
  });

  it("FAILS on a chunk with more than one active embedding and names the models", async () => {
    const r = await run({
      ...base,
      multiActiveChunks: 2,
      multiActiveSamples: ["chunkaaaaaaa: m:one, m:two"],
    });
    expect(r.status).toBe("fail");
    expect(r.issues?.join(" ")).toContain("m:one, m:two");
    expect(r.remediation).toContain("20261008_001");
  });

  it("WARNS when vec_chunks is missing active embeddings at the configured width (the empty dense index)", async () => {
    const r = await run({
      ...base,
      activeEmbeddings: 16882,
      activeAtConfiguredWidth: 16882,
      vecRows: 0,
    });
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("missing 16882 of 16882");
  });

  it("points at a re-embed when the missing rows are active at another width", async () => {
    const r = await run({ ...base, activeEmbeddings: 10, activeAtConfiguredWidth: 4, vecRows: 0 });
    expect(r.status).toBe("warning");
    expect(r.remediation).toContain("different width/model");
  });

  it("WARNS on surplus vec_chunks rows too", async () => {
    const r = await run({ ...base, vecRows: 12 });
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("2 more row(s)");
  });

  it("reports a failed probe as a warning, not a clean bill", async () => {
    expect((await run({ ...base, error: "database is locked" })).status).toBe("warning");
  });
});

describe("probeEmbeddingIntegrity against a real cache.db", () => {
  const seedStore = async (dir: string, upTo: number) => {
    const db = await openDatabase(join(dir, "cache.db"));
    runMigrations(db, CACHE_MIGRATIONS.slice(0, upTo));
    return db;
  };
  const seed = (db: Awaited<ReturnType<typeof openDatabase>>) => {
    for (const id of ["c1", "c2"])
      db.prepare(
        `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash,
                             token_count, created_at, updated_at)
         VALUES (?, 'v1', ?, '0', '[]', 'c', ?, 1, 0, 0)`,
      ).run(id, `${id}.md`, `h-${id}`);
    const emb = db.prepare(
      `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
       VALUES (?, ?, ?, ?, 1, 0)`,
    );
    emb.run("c1", "m:good", 16, Buffer.alloc(16 * 4));
    emb.run("c2", "m:good", 16, Buffer.alloc(16 * 4));
    return emb;
  };

  it("returns undefined when no cache.db exists yet", async () => {
    const dir = makeTempDir("obtc-1160-doc-");
    try {
      expect(await probeEmbeddingIntegrity(dir, 16, 5_000)).toBeUndefined();
    } finally {
      rmTemp(dir);
    }
  });

  it("counts active embeddings at the configured width and finds none double-active on the current schema", async () => {
    const dir = makeTempDir("obtc-1160-doc-");
    try {
      const db = await seedStore(dir, CACHE_MIGRATIONS.length);
      const emb = seed(db);
      // The unique index refuses the second active row outright on the current schema.
      expect(() => emb.run("c1", "m:other", 8, Buffer.alloc(8 * 4))).toThrow();
      db.close?.();
      const s = await probeEmbeddingIntegrity(dir, 16, 5_000);
      expect(s).toMatchObject({
        activeEmbeddings: 2,
        activeAtConfiguredWidth: 2,
        multiActiveChunks: 0,
      });
    } finally {
      rmTemp(dir);
    }
  });

  it("finds a double-active chunk left by an older build and names its models", async () => {
    const dir = makeTempDir("obtc-1160-doc-");
    try {
      const db = await seedStore(dir, CACHE_MIGRATIONS.length - 1); // before the unique index
      const emb = seed(db);
      emb.run("c1", "m:other", 8, Buffer.alloc(8 * 4));
      db.close?.();
      const s = await probeEmbeddingIntegrity(dir, 16, 5_000);
      expect(s?.activeEmbeddings).toBe(3);
      expect(s?.activeAtConfiguredWidth).toBe(2);
      expect(s?.multiActiveChunks).toBe(1);
      expect(s?.multiActiveSamples[0]).toMatch(/^c1: m:(good, m:other|other, m:good)$/);
      const r = await embeddingIntegrityCheck({ probe: () => s }).run(ctx);
      expect(r.status).toBe("fail");
    } finally {
      rmTemp(dir);
    }
  });
});
