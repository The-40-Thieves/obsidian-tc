// THE-602: branch-coverage tests for src/tools/m1/graph-health-tools.ts.
// Each test asserts real caller-visible behavior (a returned value, an error code, or an
// ordering) at a specific uncovered branch from the coverage-final.json baseline — never a
// bare "it ran". See the branch ids called out in each test's comment.
import { describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";

describe("THE-602 graph-health-tools branch coverage", () => {
  describe("vault_health_score on an empty vault (lines 231-233, ratio-guard cond-exprs)", () => {
    it("scores a perfect 100 with zero notes and zero links, not NaN from a 0/0 ratio", async () => {
      const v = makeTestVault({ files: {} });
      try {
        const r = await v.call("vault_health_score", { vault: "test" });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as { score: number; total_notes: number; total_links: number };
          expect(d.total_notes).toBe(0);
          expect(d.total_links).toBe(0);
          expect(d.score).toBe(100);
        }
      } finally {
        v.cleanup();
      }
    });
  });

  describe("isExternal (line 28, branch 0.1) + buildLinkGraph skip-continues (lines 62-64, branches 6.0/7.0/8.0)", () => {
    it("counts an internal link but excludes a code-block link, an external markdown link, and a bare heading link from total_links", async () => {
      const v = makeTestVault({
        files: {
          // one real internal link (a -> b), one link inside a fenced code block (skipped,
          // branch 6.0 true), one external markdown link (skipped, branch 7.0 true / isExternal
          // both operands true), and a same-note heading link with empty target (skipped,
          // branch 8.0 true via the target==="" / startsWith("#") arm).
          "a.md": [
            "[[b]]",
            "```",
            "[[b]]",
            "```",
            "[external](https://example.com/x)",
            "[heading](#section)",
          ].join("\n"),
          "b.md": "no links",
        },
      });
      try {
        const r = await v.call("vault_health_score", { vault: "test" });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as { total_links: number; metrics: { unresolved_links: number } };
          // Only the one real wikilink counts; the fenced, external, and heading-only links
          // never reach `links++`.
          expect(d.total_links).toBe(1);
          expect(d.metrics.unresolved_links).toBe(0);
        }
      } finally {
        v.cleanup();
      }
    });

    it("does not treat a wikilink as external (isExternal short-circuits on kind !== 'markdown', branch 0.1 first operand false)", async () => {
      const v = makeTestVault({
        files: {
          // A wikilink target that happens to look URL-like must still resolve/unresolve
          // through the normal path, not be skipped as external.
          "a.md": "[[https://not-a-note]]",
          "b.md": "x",
        },
      });
      try {
        const r = await v.call("vault_health_score", { vault: "test" });
        if (r.ok) {
          const d = r.data as { total_links: number; metrics: { unresolved_links: number } };
          // Counted as a link attempt (not skipped as external) and fails to resolve.
          expect(d.total_links).toBe(1);
          expect(d.metrics.unresolved_links).toBe(1);
        }
      } finally {
        v.cleanup();
      }
    });

    it("does not treat an internal markdown link as external (isExternal second operand false)", async () => {
      const v = makeTestVault({
        files: {
          "a.md": "[link](b.md)",
          "b.md": "x",
        },
      });
      try {
        const r = await v.call("vault_health_score", { vault: "test" });
        if (r.ok) {
          const d = r.data as { total_links: number; metrics: { orphans: number } };
          expect(d.total_links).toBe(1);
          // Only "a" is an orphan (nothing links to it); "b" is linked-to by "a", so the
          // internal markdown link was NOT skipped as external.
          expect(d.metrics.orphans).toBe(1);
        }
      } finally {
        v.cleanup();
      }
    });
  });

  describe("fmHas null/whitespace handling (lines 35-36, branches 3.0/4.0)", () => {
    it("treats an explicit-null frontmatter value as missing provenance", async () => {
      const NL = String.fromCharCode(10);
      // `sources:` with nothing after it parses to YAML null — key present, value null.
      const nullVal = ["---", "sources:", "---", "claim"].join(NL);
      const v = makeTestVault({ files: { "claim.md": nullVal } });
      try {
        const r = await v.call("audit_provenance", { vault: "test" });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as { with_provenance: number; missing: string[] };
          expect(d.with_provenance).toBe(0);
          expect(d.missing).toContain("claim.md");
        }
      } finally {
        v.cleanup();
      }
    });

    it("treats a whitespace-only string frontmatter value as missing provenance", async () => {
      const NL = String.fromCharCode(10);
      const blankVal = ["---", 'sources: "   "', "---", "claim"].join(NL);
      const v = makeTestVault({ files: { "claim.md": blankVal } });
      try {
        const r = await v.call("audit_provenance", { vault: "test" });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as { with_provenance: number; missing: string[] };
          expect(d.with_provenance).toBe(0);
          expect(d.missing).toContain("claim.md");
        }
      } finally {
        v.cleanup();
      }
    });
  });

  describe("findCycles bound (lines 84/88/101, branches 13.0/15.0/20.0)", () => {
    it("stops enumerating once `limit` cycles are found even when more cycles exist", async () => {
      const v = makeTestVault({
        files: {
          // Two independent 2-cycles: a<->b and c<->d.
          "a.md": "[[b]]",
          "b.md": "[[a]]",
          "c.md": "[[d]]",
          "d.md": "[[c]]",
        },
      });
      try {
        const r = await v.call("find_link_cycles", { vault: "test", limit: 1 });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as { total: number; cycles: string[][] };
          expect(d.total).toBe(1);
          expect(d.cycles.length).toBe(1);
        }
      } finally {
        v.cleanup();
      }
    });

    it("a reconverging DAG (diamond, no back-edge) reports zero cycles (branch 19.1: cross-edge to an already-finished node)", async () => {
      // a -> b -> d and a -> c -> d: d is visited to completion via b, then reached again via c.
      // That second visit hits state===2 ("done"), not 1 ("on-stack") or 0 ("unseen") — the
      // implicit final-else arm — and must NOT be reported as a cycle.
      const v = makeTestVault({
        files: {
          "a.md": "[[b]] [[c]]",
          "b.md": "[[d]]",
          "c.md": "[[d]]",
          "d.md": "no outgoing links",
        },
      });
      try {
        const r = await v.call("find_link_cycles", { vault: "test" });
        expect(r.ok).toBe(true);
        if (r.ok) expect((r.data as { total: number }).total).toBe(0);
      } finally {
        v.cleanup();
      }
    });
  });

  describe("buildLinkGraph self-link (line 70, branch 12.1)", () => {
    it("does not count a note linking to itself as an edge or as unresolved", async () => {
      const v = makeTestVault({ files: { "a.md": "[[a]]" } });
      try {
        const r = await v.call("vault_health_score", { vault: "test" });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as {
            total_links: number;
            metrics: { unresolved_links: number; orphans: number };
          };
          // The link is extracted (links++ happens before resolution), resolves to itself, and
          // is silently dropped: not an edge (r.target_path === p) and not unresolved either.
          expect(d.total_links).toBe(1);
          expect(d.metrics.unresolved_links).toBe(0);
          expect(d.metrics.orphans).toBe(1); // still nothing links IN to a
        }
      } finally {
        v.cleanup();
      }
    });
  });

  describe("undirectedDistance (lines 187/198, branches 27.0/31.0)", () => {
    it("returns distance 0 when from === to", async () => {
      const v = makeTestVault({ files: { "a.md": "x" } });
      try {
        const r = await v.call("get_link_strength", { vault: "test", from: "a.md", to: "a.md" });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as { distance: number | null };
          expect(d.distance).toBe(0);
        }
      } finally {
        v.cleanup();
      }
    });

    it("finds the shortest distance through a diamond, re-visiting an already-seen node without double-counting it", async () => {
      // Undirected shape (via out+inn union): a-b, a-c, b-d, c-d. BFS from a reaches b and c at
      // dist 1; from both b and c it re-encounters "a" (already seen -> branch 31.0 false arm)
      // before reaching "d" (the target) at dist 2.
      const v = makeTestVault({
        files: {
          "a.md": "[[b]] [[c]]",
          "b.md": "[[a]] [[d]]",
          "c.md": "[[a]] [[d]]",
          "d.md": "x",
        },
      });
      try {
        const r = await v.call("get_link_strength", { vault: "test", from: "a.md", to: "d.md" });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as { distance: number | null };
          expect(d.distance).toBe(2);
        }
      } finally {
        v.cleanup();
      }
    });
  });

  describe("get_link_strength note-not-found + direct-edge directionality (lines 297-299, branches 37.0/38.0/39.1-3)", () => {
    it("errors note_not_found when `from` does not exist", async () => {
      const v = makeTestVault({ files: { "b.md": "x" } });
      try {
        const r = await v.call("get_link_strength", {
          vault: "test",
          from: "missing.md",
          to: "b.md",
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("note_not_found");
      } finally {
        v.cleanup();
      }
    });

    it("errors note_not_found when `to` does not exist (from exists)", async () => {
      const v = makeTestVault({ files: { "a.md": "x" } });
      try {
        const r = await v.call("get_link_strength", {
          vault: "test",
          from: "a.md",
          to: "missing.md",
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("note_not_found");
      } finally {
        v.cleanup();
      }
    });

    it("reports direct=true from the reverse edge alone (to -> from, no from -> to)", async () => {
      const v = makeTestVault({ files: { "a.md": "x", "b.md": "[[a]]" } });
      try {
        const r = await v.call("get_link_strength", { vault: "test", from: "a.md", to: "b.md" });
        expect(r.ok).toBe(true);
        if (r.ok) expect((r.data as { direct: boolean }).direct).toBe(true);
      } finally {
        v.cleanup();
      }
    });

    it("counts only the shared elements of a partial co-citation overlap, not the full smaller set (branch 26.1: an element of the smaller inbound set absent from the larger one)", async () => {
      // "from" is linked-in-from {shared, onlyFrom}, "to" is linked-in-from {shared, onlyTo} —
      // equal-size sets (so the tie-break picks the FIRST as "small") that partially overlap.
      // Iterating "small" must skip "onlyFrom" (absent from "big") rather than count it.
      const v = makeTestVault({
        files: {
          "shared.md": "[[from]] [[to]]",
          "onlyFrom.md": "[[from]]",
          "onlyTo.md": "[[to]]",
          "from.md": "x",
          "to.md": "y",
        },
      });
      try {
        const r = await v.call("get_link_strength", {
          vault: "test",
          from: "from.md",
          to: "to.md",
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect((r.data as { co_citation: number }).co_citation).toBe(1);
      } finally {
        v.cleanup();
      }
    });

    it("reports direct=false when neither note links to the other", async () => {
      const v = makeTestVault({ files: { "a.md": "x", "b.md": "y" } });
      try {
        const r = await v.call("get_link_strength", { vault: "test", from: "a.md", to: "b.md" });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as { direct: boolean; strength: number };
          expect(d.direct).toBe(false);
          expect(d.strength).toBe(0);
        }
      } finally {
        v.cleanup();
      }
    });
  });

  describe("suggest_links (lines 342/347/354-355/363, branches 43.0/45.0/50.0/51.0-1)", () => {
    it("surfaces a co-citation candidate: something a note's own inbound linker also links to (line 354-355 loop)", async () => {
      // "src" links to both "p" and "candidate" — from p's perspective, candidate is reachable
      // via co-citation (a shared inbound source), not via the two-hop outbound path.
      const v = makeTestVault({
        files: {
          "p.md": "nothing outbound",
          "src.md": "[[p]] [[candidate]]",
          "candidate.md": "x",
        },
      });
      try {
        const r = await v.call("suggest_links", { vault: "test", path: "p.md" });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as { suggestions: Array<{ path: string; co_citation: number }> };
          const candidate = d.suggestions.find((s) => s.path === "candidate.md");
          expect(candidate?.co_citation).toBe(1);
        }
      } finally {
        v.cleanup();
      }
    });

    it("errors note_not_found for a nonexistent source note", async () => {
      const v = makeTestVault({ files: { "b.md": "x" } });
      try {
        const r = await v.call("suggest_links", { vault: "test", path: "missing.md" });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("note_not_found");
      } finally {
        v.cleanup();
      }
    });

    it("excludes a candidate already directly linked, even though it would also score via two-hop", async () => {
      // x -> y -> z (two-hop candidate z), AND x -> z directly already. z must not appear in
      // suggestions because `already.has(c)` short-circuits it (branch 45.0 true arm).
      const v = makeTestVault({
        files: {
          "x.md": "[[y]] [[z]]",
          "y.md": "[[z]]",
          "z.md": "end",
        },
      });
      try {
        const r = await v.call("suggest_links", { vault: "test", path: "x.md" });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as { suggestions: Array<{ path: string }> };
          expect(d.suggestions.map((s) => s.path)).not.toContain("z.md");
        }
      } finally {
        v.cleanup();
      }
    });

    it("breaks a score tie by path (localeCompare), not discovery order", async () => {
      // p links to nbr1 and nbr2, both of which link only to "zeta" and "alpha" respectively —
      // each gets an equal two_hop score of 1, so the tie-break must order alpha before zeta.
      const v = makeTestVault({
        files: {
          "p.md": "[[nbr1]] [[nbr2]]",
          "nbr1.md": "[[zeta]]",
          "nbr2.md": "[[alpha]]",
          "zeta.md": "x",
          "alpha.md": "x",
        },
      });
      try {
        const r = await v.call("suggest_links", { vault: "test", path: "p.md" });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as { suggestions: Array<{ path: string; score: number }> };
          const alpha = d.suggestions.find((s) => s.path === "alpha.md");
          const zeta = d.suggestions.find((s) => s.path === "zeta.md");
          expect(alpha).toBeDefined();
          expect(zeta).toBeDefined();
          expect(alpha?.score).toBe(zeta?.score);
          const ia = d.suggestions.indexOf(alpha as (typeof d.suggestions)[number]);
          const iz = d.suggestions.indexOf(zeta as (typeof d.suggestions)[number]);
          expect(ia).toBeLessThan(iz);
        }
      } finally {
        v.cleanup();
      }
    });
  });

  describe("audit_provenance include filter (line 396, branches 53.0/54.1)", () => {
    it("restricts scope to include-matching notes, excluding non-matching ones", async () => {
      const v = makeTestVault({
        files: {
          "keep/claim.md": "no sources here",
          "skip/claim.md": "no sources here either",
        },
      });
      try {
        const r = await v.call("audit_provenance", { vault: "test", include: ["keep/**"] });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as { scanned: number; missing: string[] };
          expect(d.scanned).toBe(1);
          expect(d.missing).toEqual(["keep/claim.md"]);
        }
      } finally {
        v.cleanup();
      }
    });

    it("excludes everything when include is set but nothing matches", async () => {
      const v = makeTestVault({ files: { "a.md": "x", "b.md": "y" } });
      try {
        const r = await v.call("audit_provenance", { vault: "test", include: ["nomatch/**"] });
        expect(r.ok).toBe(true);
        if (r.ok) expect((r.data as { scanned: number }).scanned).toBe(0);
      } finally {
        v.cleanup();
      }
    });
  });

  describe("audit_provenance confidence/verified coverage (lines 416-417, branches 58.0/59.0)", () => {
    it("counts confidence and verified frontmatter fields into their coverage metrics", async () => {
      const NL = String.fromCharCode(10);
      const withBoth = [
        "---",
        "sources:",
        "  - x",
        "confidence: 0.9",
        "verified: true",
        "---",
        "c",
      ].join(NL);
      const withNeither = ["---", "sources:", "  - x", "---", "c"].join(NL);
      const v = makeTestVault({
        files: { "a.md": withBoth, "b.md": withNeither },
      });
      try {
        const r = await v.call("audit_provenance", { vault: "test" });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as { confidence_coverage: number; verified_coverage: number };
          expect(d.confidence_coverage).toBe(0.5);
          expect(d.verified_coverage).toBe(0.5);
        }
      } finally {
        v.cleanup();
      }
    });
  });

  describe("audit_provenance empty-scan guard (lines 428-430, branches 61.1/62.1/63.1)", () => {
    it("reports coverage=1 and confidence/verified=0 when zero notes are in scope", async () => {
      // The only note is excluded by the default 01-daily/** exclude glob, so `notes` is empty
      // and `scanned` is 0 — the ternaries must take their else-arm, not divide by zero.
      const v = makeTestVault({ files: { "01-daily/2026-07-27.md": "daily" } });
      try {
        const r = await v.call("audit_provenance", { vault: "test" });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as {
            scanned: number;
            coverage: number;
            confidence_coverage: number;
            verified_coverage: number;
          };
          expect(d.scanned).toBe(0);
          expect(d.coverage).toBe(1);
          expect(d.confidence_coverage).toBe(0);
          expect(d.verified_coverage).toBe(0);
        }
      } finally {
        v.cleanup();
      }
    });
  });

  describe("audit_provenance by_folder tie-break (line 433, branch 64.1)", () => {
    it("orders folders with an equal missing-count alphabetically", async () => {
      const v = makeTestVault({
        files: {
          // Both folders have exactly one note, and both are missing the sources field, so
          // `missing` counts tie at 1 and the sort must fall back to localeCompare.
          "zulu/note.md": "no sources",
          "alpha/note.md": "no sources",
        },
      });
      try {
        const r = await v.call("audit_provenance", { vault: "test" });
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.data as { by_folder: Record<string, { scanned: number; missing: number }> };
          expect(Object.keys(d.by_folder)).toEqual(["alpha", "zulu"]);
        }
      } finally {
        v.cleanup();
      }
    });
  });
});
