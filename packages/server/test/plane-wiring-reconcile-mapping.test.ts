// THE-1073 — reconcileResultsForVault (runtime/plane-wiring.ts): turning one vault's completed
// IndexStats into this pass's ReconcileResult entries.
//
// Before this ticket, plane-wiring.ts's reconcile mapping produced AT MOST one ReconcileResult per
// vault (embed failures only), so health.index.detail.reconcile_errors could never name more than
// one bad path per vault even when several notes failed. This pins the fix: one entry PER
// frontmatter failure, plus the existing embed-failure summary when present — and, folded through
// applyReconcileOutcome, that a later clean pass still clears health back to "ok".
import { describe, expect, it } from "vitest";
import { reconcileResultsForVault } from "../src/runtime/plane-wiring";
import { applyReconcileOutcome, type ReconcileHealth } from "../src/runtime/reconcile-outcome";
import type { IndexStats } from "../src/search/indexer";

const NOW = 1_800_000_000_000;

function health(): ReconcileHealth {
  return { reconcile: "pending", reconcileAt: null, reconcileErrors: [] };
}

/** A clean IndexStats, overridable per test — every field IndexStats requires, at its zero value. */
function stats(over: Partial<IndexStats> = {}): IndexStats {
  return {
    notes_seen: 0,
    notes_indexed: 0,
    chunks_upserted: 0,
    chunks_deleted: 0,
    chunks_unchanged: 0,
    edges_inserted: 0,
    edges_deleted: 0,
    secrets_skipped: 0,
    vec_enabled: true,
    fts_enabled: true,
    notes_upserted: 0,
    notes_deleted: 0,
    notes_embed_failed: 0,
    chunks_dedup_reused: 0,
    chunks_dedup_unresolved: 0,
    embed_batch_rejections: 0,
    notes_stale_skipped: 0,
    notes_frontmatter_failed: 0,
    frontmatter_failures: [],
    model: "fake",
    dimensions: 8,
    ...over,
  };
}

describe("reconcileResultsForVault (THE-1073)", () => {
  it("yields no results for a fully clean pass", () => {
    expect(reconcileResultsForVault("v1", stats())).toEqual([]);
  });

  it("yields one result per frontmatter failure, verbatim message, in order, tagged kind: frontmatter", () => {
    const s = stats({
      notes_frontmatter_failed: 2,
      frontmatter_failures: [
        { path: "a.md", error: 'frontmatter is not valid YAML in "a.md": bad indentation' },
        { path: "b.md", error: 'frontmatter is not valid YAML in "b.md": unexpected token' },
      ],
    });
    expect(reconcileResultsForVault("v1", s)).toEqual([
      {
        vault: "v1",
        error: 'frontmatter is not valid YAML in "a.md": bad indentation',
        kind: "frontmatter",
      },
      {
        vault: "v1",
        error: 'frontmatter is not valid YAML in "b.md": unexpected token',
        kind: "frontmatter",
      },
    ]);
  });

  it("appends the embed-failure summary alongside frontmatter failures, not instead of them", () => {
    const s = stats({
      notes_frontmatter_failed: 1,
      frontmatter_failures: [
        { path: "a.md", error: 'frontmatter is not valid YAML in "a.md": bad indentation' },
      ],
      notes_embed_failed: 3,
    });
    const results = reconcileResultsForVault("v1", s);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      vault: "v1",
      error: 'frontmatter is not valid YAML in "a.md": bad indentation',
      kind: "frontmatter",
    });
    expect(results[1]?.error).toContain("3 note(s) skipped: embed provider rejected");
    expect(results[1]?.kind).toBe("embed");
  });

  // THE-1073 fix round 1 (LOW): a per-vault ceiling so a templated bulk import of hundreds of bad
  // notes cannot turn one reconcile into hundreds of stderr lines / a huge server_health payload.
  it("caps at 10 frontmatter entries: exactly 10 failures yields 10 entries, no summary", () => {
    const failures = Array.from({ length: 10 }, (_, i) => ({
      path: `n${i}.md`,
      error: `frontmatter is not valid YAML in "n${i}.md": bad`,
    }));
    const s = stats({ notes_frontmatter_failed: 10, frontmatter_failures: failures });
    const results = reconcileResultsForVault("v1", s);
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.kind === "frontmatter")).toBe(true);
    expect(results.some((r) => r.error?.startsWith("...and"))).toBe(false);
  });

  it("caps at 10 frontmatter entries: 11 failures yields 11 entries, the LAST is the summary", () => {
    const failures = Array.from({ length: 11 }, (_, i) => ({
      path: `n${i}.md`,
      error: `frontmatter is not valid YAML in "n${i}.md": bad`,
    }));
    const s = stats({ notes_frontmatter_failed: 11, frontmatter_failures: failures });
    const results = reconcileResultsForVault("v1", s);
    expect(results).toHaveLength(11);
    expect(results.slice(0, 10).map((r) => r.error)).toEqual(
      failures.slice(0, 10).map((f) => f.error),
    );
    expect(results[10]?.error).toBe(
      "...and 1 more note(s) with invalid frontmatter (see index_vault stats / doctor --probe)",
    );
    expect(results[10]?.kind).toBe("frontmatter");
  });

  it("folded through applyReconcileOutcome: degrades with one error per path, then clears on a clean pass", () => {
    const h = health();
    const written: string[] = [];
    const deps = { now: () => NOW, write: (m: string) => written.push(m) };

    const badPass = [
      reconcileResultsForVault(
        "v1",
        stats({
          notes_frontmatter_failed: 2,
          frontmatter_failures: [
            { path: "a.md", error: 'frontmatter is not valid YAML in "a.md": bad indentation' },
            { path: "b.md", error: 'frontmatter is not valid YAML in "b.md": unexpected token' },
          ],
          notes_embed_failed: 1,
        }),
      ),
      reconcileResultsForVault("v2", stats()),
    ].flat();

    applyReconcileOutcome(badPass, h, deps);
    expect(h.reconcile).toBe("degraded");
    // Every failing path names itself — not just the first.
    expect(h.reconcileErrors).toHaveLength(3);
    expect(h.reconcileErrors.map((e) => e.error).join(" ")).toContain("a.md");
    expect(h.reconcileErrors.map((e) => e.error).join(" ")).toContain("b.md");
    // The frontmatter hint, not the embeddings-backend one, for a frontmatter error.
    const frontmatterLine = written.find((w) => w.includes("a.md"));
    expect(frontmatterLine).toContain("fix the note's YAML frontmatter");

    // A LATER, clean pass clears health back to ok — the recovery case reconcile-outcome.test.ts
    // already pins, exercised here through the real mapping function instead of a hand-built
    // ReconcileResult array.
    const cleanPass = [
      reconcileResultsForVault("v1", stats()),
      reconcileResultsForVault("v2", stats()),
    ].flat();
    applyReconcileOutcome(cleanPass, h, deps);
    expect(h.reconcile).toBe("ok");
    expect(h.reconcileErrors).toEqual([]);
  });
});
