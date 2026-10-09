// lint_wiki: one read-only call that folds the scattered wiki checks into PROPOSALS. A fixture vault
// holds exactly one of each problem; every proposal must name its suggested action and the tool
// that applies it; nothing may be written; the read ACL and Obsidian's Excluded files apply.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import { persistGapReport } from "../src/experiential/gaps";
import { recomputeNoteQuality, STALE_EDIT_DAYS } from "../src/experiential/note-quality";
import { LINT_CHECKS } from "../src/tools/m7/knowledge/wiki-lint";
import { openMemoryDb, stampAclPath } from "./helpers";
import { dbCounts, hashTree, makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const NOW = Date.now();
const DAY = 86_400_000;

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(
    db,
    EXPERIENTIAL_MIGRATION_FILES.map((f) => ({ version: versionOf(f), sql: read(f) })),
  );
  return db;
}

// Every note links from Index, so the ONLY orphan is Lonely; every note has sources except
// NoSources; every vector is unrelated except the Dup pair.
const FILES: Record<string, string> = {
  "wiki/Index.md":
    "---\nsources: [index]\n---\n[[Linker]] [[Lonely-adjacent]] [[Dup One]] [[Dup Two]] [[Stale page]] [[Claim A]] [[Claim B]] [[NoSources]] [[Echo X]] [[Echo Y]] [[Distinct]]\n",
  "wiki/Linker.md":
    '---\nsources: [x]\nrelated: "[[Absent Entity]]"\n---\nSee [[Missing Page]] and [[Missing Page]] again, back to [[Index]].\n',
  "wiki/Lonely.md": "---\nsources: [x]\n---\nNobody links here.\n",
  "wiki/Lonely-adjacent.md": "---\nsources: [x]\n---\nlinked from index\n",
  "wiki/Dup One.md": "---\nsources: [x]\n---\nThe same ground, first wording.\n",
  "wiki/Dup Two.md": "---\nsources: [x]\n---\nThe same ground, second wording.\n",
  "wiki/Stale page.md": "---\nsources: [x]\n---\nOld.\n",
  "wiki/Claim A.md": "---\nsources: [x]\n---\nThe sky is green.\n",
  "wiki/Claim B.md": "---\nsources: [x]\n---\nThe sky is blue.\n",
  "wiki/NoSources.md": "Claims with no evidence recorded.\n",
  "wiki/Echo X.md": "---\nsources: [x]\n---\nshared paragraph\n",
  "wiki/Echo Y.md": "---\nsources: [x]\n---\nshared paragraph\n",
  "wiki/Distinct.md": "---\nsources: [x]\n---\nUnrelated.\n",
  "hidden/Hidden orphan.md": "---\n---\nExcluded, orphaned and unsourced.\n",
  "private/Secret.md": "No sources, no links, denied to the caller.\n",
  ".obsidian/app.json": JSON.stringify({ userIgnoreFilters: ["hidden/"] }),
};

let h: WikiHarness;
let edb: Database;
afterEach(() => h?.v.cleanup());

