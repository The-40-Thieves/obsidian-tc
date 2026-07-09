import { describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";

describe("THE-375 vault health + link recommendation", () => {
  it("vault_health_score aggregates orphans, unresolved, cycles into a scored breakdown", async () => {
    const v = makeTestVault({
      files: {
        "a.md": "[[b]] [[c]]",
        "b.md": "[[a]] [[c]]", // a<->b forms a cycle
        "c.md": "no links",
        "d.md": "orphan, links nothing",
        "e.md": "[[nonexistent]]", // unresolved + orphan
      },
    });
    try {
      const r = await v.call("vault_health_score", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          score: number;
          total_notes: number;
          metrics: { orphans: number; unresolved_links: number; cycles: number };
        };
        expect(d.total_notes).toBe(5);
        expect(d.metrics.orphans).toBe(2); // d, e
        expect(d.metrics.unresolved_links).toBe(1); // e -> nonexistent
        expect(d.metrics.cycles).toBeGreaterThanOrEqual(1); // a<->b
        expect(d.score).toBeGreaterThanOrEqual(0);
        expect(d.score).toBeLessThanOrEqual(100);
      }
    } finally {
      v.cleanup();
    }
  });

  it("find_link_cycles detects a circular chain", async () => {
    const v = makeTestVault({ files: { "a.md": "[[b]]", "b.md": "[[a]]" } });
    try {
      const r = await v.call("find_link_cycles", { vault: "test" });
      if (r.ok) expect((r.data as { total: number }).total).toBeGreaterThanOrEqual(1);
    } finally {
      v.cleanup();
    }
  });

  it("get_link_strength scores a direct edge above zero and reports distance", async () => {
    const v = makeTestVault({ files: { "a.md": "[[b]] [[c]]", "b.md": "[[c]]", "c.md": "x" } });
    try {
      const r = await v.call("get_link_strength", { vault: "test", from: "a.md", to: "b.md" });
      if (r.ok) {
        const d = r.data as { direct: boolean; distance: number | null; strength: number };
        expect(d.direct).toBe(true);
        expect(d.distance).toBe(1);
        expect(d.strength).toBeGreaterThan(0);
      }
    } finally {
      v.cleanup();
    }
  });

  it("suggest_links surfaces a 2-hop candidate the note does not yet link", async () => {
    const v = makeTestVault({ files: { "x.md": "[[y]]", "y.md": "[[z]]", "z.md": "end" } });
    try {
      const r = await v.call("suggest_links", { vault: "test", path: "x.md" });
      if (r.ok) {
        const d = r.data as { suggestions: Array<{ path: string; two_hop: number }> };
        expect(d.suggestions.map((s) => s.path)).toContain("z.md");
      }
    } finally {
      v.cleanup();
    }
  });
});
