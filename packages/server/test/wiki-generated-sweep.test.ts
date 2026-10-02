// The scheduled regeneration of the generated wiki pages: registered only on request, writes the
// same index.md commit_wiki_page does, skips a vault with no wiki folder, and reports (rather than
// overwrites) a hand-edited page.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { registerWikiPagesSweep } from "../src/runtime/wiki-pages-sweep";
import type { Scheduler } from "../src/scheduler/scheduler";
import { NO_EXCLUSION } from "../src/search/index-exclusion";
import { inspectGenerated } from "../src/tools/m7/knowledge/wiki-generated-seal";
import { makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

let h: WikiHarness;
afterEach(() => h?.v.cleanup());

const FILES = {
  "wiki/Ada.md": "---\ntype: entity\n---\n# Ada\n",
  "wiki/private/Secret.md": "---\ntype: entity\n---\nSecret.\n",
};

/** Register the sweep on a stub scheduler and hand back its job. */
function job(hh: WikiHarness, over: { wikiFolder?: string | undefined } = { wikiFolder: "wiki" }) {
  let registered:
    | { name: string; intervalMs: number; run: (s: AbortSignal) => Promise<void> }
    | undefined;
  const results: Array<[string, { written: string[]; warnings: Array<{ kind: string }> }]> = [];
  registerWikiPagesSweep({ register: (j: never) => (registered = j) } as unknown as Scheduler, {
    cacheDb: hh.v.db as never,
    vaults: [{ id: "test", root: hh.v.root, wikiFolder: over.wikiFolder }],
    aclFor: () => hh.v.acl,
    exclusionFor: () => NO_EXCLUSION,
    snapshots: { enabled: true, retention: 10 },
    intervalMs: 1000,
    onResult: (id, r) => results.push([id, r]),
  });
  return { registered: registered as NonNullable<typeof registered>, results };
}

describe("scheduled wiki page regeneration (generated index.md)", () => {
  it("is off by default in the config, with a six-hour cadence when switched on", () => {
    const cfg = ServerConfigSchema.parse({ vaults: [{ id: "v", path: "/tmp/v" }] });
    expect(cfg.maintenance.wikiPages).toEqual({ enabled: false, intervalHours: 6 });
  });

  it("writes the index for a vault, from the vault's ACL alone: a read-denied folder is not listed", async () => {
    h = makeWikiHarness({
      files: FILES,
      wikiFolder: "wiki",
      acl: { readPaths: ["wiki/*.md"] },
    });
    const { registered, results } = job(h);
    expect(registered.name).toBe("wiki-pages");
    expect(registered.intervalMs).toBe(1000);
    await registered.run(new AbortController().signal);
    const idx = h.v.read("wiki/index.md");
    expect(inspectGenerated(idx)).toBe("ours");
    expect(idx).toContain("[[wiki/Ada|Ada]]");
    expect(idx).not.toContain("Secret");
    expect(results).toEqual([["test", { written: ["wiki/index.md"], warnings: [] }]]);
    // A second tick has nothing to do.
    await registered.run(new AbortController().signal);
    expect(results[1]?.[1].written).toEqual([]);
  });

  it("skips a vault with no wiki folder", async () => {
    h = makeWikiHarness({ files: FILES });
    const { registered, results } = job(h, { wikiFolder: undefined });
    await registered.run(new AbortController().signal);
    expect(results).toEqual([]);
    expect(h.v.exists("wiki/index.md")).toBe(false);
  });

  it("reports a hand-edited index.md and leaves it as it is", async () => {
    h = makeWikiHarness({ files: FILES, wikiFolder: "wiki" });
    const { registered, results } = job(h);
    await registered.run(new AbortController().signal);
    const edited = `${h.v.read("wiki/index.md")}\nmine\n`;
    h.v.write("wiki/index.md", edited);
    h.v.write("wiki/Fresh.md", "---\ntype: entity\n---\nFresh.\n");
    await registered.run(new AbortController().signal);
    expect(h.v.read("wiki/index.md")).toBe(edited);
    expect(results[1]?.[1].warnings.map((w) => w.kind)).toEqual(["edited"]);
  });

  it("stops between vaults when the scheduler aborts", async () => {
    h = makeWikiHarness({ files: FILES, wikiFolder: "wiki" });
    const { registered, results } = job(h);
    const ac = new AbortController();
    ac.abort();
    await registered.run(ac.signal);
    expect(results).toEqual([]);
  });
});