function fixture(opts: { acl?: object; withEdb?: boolean } = {}): WikiHarness {
  edb = edb0();
  h = makeWikiHarness({
    files: FILES,
    acl: opts.acl ?? { readPaths: ["wiki/**", "hidden/**"] },
    ...(opts.withEdb === false ? {} : { edb }),
  });
  const vec = (i: number): number[] => {
    const v = [0, 0, 0, 0];
    v[i % 4] = 1;
    return v;
  };
  // Distinct notes get orthogonal-ish unit vectors; the Dup pair are near-identical.
  h.seed("wiki/Dup One.md", [0, 1, 0, 0.02]);
  h.seed("wiki/Dup Two.md", [0, 1, 0.02, 0]);
  h.seed("wiki/Distinct.md", vec(0));
  h.seed("wiki/Linker.md", vec(2));
  h.seed("wiki/Claim A.md", [0, 0, 0.7, 0.7]);
  h.seed("wiki/Echo X.md", [0.5, 0, 0.5, 0], { bodySha: "shared" });
  h.seed("wiki/Echo Y.md", [0.5, 0, -0.5, 0], { bodySha: "shared" });
  h.seed("hidden/Hidden orphan.md", [0, 1, 0, 0.01]); // would pair with Dup One if not excluded
  // contradictions (open, resolved, and one touching a note the caller cannot read)
  const ins = h.v.db.prepare(
    `INSERT INTO contradictions (id, vault_id, source_chunk_id, source_path, conflict_chunk_id, conflict_path,
       source_content_sha, conflict_content_sha, judge_verdict, judge_rationale, status, detected_at)
     VALUES (?, 'test', 'sc', ?, 'cc', ?, ?, ?, ?, 'colours disagree', ?, 0)`,
  );
  ins.run("k1", "wiki/Claim A.md", "wiki/Claim B.md", "s1", "x1", "contradiction", "open");
  ins.run("k2", "wiki/Claim A.md", "wiki/Distinct.md", "s2", "x2", "tension", "resolved");
  ins.run("k3", "wiki/Claim A.md", "private/Secret.md", "s3", "x3", "contradiction", "open");
  // note_quality rollup: Stale page is old; Echo X/Y share a chunk body.
  const note = h.v.db.prepare(
    "INSERT INTO notes (vault_id, path, title, tags, content_hash, mtime, size, indexed_at) VALUES ('test', ?, ?, '[]', ?, ?, 1, 0)",
  );
  for (const p of Object.keys(FILES).filter((f) => f.endsWith(".md") && !f.startsWith(".")))
    note.run(
      p,
      p,
      `h:${p}`,
      p === "wiki/Stale page.md" ? NOW - (STALE_EDIT_DAYS + 400) * DAY : NOW,
    );
  stampAclPath(h.v.db);
  recomputeNoteQuality(h.v.db, edb, { vaultId: "test", nowMs: NOW });
  // a persisted gap pass
  persistGapReport(
    edb,
    {
      threshold: 0.2,
      min_results: 1,
      total: 2,
      gaps: 1,
      gap_rate: 0.5,
      items: [
        {
          id: "g1",
          query: "how do tides work",
          top_score: 0.05,
          results: 1,
          gap: true,
          nearest: [{ path: "wiki/Distinct.md", score: 0.05 }],
        },
        { id: "g2", query: "covered topic", top_score: 0.9, results: 3, gap: false, nearest: [] },
      ],
    },
    { vaultId: "test", computedAt: 1 },
  );
  return h;
}

type Proposal = {
  kind: string;
  subject: string;
  related?: string[];
  detail?: string;
  suggested_action: string;
  tool: string;
  tool_args?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
};
const byKind = (d: any, kind: string): Proposal[] =>
  (d.proposals as Proposal[]).filter((p) => p.kind === kind);

