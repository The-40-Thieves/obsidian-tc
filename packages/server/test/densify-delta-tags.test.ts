// THE-486: tag-cooccurrence delta correctness — real end-to-end (no mocking needed; shared_tag never
// touches sqlite-vec). Covers the ticket's required traps for this layer: tag-set changes affecting
// every note sharing the OLD or NEW tags, deletion, and the empty-delta clean no-op — plus the
// identical-to-full-recompute regression check (run the FULL path again right after the delta and
// assert it finds nothing left to change: that is only possible if the two produce the same edges).
import { describe, expect, it } from "vitest";
import {
  countDerivedEdges,
  reconcileDerivedEdges,
  tagCooccurrenceEdges,
} from "../src/search/derived-edges";
import { indexVault, readNoteTags } from "../src/search/indexer";
import { makeM2Vault } from "./m2-helpers";

function sharedTagRows(
  v: ReturnType<typeof makeM2Vault>,
): Array<{ source_path: string; target_path: string }> {
  return v.db
    .prepare(
      "SELECT source_path, target_path FROM vault_edges WHERE vault_id = ? AND edge_type = 'shared_tag' ORDER BY source_path, target_path",
    )
    .all(v.id) as Array<{ source_path: string; target_path: string }>;
}

/** Runs the FULL recompute path (the old always-full behaviour) immediately after a delta pass and
 *  asserts it finds NOTHING left to insert or delete — the direct proof that the delta pass already
 *  converged to exactly what a full recompute would have produced. */
function assertMatchesFullRecompute(v: ReturnType<typeof makeM2Vault>): void {
  const full = tagCooccurrenceEdges(readNoteTags(v.db, v.id), { maxTagFanout: 25 });
  const stats = reconcileDerivedEdges(v.db, v.id, full, ["shared_tag"], () => Date.now());
  expect(stats.inserted).toBe(0);
  expect(stats.deleted).toBe(0);
}

describe("THE-486 tag-cooccurrence delta — end to end via indexVault", () => {
  it("cold start builds the full graph; a warm zero-change pass leaves it byte-for-byte identical", async () => {
    const v = makeM2Vault({
      files: {
        "a.md": "---\ntags: [ml]\n---\nalpha",
        "b.md": "---\ntags: [ml]\n---\nbeta",
        "c.md": "---\ntags: [ml]\n---\ngamma",
        "d.md": "---\ntags: [rag]\n---\ndelta",
      },
    });
    const args = {
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      densify: { tagEdges: true },
    };
    await indexVault(args); // cold start
    const baseline = sharedTagRows(v);
    expect(baseline.map((r) => `${r.source_path}-${r.target_path}`)).toEqual([
      "a.md-b.md",
      "a.md-c.md",
      "b.md-c.md",
    ]);
    assertMatchesFullRecompute(v);

    await indexVault(args); // warm, nothing changed on disk
    // THE-486 acceptance criterion: an empty delta is a clean no-op, not a skip that silently diverges
    // from what the full path would have left — the table must be EXACTLY the same afterward.
    expect(sharedTagRows(v)).toEqual(baseline);
    v.cleanup();
  });

  it("a note gaining a shared tag creates edges to every note ALREADY carrying it", async () => {
    const v = makeM2Vault({
      files: {
        "a.md": "---\ntags: [ml]\n---\nalpha",
        "b.md": "---\ntags: [ml]\n---\nbeta",
        "c.md": "---\ntags: [ml]\n---\ngamma",
        "d.md": "---\ntags: [rag]\n---\ndelta",
      },
    });
    const args = {
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      densify: { tagEdges: true },
    };
    await indexVault(args);
    v.write("d.md", "---\ntags: [ml]\n---\ndelta"); // d.md joins the "ml" cluster
    await indexVault(args);
    const rows = sharedTagRows(v).map((r) => `${r.source_path}-${r.target_path}`);
    expect(rows).toEqual([
      "a.md-b.md",
      "a.md-c.md",
      "a.md-d.md",
      "b.md-c.md",
      "b.md-d.md",
      "c.md-d.md",
    ]);
    assertMatchesFullRecompute(v);
    v.cleanup();
  });

  it("a note LOSING its only shared tag drops edges to every note that shared it — others untouched", async () => {
    const v = makeM2Vault({
      files: {
        "a.md": "---\ntags: [ml]\n---\nalpha",
        "b.md": "---\ntags: [ml]\n---\nbeta",
        "c.md": "---\ntags: [ml]\n---\ngamma",
      },
    });
    const args = {
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      densify: { tagEdges: true },
    };
    await indexVault(args);
    v.write("a.md", "---\ntags: [unrelated]\n---\nalpha"); // a.md drops "ml" entirely
    await indexVault(args);
    const rows = sharedTagRows(v).map((r) => `${r.source_path}-${r.target_path}`);
    // b-c still share "ml" and were NEVER in scope's desired-recompute boundary in a way that could
    // drop them; a's edges to both are gone.
    expect(rows).toEqual(["b.md-c.md"]);
    assertMatchesFullRecompute(v);
    v.cleanup();
  });

  it("deleting a note entirely drops its shared_tag edges in both directions", async () => {
    const v = makeM2Vault({
      files: {
        "a.md": "---\ntags: [ml]\n---\nalpha",
        "b.md": "---\ntags: [ml]\n---\nbeta",
        "c.md": "---\ntags: [ml]\n---\ngamma",
      },
    });
    const args = {
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      densify: { tagEdges: true },
    };
    await indexVault(args);
    const { unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    unlinkSync(join(v.root, "a.md"));
    await indexVault(args);
    const rows = sharedTagRows(v).map((r) => `${r.source_path}-${r.target_path}`);
    expect(rows).toEqual(["b.md-c.md"]);
    expect(countDerivedEdges(v.db, v.id, "shared_tag")).toBe(1);
    assertMatchesFullRecompute(v);
    v.cleanup();
  });
});
