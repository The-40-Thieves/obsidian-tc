// M5 materialization codec (THE-181, Domain 22). SQLite is authoritative; the .md
// note is a regenerable projection. Proves: deterministic render with [[links]];
// byte-idempotent re-materialization; UNKNOWN frontmatter preserved across a rewrite
// (M3 round-trip discipline); parse-back recovers observations + [[link]] targets
// including aliases/headings/blocks; path-safety (no traversal) and ACL enforcement.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import {
  entityNotePath,
  materializeEntity,
  parseEntityNote,
  renderEntityNote,
} from "../src/memory/materialize";

function tempVault(): {
  root: string;
  cleanup: () => void;
  write: (rel: string, c: string) => void;
} {
  const root = mkdtempSync(join(tmpdir(), "obtc-mat-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    write: (rel, c) => {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, c, "utf8");
    },
  };
}
const acl = (over: Partial<AclConfigT> = {}) =>
  new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], ...over });

describe("entityNotePath", () => {
  it("builds <folder>/<type>/<name>.md and sanitizes separators (no traversal)", () => {
    expect(entityNotePath("memory", "person", "Ada Lovelace")).toBe(
      "memory/person/Ada Lovelace.md",
    );
    expect(entityNotePath("memory/", "person", "../escape")).toBe("memory/person/..-escape.md");
    expect(entityNotePath("memory", "p", "a/b:c")).toBe("memory/p/a-b-c.md");
  });
});

describe("renderEntityNote", () => {
  it("emits owned frontmatter, an H1, observation bullets, and [[links]]; is deterministic", () => {
    const out = renderEntityNote({
      id: "ent_1",
      entityType: "person",
      name: "Ada",
      observations: ["mathematician"],
      relations: [{ relationType: "collaborated_with", targetName: "Babbage" }],
    });
    expect(out).toContain("obsidian_tc_id: ent_1");
    expect(out).toContain("entity_type: person");
    expect(out).toContain("# Ada");
    expect(out).toContain("- mathematician");
    expect(out).toContain("- collaborated_with [[Babbage]]");
    // Same inputs -> identical bytes (idempotent projection).
    expect(
      renderEntityNote({
        id: "ent_1",
        entityType: "person",
        name: "Ada",
        observations: ["mathematician"],
        relations: [{ relationType: "collaborated_with", targetName: "Babbage" }],
      }),
    ).toBe(out);
  });

  it("sorts relations deterministically regardless of input order", () => {
    const a = renderEntityNote({
      id: "e",
      entityType: "t",
      name: "N",
      observations: [],
      relations: [
        { relationType: "r", targetName: "Z" },
        { relationType: "r", targetName: "A" },
      ],
    });
    const b = renderEntityNote({
      id: "e",
      entityType: "t",
      name: "N",
      observations: [],
      relations: [
        { relationType: "r", targetName: "A" },
        { relationType: "r", targetName: "Z" },
      ],
    });
    expect(a).toBe(b);
    expect(a.indexOf("[[A]]")).toBeLessThan(a.indexOf("[[Z]]"));
  });
});

describe("materializeEntity", () => {
  it("writes the projection and is byte-idempotent on re-materialization", () => {
    const v = tempVault();
    try {
      const args = {
        root: v.root,
        acl: acl(),
        folder: "memory",
        id: "ent_1",
        entityType: "person",
        name: "Ada",
        observations: ["mathematician"],
        relations: [{ relationType: "knows", targetName: "Babbage" }],
      } as const;
      const r1 = materializeEntity({ ...args });
      expect(r1.vaultPath).toBe("memory/person/Ada.md");
      const first = readFileSync(join(v.root, r1.vaultPath), "utf8");
      const r2 = materializeEntity({ ...args });
      expect(readFileSync(join(v.root, r2.vaultPath), "utf8")).toBe(first);
      expect(r2.contentHash).toBe(r1.contentHash);
    } finally {
      v.cleanup();
    }
  });

  it("preserves unknown frontmatter and adds the new [[link]] on re-materialization", () => {
    const v = tempVault();
    try {
      const rel = "memory/person/Ada.md";
      // A note Obsidian (or the user) edited: extra frontmatter + an aliases key.
      v.write(
        rel,
        "---\nobsidian_tc_id: ent_1\nentity_type: person\ncssclasses:\n  - wide\naliases:\n  - Countess\n---\n# Ada\n",
      );
      const r = materializeEntity({
        root: v.root,
        acl: acl(),
        folder: "memory",
        id: "ent_1",
        entityType: "person",
        name: "Ada",
        observations: ["mathematician"],
        relations: [{ relationType: "knows", targetName: "Babbage" }],
      });
      const after = readFileSync(join(v.root, r.vaultPath), "utf8");
      // Unknown keys survive...
      expect(after).toContain("cssclasses:");
      expect(after).toContain("- wide");
      expect(after).toContain("- Countess");
      // ...owned keys are regenerated from SQLite...
      expect(after).toContain("obsidian_tc_id: ent_1");
      expect(after).toContain("entity_type: person");
      // ...and the new relation [[link]] is present.
      expect(after).toContain("- knows [[Babbage]]");
      const parsed = parseEntityNote(after);
      expect(parsed.entityId).toBe("ent_1");
      expect(parsed.relatedTargets).toContain("Babbage");
      expect(parsed.observations).toEqual(["mathematician"]);
    } finally {
      v.cleanup();
    }
  });

  it("enforces the write ACL", () => {
    const v = tempVault();
    try {
      expect(() =>
        materializeEntity({
          root: v.root,
          acl: acl({ writePaths: ["allowed/**"] }),
          folder: "memory",
          id: "ent_1",
          entityType: "person",
          name: "Ada",
          observations: [],
          relations: [],
        }),
      ).toThrow(/acl|whitelist/i);
    } finally {
      v.cleanup();
    }
  });
});

describe("parseEntityNote [[link]] extraction", () => {
  it("recovers bare targets from aliases, headings, and block links", () => {
    const raw = [
      "---",
      "obsidian_tc_id: ent_x",
      "entity_type: concept",
      "---",
      "# Topic",
      "",
      "## Observations",
      "- a fact",
      "",
      "## Related",
      "- knows [[Alpha|the alias]]",
      "- cites [[Beta#Section heading]]",
      "- refs [[Gamma#^block-id]]",
      "",
    ].join("\n");
    const parsed = parseEntityNote(raw);
    expect(parsed.entityType).toBe("concept");
    expect(parsed.name).toBe("Topic");
    expect(parsed.observations).toEqual(["a fact"]);
    expect(parsed.relatedTargets).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});