describe("lint_wiki: one proposal per problem in a fixture vault", () => {
  it("orphan: only the page nothing links to, and never an excluded or denied one", async () => {
    const d = await fixture().data("lint_wiki", {});
    expect(byKind(d, "orphan").map((p) => p.subject)).toEqual(["wiki/Lonely.md"]);
    expect(byKind(d, "orphan")[0]).toMatchObject({ tool: "suggest_links" });
  });

  it("unresolved_link: grouped per missing target, property links included", async () => {
    const d = await fixture().data("lint_wiki", {});
    const targets = byKind(d, "unresolved_link").map((p) => p.subject);
    expect(targets.sort()).toEqual(["Absent Entity", "Missing Page"]);
    const prop = byKind(d, "unresolved_link").find((p) => p.subject === "Absent Entity");
    expect(prop?.detail).toContain("related");
    expect(prop?.related).toEqual(["wiki/Linker.md"]);
    expect(prop).toMatchObject({
      tool: "find_existing_page",
      tool_args: { topic: "Absent Entity" },
    });
  });

  it("contradiction: open rows only, ACL-filtered, with the re-judge caveat", async () => {
    const d = await fixture().data("lint_wiki", {});
    const rows = byKind(d, "contradiction");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject: "wiki/Claim A.md",
      related: ["wiki/Claim B.md"],
      tool: "read_notes",
    });
    expect(rows[0]?.evidence).toMatchObject({ id: "k1", rejudged: false });
    expect(JSON.stringify(d)).not.toContain("private/");
    expect(d.notes.join(" ")).toMatch(/re-judged/);
  });

  it("stale: the page not edited for over a year", async () => {
    const d = await fixture().data("lint_wiki", {});
    expect(byKind(d, "stale").map((p) => p.subject)).toEqual(["wiki/Stale page.md"]);
  });

  it("duplicate_chunks: notes repeating the same passage, naming the peer", async () => {
    const d = await fixture().data("lint_wiki", {});
    const dups = byKind(d, "duplicate_chunks");
    expect(dups.map((p) => p.subject).sort()).toEqual(["wiki/Echo X.md", "wiki/Echo Y.md"]);
    expect(dups.find((p) => p.subject === "wiki/Echo X.md")?.related).toEqual(["wiki/Echo Y.md"]);
  });

  it("missing_sources: only notes without a `sources` field that the caller may read", async () => {
    const d = await fixture().data("lint_wiki", {});
    expect(byKind(d, "missing_sources").map((p) => p.subject)).toEqual(["wiki/NoSources.md"]);
    expect(byKind(d, "missing_sources")[0]).toMatchObject({
      tool: "update_frontmatter",
      tool_args: { operation: "set", key: "sources" },
    });
  });

  it("coverage_gap: the persisted gap queries, not the covered ones", async () => {
    const d = await fixture().data("lint_wiki", {});
    expect(byKind(d, "coverage_gap").map((p) => p.subject)).toEqual(["how do tides work"]);
    expect(byKind(d, "coverage_gap")[0]).toMatchObject({ tool: "find_existing_page" });
  });

  it("near_duplicate: the pair whose note vectors are in the band, never the excluded note", async () => {
    const d = await fixture().data("lint_wiki", {});
    const pairs = byKind(d, "near_duplicate");
    expect(pairs).toHaveLength(1);
    expect([pairs[0]?.subject, ...(pairs[0]?.related ?? [])].sort()).toEqual([
      "wiki/Dup One.md",
      "wiki/Dup Two.md",
    ]);
    expect(pairs[0]?.evidence).toMatchObject({ score: expect.any(Number) });
    expect(JSON.stringify(d)).not.toContain("hidden/");
  });

  it("every proposal names a suggested action and an existing tool", async () => {
    const hh = fixture();
    const d = await hh.data("lint_wiki", {});
    const known = new Set(hh.v.registry.list().map((t) => t.name));
    expect(d.proposals.length).toBeGreaterThanOrEqual(8);
    for (const p of d.proposals as Proposal[]) {
      expect(p.suggested_action.length).toBeGreaterThan(10);
      expect(known.has(p.tool) || ["suggest_links", "find_existing_page"].includes(p.tool)).toBe(
        true,
      );
    }
    expect(d.read_only).toBe(true);
    expect(d.summary.total).toBe(d.proposals.length);
    expect(d.checks_run.sort()).toEqual([...LINT_CHECKS].sort());
  });
});

describe("lint_wiki: scope, formats, degradation", () => {
  it("folder scopes the subjects but resolves links against the whole vault", async () => {
    const hh = fixture({ acl: { readPaths: ["wiki/**", "hidden/**", "other/**"] } });
    hh.v.write("other/Doc.md", "---\nsources: [x]\n---\n[[Lonely]]\n");
    const d = await hh.data("lint_wiki", { folder: "other" });
    expect(d.folder).toBe("other");
    expect(byKind(d, "orphan").map((p) => p.subject)).toEqual(["other/Doc.md"]);
    expect(byKind(d, "missing_sources")).toEqual([]);
  });

  it("checks selects which checks run", async () => {
    const d = await fixture().data("lint_wiki", { checks: ["orphans", "missing_sources"] });
    expect(d.checks_run.sort()).toEqual(["missing_sources", "orphans"]);
    expect(new Set(d.proposals.map((p: Proposal) => p.kind))).toEqual(
      new Set(["orphan", "missing_sources"]),
    );
  });

  it("limit_per_check caps each kind and reports it as truncated", async () => {
    const d = await fixture().data("lint_wiki", {
      limit_per_check: 1,
      checks: ["unresolved_links"],
    });
    expect(d.proposals).toHaveLength(1);
    expect(d.truncated).toEqual(["unresolved_link"]);
  });

  it("a check that cannot run is skipped with a reason, never an error", async () => {
    const d = await fixture({ withEdb: false }).data("lint_wiki", {});
    const skipped = Object.fromEntries(d.skipped.map((s: any) => [s.check, s.reason]));
    expect(Object.keys(skipped).sort()).toEqual(["coverage_gaps", "quality"]);
    expect(d.checks_run).toContain("orphans");
    expect(byKind(d, "orphan")).toHaveLength(1);
  });

  it("concise drops detail, tool_args and evidence; detailed keeps them", async () => {
    const hh = fixture();
    const concise = await hh.data("lint_wiki", { response_format: "concise" });
    const detailed = await hh.data("lint_wiki", { response_format: "detailed" });
    expect(concise.proposals).toHaveLength(detailed.proposals.length);
    for (const p of concise.proposals) {
      expect(p).not.toHaveProperty("detail");
      expect(p).not.toHaveProperty("tool_args");
      expect(p).not.toHaveProperty("evidence");
      expect(p).toHaveProperty("suggested_action");
      expect(p).toHaveProperty("tool");
    }
    expect(detailed.proposals.every((p: Proposal) => typeof p.detail === "string")).toBe(true);
    expect(Object.keys(concise).sort()).toEqual(Object.keys(detailed).sort());
  });
});

