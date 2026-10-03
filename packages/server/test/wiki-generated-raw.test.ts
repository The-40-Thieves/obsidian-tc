// The generated index.md / log.md next to a vault's raw-sources folder: generation never writes under
// the raw folder, never lists a raw note (by name, or through a symlink inside the wiki folder), and
// never logs one. The raw folder's own immutability and the log's read:provenance scope both live in
// buildAcls; this file pins that they hold together.
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { escapeGlob } from "../src/acl";
import type { Database } from "../src/db/types";
import { appendProvenance } from "../src/provenance/store";
import { buildAcls } from "../src/runtime/acl-build";
import { NO_EXCLUSION } from "../src/search/index-exclusion";
import {
  regenerateWikiPages,
  type WikiGenerateEnv,
} from "../src/tools/m7/knowledge/wiki-generated";
import { evaluatePathAcl, pathScopesSatisfied } from "../src/vault/acl-path";
import {
  hashTree,
  makeWikiHarness,
  WIKI_TEST_SEAL_KEY,
  type WikiHarness,
} from "./wiki-test-helpers";

const FILES: Record<string, string> = {
  "wiki/Page.md": "---\ntype: entity\n---\n# Page\n",
  "raw/clip.md": "# Clip\n\nA saved article.\n",
  "raw/deep/er/more.md": "More.\n",
  "notes/free.md": "Free.\n",
};
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

let h: WikiHarness;
afterEach(() => h?.v.cleanup());

const harness = (opts: Parameters<typeof makeWikiHarness>[0] = {}): WikiHarness =>
  (h = makeWikiHarness({ files: FILES, wikiFolder: "wiki", ...opts }));

const envFor = (hh: WikiHarness, over: Partial<WikiGenerateEnv> = {}): WikiGenerateEnv => ({
  root: hh.v.root,
  vaultId: "test",
  wikiFolder: "wiki",
  acl: hh.v.acl,
  exclusion: NO_EXCLUSION,
  db: hh.v.db as Database,
  sealKey: WIKI_TEST_SEAL_KEY,
  snapshots: { enabled: true, retention: 10 },
  ...over,
});

function record(hh: WikiHarness, paths: Array<[string, string, string]>): void {
  appendProvenance(
    hh.v.db as Database,
    {
      vaultId: "test",
      ts: 1_800_000_000_000,
      tool: "write_note",
      outcome: "ok",
      paths: paths.map(([path, before, after]) => ({ path, before, after })),
      pathsOmitted: 0,
      verified: { host: "h", server_version: "0", principal: "alice" },
      unauthenticated: {},
      self_reported: { model: "claude-test" },
    },
    undefined,
  );
}

