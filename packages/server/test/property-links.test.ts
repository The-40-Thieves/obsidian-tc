// Typed property links. Obsidian indexes wikilinks written in a note's PROPERTIES (frontmatter),
// not only its body (CachedMetadata.frontmatterLinks, since 1.4.0): `author: "[[Douglas Adams]]"`
// and list properties of quoted links. Rules (help.obsidian.md/properties: "internal links must be
// surrounded by quotes to be valid"): only a QUOTED link is a YAML string, so only it is a link;
// an unquoted `[[X]]` parses as a nested YAML list and is not one. Alias, heading and block
// syntax are the body parser's. obsidian-tc used to read the body only, so these links were
// invisible to every link tool and to the graph.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { findAttachmentReferences } from "../src/formats/attachments";
import { desiredEdges, reconcileVaultEdges } from "../src/search/edges";
import { expandGraphLiteral } from "../src/search/graph_expand";
import { parseNote } from "../src/vault/frontmatter";
import { extractLinks, extractNoteLinks, extractPropertyLinks } from "../src/vault/links";
import { openMemoryDb } from "./helpers";
import { makeTestVault } from "./m1-helpers";
import { makeM2Vault } from "./m2-helpers";

type Data = Record<string, unknown>;
const dataOf = (r: { ok: boolean; data?: unknown; error?: unknown }): Data => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as Data;
};

const propLinks = (raw: string) => {
  const p = parseNote(raw);
  return extractPropertyLinks(p.frontmatter, p.rawFrontmatter);
};

describe("extractPropertyLinks (one parser: the body link parser's syntax)", () => {
  it("scalar: a quoted link in a text property, tagged with its property key", () => {
    const links = propLinks('---\nauthor: "[[Douglas Adams]]"\n---\nbody\n');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      kind: "wikilink",
      target: "Douglas Adams",
      raw: "[[Douglas Adams]]",
      source: "property",
      property: "author",
      inCodeblock: false,
    });
  });

  it("list: every quoted item of a list property, block style and flow style", () => {
    const block = propLinks('---\nrelated:\n  - "[[A]]"\n  - plain text\n  - "[[B]]"\n---\n');
    expect(block.map((l) => [l.target, l.property])).toEqual([
      ["A", "related"],
      ["B", "related"],
    ]);
    const flow = propLinks('---\nrelated: ["[[A]]", "[[B]]"]\n---\n');
    expect(flow.map((l) => l.target)).toEqual(["A", "B"]);
  });

  it("alias, heading and block syntax parse as in the body", () => {
    const [alias, heading, block] = propLinks(
      '---\na: "[[Note|shown]]"\nb: "[[Note#Section]]"\nc: "[[Note#^abc123]]"\n---\n',
    );
    expect(alias).toMatchObject({ target: "Note", display: "shown", heading: null });
    expect(heading).toMatchObject({ target: "Note", heading: "Section", display: null });
    expect(block).toMatchObject({ target: "Note", heading: "^abc123" });
  });

  it("agrees with extractLinks on the same text (one parser, not two)", () => {
    const text = "[[A#h|x]] and [[B]]";
    const fromProps = propLinks(`---\np: "${text}"\n---\n`).map(
      ({ raw, target, display, heading }) => ({
        raw,
        target,
        display,
        heading,
      }),
    );
    const fromBody = extractLinks(text).map(({ raw, target, display, heading }) => ({
      raw,
      target,
      display,
      heading,
    }));
    expect(fromProps).toEqual(fromBody);
  });

  it("unquoted [[X]] is NOT a link: YAML reads it as a nested list (Obsidian: quotes required)", () => {
    expect(propLinks("---\nauthor: [[Douglas Adams]]\n---\n")).toEqual([]);
    expect(propLinks("---\nrelated:\n  - [[A]]\n  - [[B]]\n---\n")).toEqual([]);
  });

  it("non-string values and a missing/empty frontmatter yield nothing; nested maps keep the top-level key", () => {
    expect(propLinks("---\nn: 3\nb: true\nz: null\n---\n")).toEqual([]);
    expect(propLinks("no frontmatter [[X]]")).toEqual([]);
    expect(extractPropertyLinks(null, null)).toEqual([]);
    const nested = propLinks('---\nmeta:\n  parent: "[[P]]"\n  more:\n    - "[[Q]]"\n---\n');
    expect(nested.map((l) => [l.target, l.property])).toEqual([
      ["P", "meta"],
      ["Q", "meta"],
    ]);
  });

  it("line/col are the position in the note FILE (opening --- is line 1)", () => {
    const raw = '---\ntitle: T\nrelated:\n  - "[[A]]"\n  - "[[A]]"\nx: "[[B]] [[C]]"\n---\n';
    expect(propLinks(raw).map((l) => [l.target, l.line, l.col])).toEqual([
      ["A", 4, 6],
      ["A", 5, 6],
      ["B", 6, 5],
      ["C", 6, 11],
    ]);
  });

  it("extractNoteLinks = property links then body links, body links tagged source body", () => {
    const p = parseNote('---\nup: "[[P]]"\n---\nsee [[B]]\n');
    const all = extractNoteLinks(p);
    expect(all.map((l) => [l.target, l.source ?? "body"])).toEqual([
      ["P", "property"],
      ["B", "body"],
    ]);
  });
});

