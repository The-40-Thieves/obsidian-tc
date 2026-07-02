import { describe, expect, it } from "vitest";
import { type MetaRow, selectVisible } from "../src/search/semantic";

const meta = (id: string, path: string): readonly [string, MetaRow & { id: string }] =>
  [id, { id, path, content: `c-${id}`, vault_id: "v1", model: "m" }] as const;

describe("selectVisible — THE-287 vec0 candidate visibility filter", () => {
  it("drops candidates whose note is not read-visible, preserving distance order", () => {
    const candidates = [
      { chunk_id: "a", distance: 0.1 },
      { chunk_id: "b", distance: 0.2 }, // denied folder
      { chunk_id: "c", distance: 0.3 },
    ];
    const metaById = new Map([
      meta("a", "public/a.md"),
      meta("b", "secret/b.md"),
      meta("c", "public/c.md"),
    ]);
    const out = selectVisible(candidates, metaById, (p) => p.startsWith("public/"), {}, 5);
    expect(out.map((h) => h.path)).toEqual(["public/a.md", "public/c.md"]);
    expect(out.map((h) => h.chunk_id)).toEqual(["a", "c"]);
  });

  it("skips candidates absent from the vault-scoped metadata (other vaults) and caps at k", () => {
    const candidates = [
      { chunk_id: "a", distance: 0.1 },
      { chunk_id: "x", distance: 0.15 }, // other vault: absent from metaById (scoped by SQL)
      { chunk_id: "b", distance: 0.2 },
      { chunk_id: "c", distance: 0.3 },
    ];
    const metaById = new Map([meta("a", "a.md"), meta("b", "b.md"), meta("c", "c.md")]);
    const out = selectVisible(candidates, metaById, () => true, {}, 2);
    expect(out.map((h) => h.chunk_id)).toEqual(["a", "b"]);
  });

  it("applies minScore over score = 1 - distance", () => {
    const candidates = [
      { chunk_id: "a", distance: 0.1 }, // 0.9
      { chunk_id: "b", distance: 0.7 }, // 0.3 -> below minScore
    ];
    const metaById = new Map([meta("a", "a.md"), meta("b", "b.md")]);
    const out = selectVisible(candidates, metaById, () => true, { minScore: 0.5 }, 5);
    expect(out.map((h) => h.chunk_id)).toEqual(["a"]);
  });

  it("crowding: when visible hits are fewer than k, the caller's out is short (triggers fallback)", () => {
    // All but one candidate denied -> selectVisible returns 1; semanticSearch compares to k and,
    // when the candidate set was capped, falls back to the exhaustive brute-force scan.
    const candidates = Array.from({ length: 40 }, (_, i) => ({
      chunk_id: `d${i}`,
      distance: i / 100,
    }));
    const metaById = new Map(
      candidates.map((c, i) => meta(c.chunk_id, i === 39 ? "public/ok.md" : "secret/x.md")),
    );
    const out = selectVisible(candidates, metaById, (p) => p.startsWith("public/"), {}, 10);
    expect(out.map((h) => h.path)).toEqual(["public/ok.md"]);
    expect(out.length).toBeLessThan(10); // < k -> semanticSearch would fall back to brute force
  });
});