describe("generated pages beside a raw folder", () => {
  it("writes nothing under raw/ and lists no raw note in index.md", () => {
    const hh = harness();
    const rawBefore = hashTree(join(hh.v.root, "raw"));
    const r = regenerateWikiPages(envFor(hh));
    expect(r.warnings).toEqual([]);
    expect(r.written).toEqual(["wiki/index.md"]);
    // Every write is inside the wiki folder; the raw folder is byte-for-byte what it was.
    for (const w of r.written) expect(w.startsWith("wiki/")).toBe(true);
    expect(hashTree(join(hh.v.root, "raw"))).toEqual(rawBefore);
    expect(hh.v.exists("raw/index.md")).toBe(false);
    expect(hh.v.exists("raw/log.md")).toBe(false);
    const idx = hh.v.read("wiki/index.md");
    expect(idx).toContain("[[wiki/Page|Page]]");
    expect(idx).not.toContain("raw/");
    expect(idx).not.toContain("clip");
    expect(idx).not.toContain("more");
    // A raw note added later stays out too: raw is outside the wiki folder, which is all the index scans.
    hh.v.write("raw/later.md", "Later.\n");
    regenerateWikiPages(envFor(hh));
    expect(hh.v.read("wiki/index.md")).not.toContain("later");
  });

  it("a symlink inside the wiki folder that leads into raw/ (folder or note) is not listed", () => {
    const hh = harness();
    symlinkSync(join(hh.v.root, "raw"), join(hh.v.root, "wiki/alias"));
    symlinkSync(join(hh.v.root, "raw/clip.md"), join(hh.v.root, "wiki/Clip link.md"));
    regenerateWikiPages(envFor(hh));
    const idx = hh.v.read("wiki/index.md");
    expect(idx).toContain("[[wiki/Page|Page]]");
    expect(idx).not.toContain("alias");
    expect(idx).not.toContain("Clip link");
  });

  it("log.md carries no row for a raw path, even one a provenance row names", () => {
    const hh = harness();
    record(hh, [
      ["raw/clip.md", "absent", H1],
      ["wiki/Page.md", "absent", H2],
    ]);
    regenerateWikiPages(envFor(hh));
    const log = hh.v.read("wiki/log.md");
    expect(log).toContain("wiki/Page.md");
    expect(log).not.toContain("raw/");
    expect(hh.v.exists("raw/log.md")).toBe(false);
  });

  it("a custom raw folder is honoured the same way", () => {
    const hh = harness({
      files: { ...FILES, "sources/in.md": "In.\n" },
      rawFolder: "sources",
    });
    const before = hashTree(join(hh.v.root, "sources"));
    regenerateWikiPages(envFor(hh, { wikiFolder: "wiki" }));
    expect(hashTree(join(hh.v.root, "sources"))).toEqual(before);
    expect(hh.v.read("wiki/index.md")).not.toContain("sources/");
  });

  it("generated pages are refused through a symlink into raw/ (the immutable rule is not widened by the log rule)", () => {
    const hh = harness();
    mkdirSync(join(hh.v.root, "raw/gen"), { recursive: true });
    symlinkSync(join(hh.v.root, "raw/gen/index.md"), join(hh.v.root, "wiki/index.md"));
    const before = hashTree(join(hh.v.root, "raw"));
    const r = regenerateWikiPages(envFor(hh));
    expect(r.written).not.toContain("wiki/index.md");
    expect(r.warnings.some((w) => w.path === "wiki/index.md")).toBe(true);
    expect(hashTree(join(hh.v.root, "raw"))).toEqual(before);
  });

  it("lint_wiki and find_existing_page skip raw notes and the generated pages alike", async () => {
    const hh = harness({
      files: { ...FILES, "raw/Learning techniques.md": "# Learning techniques\n\nA clipping.\n" },
    });
    regenerateWikiPages(envFor(hh));
    expect(hh.v.exists("wiki/index.md")).toBe(true);
    const lint = await hh.data("lint_wiki", {
      checks: ["orphans", "missing_sources", "unresolved_links", "generated_pages"],
    });
    const subjects: string[] = lint.proposals.map((p: any) => p.subject);
    expect(subjects.some((s) => s.startsWith("raw/"))).toBe(false);
    expect(subjects).not.toContain("wiki/index.md");
    // The wiki page itself is still linted: the skip is for raw notes, not the whole vault.
    expect(subjects).toContain("wiki/Page.md");
    // A raw clipping with the topic's name is not an existing page; neither is the generated index.
    const found = await hh.data("find_existing_page", { topic: "Learning techniques" });
    expect(found.candidates.map((c: any) => c.path)).toEqual([]);
    const index = await hh.data("find_existing_page", { topic: "Wiki index" });
    expect(index.candidates.map((c: any) => c.path)).not.toContain("wiki/index.md");
  });

  it("buildAcls carries both the log.md scope and the raw immutable rule, and neither widens the other", () => {
    const cfg = {
      readOnly: false,
      defaultScopes: [],
      rules: [{ glob: "wiki/**", scopes: ["admin:wiki"] }],
      immutablePaths: ["wiki/frozen.md"],
    };
    const acl = buildAcls(cfg, [{ id: "a", wiki: { folder: "wiki" } }]).aclByVault.get("a");
    expect(acl).toBeDefined();
    // The log rule: log.md needs read:provenance on top of the operator's own scope; nothing else does.
    expect(acl?.scopesForPath("wiki/log.md").sort()).toEqual(["admin:wiki", "read:provenance"]);
    expect(acl?.scopesForPath("wiki/Page.md")).toEqual(["admin:wiki"]);
    expect(acl?.scopesForPath("raw/clip.md")).toEqual([]);
    // The raw rule: raw/ is immutable for writes only; the operator's own immutable path survives.
    for (const rel of ["raw", "raw/clip.md", "raw/deep/er/more.md", "wiki/frozen.md"])
      expect(evaluatePathAcl(acl, "write", rel).allowed).toBe(false);
    expect(evaluatePathAcl(acl, "read", "raw/clip.md").allowed).toBe(true);
    expect(evaluatePathAcl(acl, "write", "wiki/Page.md").allowed).toBe(true);
  });

  it("keeps operator scopes on literal wiki folders containing glob metacharacters", () => {
    for (const folder of ["wiki[1]", "wi*ki", "wi?ki"]) {
      const base = {
        readOnly: false,
        defaultScopes: [],
        rules: [{ glob: `${escapeGlob(folder)}/**`, scopes: ["secret:wiki"] }],
        immutablePaths: [],
      };
      const acl = buildAcls(base, [{ id: "a", wiki: { folder } }]).aclByVault.get("a");
      expect(acl?.scopesForPath(`${folder}/log.md`).sort()).toEqual([
        "read:provenance",
        "secret:wiki",
      ]);
      expect(pathScopesSatisfied(acl, `${folder}/log.md`, ["read:notes", "read:provenance"])).toBe(
        false,
      );
      expect(acl?.scopesForPath("wixki/log.md")).toEqual([]);
    }
  });
});