const FILES = {
  "Douglas Adams.md": "# Douglas Adams\n",
  "Guide.md":
    '---\nauthor: "[[Douglas Adams]]"\nseries:\n  - "[[Douglas Adams|DNA]]"\n  - "[[Ghost]]"\nmood: [[Unquoted]]\n---\nBody mentions [[Douglas Adams]].\n',
  "Only prop.md": "# Only prop\n",
  "Lister.md": '---\nrelated: ["[[Only prop]]"]\n---\nno body links\n',
};

describe("link tools return property links", () => {
  it("get_outgoing_links: property links carry source+property, count as resolved/unresolved", async () => {
    const v = makeTestVault({ files: FILES });
    try {
      const d = dataOf(await v.call("get_outgoing_links", { vault: "test", path: "Guide.md" }));
      const links = d.links as Array<Data>;
      const prop = links.filter((l) => l.source === "property");
      expect(prop.map((l) => [l.target, l.property, l.resolved])).toEqual([
        ["Douglas Adams", "author", true],
        ["Douglas Adams", "series", true],
        ["Ghost", "series", false],
      ]);
      expect(prop[1]).toMatchObject({ display: "DNA", target_path: "Douglas Adams.md" });
      const body = links.filter((l) => l.source === undefined);
      expect(body.map((l) => l.target)).toEqual(["Douglas Adams"]);
      expect(body[0]?.property).toBeUndefined();
      // the unquoted `mood: [[Unquoted]]` is not a link
      expect(links.some((l) => l.target === "Unquoted")).toBe(false);
      expect(d.counts).toEqual({ total: 4, resolved: 3, unresolved: 1 });
    } finally {
      v.cleanup();
    }
  });

  it("get_outgoing_links concise: property links stay distinguishable", async () => {
    const v = makeTestVault({ files: FILES });
    try {
      const d = dataOf(
        await v.call("get_outgoing_links", {
          vault: "test",
          path: "Guide.md",
          response_format: "concise",
        }),
      );
      const links = d.links as Array<Data>;
      expect(links.find((l) => l.target === "Ghost")).toMatchObject({
        source: "property",
        property: "series",
        resolved: false,
      });
      expect(links.find((l) => l.source === undefined)).toMatchObject({ target: "Douglas Adams" });
    } finally {
      v.cleanup();
    }
  });

  it("get_outgoing_links include_embeds=false keeps property links (they are not embeds)", async () => {
    const v = makeTestVault({ files: FILES });
    try {
      const d = dataOf(
        await v.call("get_outgoing_links", {
          vault: "test",
          path: "Guide.md",
          include_embeds: false,
        }),
      );
      expect((d.links as Array<Data>).filter((l) => l.source === "property")).toHaveLength(3);
    } finally {
      v.cleanup();
    }
  });

  it("get_backlinks: a property link is a backlink, naming the property", async () => {
    const v = makeTestVault({ files: FILES });
    try {
      const d = dataOf(await v.call("get_backlinks", { vault: "test", path: "Douglas Adams.md" }));
      const bl = d.backlinks as Array<Data>;
      expect(bl.map((b) => [b.source_path, b.source, b.property ?? null])).toEqual([
        ["Guide.md", "property", "author"],
        ["Guide.md", "property", "series"],
        ["Guide.md", undefined, null],
      ]);
      const only = dataOf(await v.call("get_backlinks", { vault: "test", path: "Only prop.md" }));
      expect((only.backlinks as Array<Data>).map((b) => b.source_path)).toEqual(["Lister.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("find_unresolved_links: an unresolved property link counts, with its property", async () => {
    const v = makeTestVault({ files: FILES });
    try {
      const d = dataOf(await v.call("find_unresolved_links", { vault: "test" }));
      expect(d.unresolved).toEqual([
        expect.objectContaining({
          source_path: "Guide.md",
          target: "Ghost",
          source: "property",
          property: "series",
        }),
      ]);
    } finally {
      v.cleanup();
    }
  });

  it("find_orphans: a note linked only from a property is not an orphan", async () => {
    const v = makeTestVault({ files: FILES });
    try {
      const d = dataOf(await v.call("find_orphans", { vault: "test" }));
      expect(d.orphans).not.toContain("Only prop.md");
      expect(d.orphans).not.toContain("Douglas Adams.md");
      // require_no_outgoing: Lister only has a property link out, so it is not link-free
      const strict = dataOf(
        await v.call("find_orphans", { vault: "test", require_no_outgoing: true }),
      );
      expect(strict.orphans).not.toContain("Lister.md");
    } finally {
      v.cleanup();
    }
  });

  it("vault_health_score sees property links (graph-health shares the scan)", async () => {
    const v = makeTestVault({
      files: { "A.md": '---\nup: "[[B]]"\nx: "[[Ghost]]"\n---\n', "B.md": "# B\n" },
    });
    try {
      const d = dataOf(await v.call("vault_health_score", { vault: "test" }));
      expect(d.total_links).toBe(2);
      expect(d.metrics).toMatchObject({ orphans: 1, unresolved_links: 1 });
    } finally {
      v.cleanup();
    }
  });
});

describe("malformed YAML", () => {
  const BROKEN =
    '---\nauthor: "[[Douglas Adams]]\ntags: [a, b\n---\nBody [[Douglas Adams]] and [[Ghost]].\n';
  it("does not crash; the note is named in warnings and its BODY links still count", async () => {
    const v = makeTestVault({ files: { "Douglas Adams.md": "# DA\n", "broken.md": BROKEN } });
    try {
      const out = dataOf(await v.call("get_outgoing_links", { vault: "test", path: "broken.md" }));
      expect((out.links as Array<Data>).map((l) => [l.target, l.source])).toEqual([
        ["Douglas Adams", undefined],
        ["Ghost", undefined],
      ]);
      expect(out.warnings).toEqual([expect.objectContaining({ path: "broken.md" })]);
      const back = dataOf(
        await v.call("get_backlinks", { vault: "test", path: "Douglas Adams.md" }),
      );
      expect((back.backlinks as Array<Data>).map((b) => b.source)).toEqual([undefined]);
      expect(back.warnings).toEqual([expect.objectContaining({ path: "broken.md" })]);
      const unresolved = dataOf(await v.call("find_unresolved_links", { vault: "test" }));
      expect((unresolved.unresolved as Array<Data>).map((u) => u.target)).toEqual(["Ghost"]);
    } finally {
      v.cleanup();
    }
  });
});

describe("ACL: identical to body links (denied == missing)", () => {
  const files = {
    "pub/Open.md": "# Open\n",
    "secret/Hidden.md": "# Hidden\n",
    "pub/Linker.md": '---\nup: "[[Open]]"\nhid: "[[Hidden]]"\nmiss: "[[Missing]]"\n---\n',
    "secret/Spy.md": '---\nup: "[[Open]]"\n---\n',
  };
  it("a property link to a denied note is unresolved exactly like a missing one", async () => {
    const v = makeTestVault({ files, acl: { readPaths: ["pub/**"] } });
    try {
      const d = dataOf(
        await v.call("get_outgoing_links", { vault: "test", path: "pub/Linker.md" }),
      );
      const byTarget = new Map((d.links as Array<Data>).map((l) => [l.target, l]));
      expect(byTarget.get("Open")).toMatchObject({ resolved: true, target_path: "pub/Open.md" });
      for (const t of ["Hidden", "Missing"]) {
        expect(byTarget.get(t)).toMatchObject({ resolved: false, target_path: null });
      }
      const un = dataOf(await v.call("find_unresolved_links", { vault: "test" }));
      expect((un.unresolved as Array<Data>).map((u) => u.target).sort()).toEqual([
        "Hidden",
        "Missing",
      ]);
    } finally {
      v.cleanup();
    }
  });

  it("a denied note's property links never surface as backlinks", async () => {
    const v = makeTestVault({ files, acl: { readPaths: ["pub/**"] } });
    try {
      const d = dataOf(await v.call("get_backlinks", { vault: "test", path: "pub/Open.md" }));
      expect((d.backlinks as Array<Data>).map((b) => b.source_path)).toEqual(["pub/Linker.md"]);
      expect(JSON.stringify(d)).not.toContain("secret/");
    } finally {
      v.cleanup();
    }
  });
});

describe("rename propagation reaches property links", () => {
  const hashOf = (r: ToolResult): string => {
    if (r.ok) throw new Error("expected an error result");
    return String((r.error.details as { args_hash?: string }).args_hash);
  };
  const files = {
    "Douglas Adams.md": "# DA\n",
    "Guide.md":
      '---\nauthor: "[[Douglas Adams]]"\nseries:\n  - "[[Douglas Adams|DNA]]"\n  - "[[Douglas Adams#Life]]"\n  - "[[Other]]"\ntitle: T\n---\nBody [[Douglas Adams]].\n',
    "Other.md": "# Other\n",
  };

  it("move_note rewrites quoted property links, keeping quotes, alias, heading and other keys", async () => {
    const v = makeTestVault({ files });
    try {
      const input = { vault: "test", from: "Douglas Adams.md", to: "people/Douglas Noel Adams.md" };
      const need = await v.call("move_note", input);
      expect(need.ok).toBe(false);
      const moved = await v.call("move_note", input, {
        elicitToken: issueElicitToken(v.db, {
          vaultId: v.id,
          toolName: "move_note",
          argsHash: hashOf(need),
          caller: "test",
        }),
      });
      expect(moved.ok).toBe(true);
      expect(v.read("Guide.md")).toBe(
        '---\nauthor: "[[Douglas Noel Adams]]"\nseries:\n  - "[[Douglas Noel Adams|DNA]]"\n  - "[[Douglas Noel Adams#Life]]"\n  - "[[Other]]"\ntitle: T\n---\nBody [[Douglas Noel Adams]].\n',
      );
      // and the graph still sees them: no link went stale
      const un = dataOf(await v.call("find_unresolved_links", { vault: "test" }));
      expect(un.unresolved).toEqual([]);
    } finally {
      v.cleanup();
    }
  });

  it("rewrite_link repoints property links too", async () => {
    const v = makeTestVault({ files });
    try {
      const input = {
        vault: "test",
        from_target: "Other",
        to_target: "Another",
        dry_run: false,
      };
      const need = await v.call("rewrite_link", input);
      expect(need.ok).toBe(false);
      const done = await v.call("rewrite_link", input, {
        elicitToken: issueElicitToken(v.db, {
          vaultId: v.id,
          toolName: "rewrite_link",
          argsHash: hashOf(need),
          caller: "test",
        }),
      });
      expect(dataOf(done).links_rewritten).toBe(1);
      expect(v.read("Guide.md")).toContain('  - "[[Another]]"');
    } finally {
      v.cleanup();
    }
  });
});

describe("graph edges", () => {
  const notePaths = ["A.md", "B.md", "Excluded.md"];
  const noteLinks = (raw: string) => {
    const p = parseNote(raw);
    return extractNoteLinks(p);
  };

  it("a resolved property link is a property_link edge pair; unresolved is an unresolved edge", () => {
    const edges = desiredEdges(
      new Map([["A.md", noteLinks('---\nup: "[[B]]"\nx: "[[Ghost]]"\n---\n')]]),
      notePaths,
    );
    expect(edges).toEqual(
      expect.arrayContaining([
        {
          source_path: "A.md",
          target_path: "B.md",
          edge_type: "property_link",
          provenance: "property_forward",
        },
        {
          source_path: "B.md",
          target_path: "A.md",
          edge_type: "property_link",
          provenance: "property_reverse",
        },
        {
          source_path: "A.md",
          target_path: "Ghost",
          edge_type: "unresolved",
          provenance: "unresolved",
        },
      ]),
    );
    expect(edges.some((e) => e.edge_type === "links_to")).toBe(false);
  });

  it("a body link and a property link to the same note keep the body links_to edge as well", () => {
    const edges = desiredEdges(
      new Map([["A.md", noteLinks('---\nup: "[[B]]"\n---\n[[B]]\n')]]),
      notePaths,
    );
    expect(edges.map((e) => e.edge_type).sort()).toEqual([
      "links_to",
      "links_to",
      "property_link",
      "property_link",
    ]);
  });

  it("an Excluded-files note is still a link TARGET (resolves) but gets no graph edge", () => {
    const edges = desiredEdges(
      new Map([["A.md", noteLinks('---\nup: "[[Excluded]]"\n---\n')]]),
      notePaths,
      new Set(["Excluded.md"]),
    );
    expect(edges).toEqual([]); // resolved => not unresolved, and the edge is omitted
  });

  it("property_link edges are reconciled (and pruned) with the other literal edges", () => {
    const db = openMemoryDb();
    db.exec(
      `CREATE TABLE vault_edges (
         source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
         edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
         created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
       CREATE UNIQUE INDEX u ON vault_edges(vault_id, source_path, target_path, edge_type);`,
    );
    const withProp = desiredEdges(
      new Map([["A.md", noteLinks('---\nup: "[[B]]"\n---\n')]]),
      notePaths,
    );
    expect(reconcileVaultEdges(db, "v", withProp)).toMatchObject({ inserted: 2, deleted: 0 });
    const gone = desiredEdges(new Map([["A.md", noteLinks("---\n---\n")]]), notePaths);
    expect(reconcileVaultEdges(db, "v", gone)).toMatchObject({ inserted: 0, deleted: 2 });
  });

  it("ranking gate: the default literal walk ignores property_link; includeDerived (densify.includeInWalk) crosses it", () => {
    const db = openMemoryDb();
    db.exec(
      `CREATE TABLE vault_edges (
         source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
         edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
         confidence REAL, source_fingerprint TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
    );
    db.prepare(
      "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, edge_kind, provenance, created_at, updated_at) VALUES ('v','A.md','B.md','property_link','literal','property_forward',1,1)",
    ).run();
    expect(expandGraphLiteral(db, ["A.md"], { vaultId: "v" })).toEqual([]);
    const gated = expandGraphLiteral(db, ["A.md"], { vaultId: "v", includeDerived: true });
    expect(gated.map((n) => [n.path, n.edge_kind, n.via_edge_type])).toEqual([
      ["B.md", "literal", "property_link"],
    ]);
  });
});

describe("index_vault records property links", () => {
  const files = {
    "A.md": '---\nup: "[[B]]"\nx: "[[Ghost]]"\n---\nbody\n',
    "B.md": "# B\n",
    "Broken.md": '---\nup: "[[B]]\ntags: [a\n---\nBody [[A]].\n',
  };
  it("writes property_link edges; a malformed-YAML note is counted and keeps only its body edges", async () => {
    const v = makeM2Vault({ files });
    try {
      const r = dataOf(await v.call("index_vault", { vault: v.id }));
      expect(r.notes_frontmatter_failed).toBe(1);
      const rows = v.db
        .prepare("SELECT source_path, target_path, edge_type FROM vault_edges WHERE vault_id = ?")
        .all(v.id) as Array<{ source_path: string; target_path: string; edge_type: string }>;
      const has = (s: string, t: string, type: string) =>
        rows.some((e) => e.source_path === s && e.target_path === t && e.edge_type === type);
      expect(has("A.md", "B.md", "property_link")).toBe(true);
      expect(has("A.md", "Ghost", "unresolved")).toBe(true);
      expect(has("Broken.md", "A.md", "links_to")).toBe(true);
      expect(has("Broken.md", "B.md", "property_link")).toBe(false);
    } finally {
      v.cleanup();
    }
  });
});

describe("attachment references", () => {
  it("an image used only as a property value (cover) is still referenced", async () => {
    const v = makeTestVault({
      files: {
        "post.md": '---\ncover: "[[hero.png]]"\n---\nno body links\n',
        "broken.md": '---\ncover: "[[hero.png]]\n---\n![[other.png]]\n',
      },
    });
    try {
      expect(findAttachmentReferences(v.root, "hero.png")).toEqual(["post.md"]);
      expect(findAttachmentReferences(v.root, "other.png")).toEqual(["broken.md"]);
    } finally {
      v.cleanup();
    }
  });
});
