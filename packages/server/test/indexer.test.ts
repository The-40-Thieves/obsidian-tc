import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { blobToFloats } from "../src/search/vec";
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
});
