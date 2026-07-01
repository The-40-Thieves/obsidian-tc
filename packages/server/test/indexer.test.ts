import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/types";
import { indexNote, indexVault } from "../src/search/indexer";
import { blobToFloats, loadVec } from "../src/search/vec";
import { makeM2Vault } from "./m2-helpers";

interface EmbRow {
  chunk_id: string;
  dimensions: number;
  embedding: Uint8Array;
}

function data(res: ToolResult): Record<string, number | boolean | string> {
  return (res.ok ? res.data : {}) as Record<string, number | boolean | string>;
}

describe("index_vault (incremental chunk + embed)", () => {
  it("chunks and embeds notes, persisting chunks + embeddings", async () => {
    const v = makeM2Vault({
      files: {
        "a.md": "# Alpha\n\nThe quick brown fox.",
        "b.md": "# Beta\n\nThe lazy dog sleeps.",
      },
    });
    const res = await v.call("index_vault", { vault: "test" });
    expect(res.ok).toBe(true);
    const d = data(res);
    expect(d.notes_seen).toBe(2);
    expect(d.chunks_upserted).toBe(2);
    expect(d.chunks_unchanged).toBe(0);
    expect(d.vec_enabled).toBe(false); // node:sqlite cannot load the extension

    const chunks = v.db.prepare("SELECT count(*) c FROM chunks").get() as { c: number };
    const embs = v.db.prepare("SELECT count(*) c FROM chunk_embeddings").get() as { c: number };
    expect(chunks.c).toBe(2);
    expect(embs.c).toBe(2);

    const emb = v.db
      .prepare("SELECT chunk_id, dimensions, embedding FROM chunk_embeddings LIMIT 1")
      .get() as EmbRow;
    expect(emb.dimensions).toBe(32);
    expect(blobToFloats(emb.embedding)).toHaveLength(32);
    v.cleanup();
  });

  it("refuses under a read-only ACL (E3/D6)", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nbody" }, acl: { readOnly: true } });
    const res = await v.call("index_vault", { vault: "test" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("read_only");
    v.cleanup();
  });

  it("skips unchanged chunks on re-index and re-embeds a changed note", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nfirst body" } });
    await v.call("index_vault", { vault: "test" });

    const again = data(await v.call("index_vault", { vault: "test" }));
    expect(again.chunks_upserted).toBe(0);
    expect(again.chunks_unchanged).toBe(1);

    v.write("a.md", "# A\n\nrewritten body");
    const third = data(await v.call("index_vault", { vault: "test" }));
    expect(third.chunks_upserted).toBe(1);
    v.cleanup();
  });

  it("prunes chunks that no longer exist after a note shrinks", async () => {
    const v = makeM2Vault({ files: { "a.md": "# H1\n\none\n\n# H2\n\ntwo" } });
    expect(data(await v.call("index_vault", { vault: "test" })).chunks_upserted).toBe(2);

    v.write("a.md", "# H1\n\none");
    const second = data(await v.call("index_vault", { vault: "test" }));
    expect(second.chunks_deleted).toBe(1);
    expect((v.db.prepare("SELECT count(*) c FROM chunks").get() as { c: number }).c).toBe(1);
    v.cleanup();
  });

  it("honors the read ACL — notes outside readPaths are not indexed", async () => {
    const v = makeM2Vault({
      files: {
        "pub/a.md": "# Public\n\nvisible",
        "secret/b.md": "# Secret\n\nhidden",
      },
      acl: { readPaths: ["pub/**"] },
    });
    expect(data(await v.call("index_vault", { vault: "test" })).notes_seen).toBe(1);
    const paths = (
      v.db.prepare("SELECT DISTINCT path FROM chunks").all() as Array<{ path: string }>
    ).map((r) => r.path);
    expect(paths).toEqual(["pub/a.md"]);
    v.cleanup();
  });

  it("writes an audit row for the dispatch", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nbody" } });
    await v.call("index_vault", { vault: "test" });
    const ev = v.db
      .prepare("SELECT tool_name, status FROM event_log ORDER BY id DESC LIMIT 1")
      .get() as { tool_name: string; status: string };
    expect(ev.tool_name).toBe("index_vault");
    expect(ev.status).toBe("ok");
    v.cleanup();
  });

  it("rolls back the whole note write when an insert fails mid-transaction (P1 atomicity)", async () => {
    const v = makeM2Vault({ files: { "a.md": "# H1\n\none\n\n# H2\n\ntwo" } });
    expect(data(await v.call("index_vault", { vault: "test" })).chunks_upserted).toBe(2);

    const snapshot = v.db
      .prepare("SELECT id, content_hash FROM chunks ORDER BY id")
      .all() as Array<{ id: string; content_hash: string }>;
    const embCount = (): number =>
      (v.db.prepare("SELECT count(*) c FROM chunk_embeddings").get() as { c: number }).c;
    const beforeEmbs = embCount();

    // A db view that throws when the chunk_embeddings INSERT runs — i.e. mid-transaction, after
    // the prune DELETEs and the chunks INSERT have already executed.
    const failing: Database = {
      exec: (sql) => v.db.exec(sql),
      prepare: (sql) => {
        const st = v.db.prepare(sql);
        if (sql.startsWith("INSERT INTO chunk_embeddings")) {
          return {
            ...st,
            run: () => {
              throw new Error("boom: chunk_embeddings insert failed");
            },
          };
        }
        return st;
      },
    };

    // Re-index the same note with changed content: prunes the H2 chunk and re-embeds the changed
    // H1 chunk, then the embedding insert throws -> ROLLBACK must undo prune + chunk upsert.
    await expect(
      indexNote(failing, v.provider, v.id, "a.md", "# H1\n\none-changed", false, () => 1),
    ).rejects.toThrow(/chunk_embeddings/);

    const after = v.db.prepare("SELECT id, content_hash FROM chunks ORDER BY id").all() as Array<{
      id: string;
      content_hash: string;
    }>;
    expect(after).toEqual(snapshot);
    expect(embCount()).toBe(beforeEmbs);
    v.cleanup();
  });

  it("loadVec loads the extension once per connection (P3 memo)", () => {
    let loads = 0;
    let versionProbes = 0;
    const db: Database = {
      exec: () => {},
      prepare: (sql) => ({
        run: () => ({ changes: 0 }),
        get: () => {
          if (sql.includes("vec_version")) versionProbes += 1;
          return { v: 1 };
        },
        all: () => [],
      }),
      loadExtension: () => {
        loads += 1;
      },
    };
    const first = loadVec(db);
    expect(loadVec(db)).toBe(first);
    if (first) {
      expect(loads).toBe(1);
      expect(versionProbes).toBe(1);
    }
  });

  it("indexVault applies a batch of notes in a single transaction (P2)", async () => {
    const v = makeM2Vault({
      files: { "a.md": "# A\n\nalpha", "b.md": "# B\n\nbeta", "c.md": "# C\n\ngamma" },
    });
    let begins = 0;
    const counting: Database = {
      exec: (sql) => {
        if (sql === "BEGIN") begins += 1;
        v.db.exec(sql);
      },
      prepare: (sql) => v.db.prepare(sql),
    };
    await indexVault({
      db: counting,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    });
    // One batch (3 < BATCH), so one transaction — not one per note.
    expect(begins).toBe(1);
    expect((v.db.prepare("SELECT count(*) c FROM chunks").get() as { c: number }).c).toBe(3);
    v.cleanup();
  });

  it("rolls back the entire batch when one note's apply fails mid-transaction (P2)", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nalpha", "b.md": "# B\n\nbeta" } });
    let embInserts = 0;
    const failing: Database = {
      exec: (sql) => v.db.exec(sql),
      prepare: (sql) => {
        const st = v.db.prepare(sql);
        if (sql.startsWith("INSERT INTO chunk_embeddings")) {
          return {
            ...st,
            run: (...params: unknown[]) => {
              embInserts += 1;
              if (embInserts >= 2) throw new Error("boom: chunk_embeddings insert failed");
              return st.run(...params);
            },
          };
        }
        return st;
      },
    };
    await expect(
      indexVault({
        db: failing,
        provider: v.provider,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
      }),
    ).rejects.toThrow(/chunk_embeddings/);
    // The whole batch rolled back: neither note committed a chunk.
    expect((v.db.prepare("SELECT count(*) c FROM chunks").get() as { c: number }).c).toBe(0);
    v.cleanup();
  });

  it("a fully-unchanged re-index opens no transaction (P2)", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nalpha" } });
    await indexVault({
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    });
    let begins = 0;
    const counting: Database = {
      exec: (sql) => {
        if (sql === "BEGIN") begins += 1;
        v.db.exec(sql);
      },
      prepare: (sql) => v.db.prepare(sql),
    };
    await indexVault({
      db: counting,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    });
    // Nothing changed -> empty batch -> no BEGIN.
    expect(begins).toBe(0);
    v.cleanup();
  });
});
