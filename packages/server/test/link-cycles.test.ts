// find_link_cycles (Refs #1332): structural two-note loops skipped by default, a true total and a
// truncated flag, a work cap for dense graphs, each cycle reported once, and folder scoping.
import { describe, expect, it } from "vitest";
import { findLinkCyclesSteps, restrictToFolder } from "../src/tools/m1/link-cycles";
import { drainSteps } from "../src/util/scan-steps";
import { makeTestVault } from "./m1-helpers";

type Cycles = { total: number; truncated: boolean; cycles: string[][]; skipped_shorter: number };

/** Rotate a cycle (its last node repeats the first) so it starts at its smallest node. */
function canonical(cycle: string[]): string {
  const ring = cycle.slice(0, -1);
  let best = 0;
  for (let i = 1; i < ring.length; i++) if ((ring[i] ?? "") < (ring[best] ?? "")) best = i;
  return [...ring.slice(best), ...ring.slice(0, best)].join(" > ");
}

describe("find_link_cycles: structural two-note loops", () => {
  it("two-note loop skipped by default and kept with min_length 2", async () => {
    const v = makeTestVault({ files: { "a.md": "[[b]]", "b.md": "[[a]]" } });
    try {
      const byDefault = await v.call("find_link_cycles", { vault: "test" });
      expect(byDefault.ok).toBe(true);
      if (byDefault.ok) {
        const d = byDefault.data as Cycles;
        expect(d.total).toBe(0);
        expect(d.skipped_shorter).toBe(1);
      }
      const kept = await v.call("find_link_cycles", { vault: "test", min_length: 2 });
      expect(kept.ok).toBe(true);
      if (kept.ok) {
        const d = kept.data as Cycles;
        expect(d.total).toBe(1);
        expect(d.cycles).toEqual([["a.md", "b.md", "a.md"]]);
        expect(d.skipped_shorter).toBe(0);
      }
    } finally {
      v.cleanup();
    }
  });

  it("a note and its folder index (a two-note loop) are skipped; a longer loop is kept", async () => {
    // A ring n1 -> n2 -> n3 -> n1 where every note also links to its index: each note/index pair
    // is a two-note loop (skipped), and the ring is a three-link loop (kept).
    const v = makeTestVault({
      files: {
        "p/index.md": "[[n1]] [[n2]] [[n3]]",
        "p/n1.md": "[[index]] [[n2]]",
        "p/n2.md": "[[index]] [[n3]]",
        "p/n3.md": "[[index]] [[n1]]",
      },
    });
    try {
      const r = await v.call("find_link_cycles", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as Cycles;
        expect(d.total).toBeGreaterThanOrEqual(1);
        for (const c of d.cycles) expect(c.length - 1).toBeGreaterThanOrEqual(3);
        expect(d.skipped_shorter).toBeGreaterThanOrEqual(1);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("find_link_cycles: each cycle reported once", () => {
  it("rotation: a complete directed graph reports no loop twice under rotation", async () => {
    // Every note links to every other: many loops, several of which a DFS from one start could
    // reach from another start. No two reported cycles may share a rotation.
    const names = ["k1", "k2", "k3", "k4", "k5"];
    const files: Record<string, string> = {};
    for (const n of names)
      files[`${n}.md`] = names
        .filter((m) => m !== n)
        .map((m) => `[[${m}]]`)
        .join(" ");
    const v = makeTestVault({ files });
    try {
      const r = await v.call("find_link_cycles", { vault: "test", limit: 1000, min_length: 2 });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as Cycles;
        expect(d.cycles.length).toBe(d.total);
        expect(new Set(d.cycles.map(canonical)).size).toBe(d.cycles.length);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("find_link_cycles: total and truncated", () => {
  it("total counts every cycle past limit and truncated stays false when the scan finishes", async () => {
    // Four independent two-note loops; limit 1 returns one page but total counts all four.
    const v = makeTestVault({
      files: {
        "a.md": "[[b]]",
        "b.md": "[[a]]",
        "c.md": "[[d]]",
        "d.md": "[[c]]",
        "e.md": "[[f]]",
        "f.md": "[[e]]",
        "g.md": "[[h]]",
        "h.md": "[[g]]",
      },
    });
    try {
      const r = await v.call("find_link_cycles", { vault: "test", limit: 1, min_length: 2 });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as Cycles;
        expect(d.total).toBe(4);
        expect(d.cycles.length).toBe(1);
        expect(d.truncated).toBe(false);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("find_link_cycles: work cap", () => {
  // Two independent two-note loops, so a full scan finds 2 cycles and takes a few dozen steps.
  const out = new Map<string, Set<string>>([
    ["a", new Set(["b"])],
    ["b", new Set(["a"])],
    ["c", new Set(["d"])],
    ["d", new Set(["c"])],
  ]);
  const scan = (maxWork: number) =>
    drainSteps(
      findLinkCyclesSteps(out, {
        limit: 10,
        minLength: 2,
        maxLength: Number.POSITIVE_INFINITY,
        maxWork,
        countPastLimit: true,
      }),
    );

  it("work cap sets truncated and makes total a lower bound", () => {
    const full = scan(Number.POSITIVE_INFINITY);
    expect(full.truncated).toBe(false);
    expect(full.total).toBe(2);
    const capped = scan(3);
    expect(capped.truncated).toBe(true);
    expect(capped.total).toBeLessThan(full.total);
  });

  it("a dense graph answers through the tool: a full page and a total of at least the page", async () => {
    // A complete directed graph on 9 notes: many more loops than one page of 5.
    const names = Array.from({ length: 9 }, (_, i) => `d${i}`);
    const files: Record<string, string> = {};
    for (const n of names)
      files[`${n}.md`] = names
        .filter((m) => m !== n)
        .map((m) => `[[${m}]]`)
        .join(" ");
    const v = makeTestVault({ files });
    try {
      const r = await v.call("find_link_cycles", { vault: "test", limit: 5, min_length: 2 });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as Cycles;
        expect(d.cycles.length).toBe(5);
        expect(d.total).toBeGreaterThanOrEqual(5);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("find_link_cycles: folder scope", () => {
  it("folder: only notes under the folder are cycle members and cross-folder edges are ignored", async () => {
    const files = {
      "x/a.md": "[[x/b]] [[y/d]]",
      "x/b.md": "[[x/c]]",
      "x/c.md": "[[x/a]]",
      "y/d.md": "[[x/a]]",
    };
    const v = makeTestVault({ files });
    try {
      const all = await v.call("find_link_cycles", { vault: "test", min_length: 2 });
      expect(all.ok).toBe(true);
      if (all.ok) expect((all.data as Cycles).total).toBe(2); // a-b-c and a<->d
      const scoped = await v.call("find_link_cycles", {
        vault: "test",
        min_length: 2,
        folder: "x",
      });
      expect(scoped.ok).toBe(true);
      if (scoped.ok) {
        const d = scoped.data as Cycles;
        expect(d.total).toBe(1);
        expect(canonical(d.cycles[0] ?? [])).toBe("x/a.md > x/b.md > x/c.md");
      }
    } finally {
      v.cleanup();
    }
  });

  it("restrictToFolder keeps members under the prefix and drops edges leaving it", () => {
    const out = new Map<string, Set<string>>([
      ["x/a.md", new Set(["x/b.md", "y/d.md"])],
      ["y/d.md", new Set(["x/a.md"])],
    ]);
    const scoped = restrictToFolder(out, "x");
    expect([...scoped.keys()]).toEqual(["x/a.md"]);
    expect([...(scoped.get("x/a.md") ?? [])]).toEqual(["x/b.md"]);
    // A sibling folder sharing the prefix text is not inside "x".
    expect([...restrictToFolder(new Map([["xy/q.md", new Set<string>()]]), "x").keys()]).toEqual(
      [],
    );
  });
});

describe("vault_health_score cycle penalty", () => {
  it("health: vault_health_score is unchanged on a fixture graph", async () => {
    // Twelve two-note loops and one three-note loop, all in one vault.
    const files: Record<string, string> = { "t.md": "[[t2]]", "t2.md": "[[t3]]", "t3.md": "[[t]]" };
    for (let i = 0; i < 12; i++) {
      files[`p${i}.md`] = `[[q${i}]]`;
      files[`q${i}.md`] = `[[p${i}]]`;
    }
    const v = makeTestVault({ files });
    try {
      const r = await v.call("vault_health_score", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          score: number;
          metrics: { cycles: number };
          breakdown: { cycle_penalty: number };
        };
        // Values measured on main before the change: 12 two-note loops + 1 three-note loop = 13.
        expect({
          score: d.score,
          cycles: d.metrics.cycles,
          cycle_penalty: d.breakdown.cycle_penalty,
        }).toEqual({
          score: 80,
          cycles: 13,
          cycle_penalty: 20,
        });
      }
    } finally {
      v.cleanup();
    }
  });
});
