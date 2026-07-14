// THE-258 — the class router. Pins the precision-first classification rules (temporal intent,
// quoted phrase, corpus-rare term via live df; everything else standard — a silent router
// equals the static engine) and the lexical short-circuit's shape/ACL/positional-score
// contract.
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { lexicalRouteResults, routeQuery } from "../src/search/router";
import { openMemoryDb } from "./helpers";

const NOW = 1_700_000_000_000;

function db0() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const ins = db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, '0', '[]', ?, ?, 10, ?, ?)",
  );
  const common = "vault search notes retrieval system overview";
  for (let i = 0; i < 5; i++) {
    ins.run(`c${i}`, `notes/common-${i}.md`, `${common} number ${i}`, `h${i}`, NOW, NOW);
  }
  ins.run("rare", "notes/rare.md", "the zylophrastic reconciler pattern explained", "hr", NOW, NOW);
  ensureChunkFts(db, { now: () => NOW, enrich: false });
  return db;
}

describe("class router (THE-258)", () => {
  it("temporal intent routes temporal", () => {
    const db = db0();
    const r = routeQuery(db, "main", "what did I decide in March 2026", { nowMs: NOW });
    expect(r.class).toBe("temporal");
    expect(r.signals).toContain("temporal-intent");
  });

  it("quoted phrase routes lexical", () => {
    const db = db0();
    const r = routeQuery(db, "main", 'find "reconciler pattern" mentions', { nowMs: NOW });
    expect(r.class).toBe("lexical");
    expect(r.signals).toContain("quoted-phrase");
  });

  it("short query with a corpus-rare term routes lexical; common terms stay standard", () => {
    const db = db0();
    const rare = routeQuery(db, "main", "zylophrastic reconciler", { nowMs: NOW });
    expect(rare.class).toBe("lexical");
    expect(rare.signals.some((s) => s.startsWith("rare-term:zylophrastic"))).toBe(true);

    const common = routeQuery(db, "main", "vault search notes", { nowMs: NOW });
    expect(common.class).toBe("standard");
  });

  it("absent terms (df=0) and long queries stay standard (precision-first)", () => {
    const db = db0();
    expect(routeQuery(db, "main", "qqnonexistenttoken here", { nowMs: NOW }).class).toBe(
      "standard",
    );
    expect(
      routeQuery(
        db,
        "main",
        "please find the zylophrastic reconciler pattern in my notes quickly",
        { nowMs: NOW },
      ).class,
    ).toBe("standard");
  });

  it("lexicalRouteResults: graph-shaped hits, ACL filter, positional scores, k cap", () => {
    const db = db0();
    const hits = lexicalRouteResults(db, "main", "zylophrastic", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      path: "notes/rare.md",
      source: "lexical",
      hop: 0,
      via_edge: null,
      rerank_score: 1,
    });

    const filtered = lexicalRouteResults(
      db,
      "main",
      "zylophrastic",
      10,
      (p) => p !== "notes/rare.md",
    );
    expect(filtered).toHaveLength(0);

    const capped = lexicalRouteResults(db, "main", "vault search", 2);
    expect(capped).toHaveLength(2);
    expect(capped[0]?.rerank_score).toBe(1);
    expect(capped[1]?.rerank_score).toBe(0.5);
  });
});