describe("lint_wiki: ACL and Excluded files", () => {
  it("a denied note is absent from every section (denied == missing)", async () => {
    const d = await fixture().data("lint_wiki", {});
    expect(JSON.stringify(d)).not.toContain("private/");
  });

  it("an ACL that allows the note makes it visible", async () => {
    const d = await fixture({ acl: { readPaths: ["wiki/**", "hidden/**", "private/**"] } }).data(
      "lint_wiki",
      {},
    );
    expect(byKind(d, "missing_sources").map((p) => p.subject)).toContain("private/Secret.md");
  });

  it("an excluded note is never the subject of a proposal", async () => {
    const d = await fixture().data("lint_wiki", {});
    for (const p of d.proposals as Proposal[]) expect(p.subject.startsWith("hidden/")).toBe(false);
    // ...but it still resolves as an ordinary link target: linking to it is not a dangling link.
    h.v.write("wiki/Points to hidden.md", "---\nsources: [x]\n---\n[[Hidden orphan]]\n");
    const again = await h.data("lint_wiki", { checks: ["unresolved_links"] });
    expect(byKind(again, "unresolved_link").map((p) => p.subject)).not.toContain("Hidden orphan");
  });
});

describe("lint_wiki: never writes, never blocks", () => {
  it("skips only generated-page seal checks when the read-only key lookup fails", async () => {
    h = makeWikiHarness({
      files: { "wiki/index.md": "mine\n", "wiki/Page.md": "page\n" },
      wikiFolder: "wiki",
      wikiGeneratedSealKeyForLint: () => {
        throw new Error("empty key file");
      },
    });
    const r = await h.v.call("lint_wiki", {
      vault: "test",
      checks: ["generated_pages", "orphans"],
    });
    expect(r.ok).toBe(true);
    expect((r as { data: any }).data.skipped).toContainEqual({
      check: "generated_pages",
      reason: "generated-page HMAC key unavailable",
    });
    expect((r as { data: any }).data.checks_run).toContain("orphans");
  });

  it("vault files and cache rows are byte-identical after repeated runs", async () => {
    const hh = fixture();
    const files = hashTree(hh.v.root);
    const rows = dbCounts(hh.v.db);
    const exp = dbCounts(edb);
    for (const response_format of ["concise", "detailed"])
      await hh.data("lint_wiki", { response_format });
    expect(hashTree(hh.v.root)).toEqual(files);
    expect(dbCounts(hh.v.db)).toEqual(rows);
    expect(dbCounts(edb)).toEqual(exp);
  });

  it("is read-only by registration: only read:notes, and no write tool is named as `tool` that lint calls itself", async () => {
    const hh = fixture();
    const tool = hh.v.registry.list().find((t) => t.name === "lint_wiki");
    expect(tool?.requiredScopes).toEqual(["read:notes"]);
    const r = await hh.v.call(
      "lint_wiki",
      { vault: "test" },
      { grantedScopes: new Set(["read:notes"]) },
    );
    expect(r.ok).toBe(true);
    expect(tool?.description).toMatch(/never (writes|blocks)|read-only/i);
  });
});
