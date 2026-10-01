// Memory READ tools honor the caller's folder read ACL. An entity's own projection note is
// <memoryFolder>/<type>/<name>.md and it renders the same observations and [[links]] get_entity
// returns, so an entity is readable exactly when read_note could read that note. Denied == missing:
// an unreadable entity yields the byte-identical error a nonexistent one does, on every tool that
// looks an entity up (read AND write), and a graph walk never traverses an unreadable node.
import { type ToolResult, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier } from "../src/elicit";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { insertEntity } from "../src/memory/entities";
import { registerM5Tools } from "../src/tools/m5";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { type M5Vault, makeM5Vault } from "./m5-helpers";
import { makeTempDir, rmTemp } from "./tmp";

const V = "test";
// Memory reads under a restricted vault: only public/** is readable, so memory/** is not.
const PUBLIC_ONLY = { readPaths: ["public/**"] };
// Fixtures that wire an edge or rename an entity the restricted caller itself could not read run
// under an unrestricted ACL, like an operator seeding the graph before narrowing readPaths.
const SETUP = { acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }) };

async function create(
  v: M5Vault,
  type: string,
  name: string,
  extra: Record<string, unknown> = {},
  over: Partial<CallerContext> = {},
): Promise<string> {
  const r = await v.call(
    "create_entity",
    { vault: V, type, name, ...extra },
    // Seeding runs unrestricted: creating an entity now needs READ on its note path as well (see
    // m5-memory-read-acl-leaks.test.ts), and these fixtures create entities the restricted caller
    // under test is meant NOT to see.
    { now: () => 100, ...SETUP, ...over },
  );
  if (!r.ok) throw new Error(`create_entity failed: ${JSON.stringify(r.error)}`);
  return (r.data as { entity_id: string }).entity_id;
}

async function link(v: M5Vault, source: string, target: string, type = "knows"): Promise<void> {
  const r = await v.call(
    "link_entities",
    { vault: V, source_id: source, target_id: target, relation_type: type },
    SETUP,
  );
  if (!r.ok) throw new Error(`link_entities failed: ${JSON.stringify(r.error)}`);
}

/** The error of a failed call, with every occurrence of `id` neutralised so two calls that differ
 *  only in WHICH id the caller sent can be compared byte for byte. */
function errorOf(r: ToolResult, id?: string): string {
  if (r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r.data)}`);
  const text = JSON.stringify(r.error);
  return id === undefined ? text : text.split(id).join("<id>");
}

const ids = (r: ToolResult): string[] =>
  r.ok ? (r.data as { items: { entity_id: string }[] }).items.map((i) => i.entity_id) : [];

describe("get_entity honors the read ACL", () => {
  it("(1) by id, by type+name and by name: unreadable == the error a nonexistent entity gets", async () => {
    const v = makeM5Vault({ acl: PUBLIC_ONLY });
    try {
      const id = await create(v, "person", "Ada", { observations: ["secret fact"] });
      const byId = await v.call("get_entity", { vault: V, entity_id: id });
      const missingById = await v.call("get_entity", { vault: V, entity_id: "ent_nonexistent" });
      expect(errorOf(byId)).toBe(errorOf(missingById));

      const byTypeName = await v.call("get_entity", { vault: V, type: "person", name: "Ada" });
      const missingTypeName = await v.call("get_entity", { vault: V, type: "person", name: "Zed" });
      expect(errorOf(byTypeName)).toBe(errorOf(missingTypeName));

      const byName = await v.call("get_entity", { vault: V, name: "Ada" });
      const missingName = await v.call("get_entity", { vault: V, name: "Zed" });
      expect(errorOf(byName)).toBe(errorOf(missingName));
      expect(errorOf(byName)).toContain("entity not found");
    } finally {
      v.cleanup();
    }
  });

  it("(2) two same-name entities, one unreadable: a single hit, not 'ambiguous'", async () => {
    const v = makeM5Vault({ acl: { readPaths: ["memory/place/**"] } });
    try {
      await create(v, "person", "Mercury");
      const placeId = await create(v, "place", "Mercury");
      const r = await v.call("get_entity", { vault: V, name: "Mercury" });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { entity_id: string }).entity_id).toBe(placeId);
    } finally {
      v.cleanup();
    }
  });

  it("(3) relations omit an unreadable neighbor (outgoing and incoming)", async () => {
    const v = makeM5Vault({ acl: { readPaths: ["memory/person/**"] } });
    try {
      const a = await create(v, "person", "A");
      const hidden = await create(v, "tool", "Hidden");
      const c = await create(v, "person", "C");
      await link(v, a, hidden);
      await link(v, hidden, a, "uses");
      await link(v, a, c);
      const r = await v.call("get_entity", { vault: V, entity_id: a });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const rel = (r.data as { relations: { target_id: string }[] }).relations;
        expect(rel.map((x) => x.target_id)).toEqual([c]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("(6) a materialize:false entity is gated through the COMPUTED projection path", async () => {
    const closed = makeM5Vault({ acl: PUBLIC_ONLY });
    const open = makeM5Vault({ acl: { readPaths: ["public/**", "memory/**"] } });
    try {
      for (const v of [closed, open]) await create(v, "person", "Ghost", { materialize: false });
      const hidden = await closed.call("get_entity", { vault: V, type: "person", name: "Ghost" });
      expect(hidden.ok).toBe(false);
      expect(closed.exists("memory/person/Ghost.md")).toBe(false);
      const shown = await open.call("get_entity", { vault: V, type: "person", name: "Ghost" });
      expect(shown.ok).toBe(true);
    } finally {
      closed.cleanup();
      open.cleanup();
    }
  });

  it("(7) a rule-scoped memory folder is hidden from a caller without the scope", async () => {
    const acl = { rules: [{ glob: "memory/**", scopes: ["scope:memory-read"] }] };
    const v = makeM5Vault({ acl });
    try {
      const id = await create(v, "person", "Scoped");
      const lacking = new Set(["read:memory", "write:memory"]);
      const denied = await v.call(
        "get_entity",
        { vault: V, entity_id: id },
        { grantedScopes: lacking },
      );
      const missing = await v.call(
        "get_entity",
        { vault: V, entity_id: "ent_nonexistent" },
        { grantedScopes: lacking },
      );
      expect(errorOf(denied)).toBe(errorOf(missing));
      const holding = new Set(["read:memory", "scope:memory-read"]);
      const ok = await v.call(
        "get_entity",
        { vault: V, entity_id: id },
        { grantedScopes: holding },
      );
      expect(ok.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("(8) response_format concise and detailed gate identically", async () => {
    const closed = makeM5Vault({ acl: PUBLIC_ONLY });
    const open = makeM5Vault();
    try {
      const idClosed = await create(closed, "person", "Ada");
      const idOpen = await create(open, "person", "Ada");
      for (const response_format of ["concise", "detailed"]) {
        const denied = await closed.call("get_entity", {
          vault: V,
          entity_id: idClosed,
          response_format,
        });
        expect(denied.ok).toBe(false);
        const shown = await open.call("get_entity", {
          vault: V,
          entity_id: idOpen,
          response_format,
        });
        expect(shown.ok).toBe(true);
      }
      for (const response_format of ["concise", "detailed"]) {
        const g = await closed.call("query_entity_graph", {
          vault: V,
          seed_entity_id: idClosed,
          response_format,
        });
        expect(g.ok).toBe(false);
      }
    } finally {
      closed.cleanup();
      open.cleanup();
    }
  });

  it("(9) unrestricted callers see everything: default config, writePaths-only, strictReadDefault off", async () => {
    for (const acl of [undefined, { writePaths: ["memory/**"] }, { readOnly: false }]) {
      const v = makeM5Vault(acl ? { acl } : {});
      try {
        const id = await create(v, "person", "Open");
        const r = await v.call("get_entity", { vault: V, entity_id: id });
        expect(r.ok).toBe(true);
      } finally {
        v.cleanup();
      }
    }
  });

  it("(9b) strictReadDefault with no readPaths hides memory; readPaths naming it restores it", async () => {
    const strict = makeM5Vault({ acl: { strictReadDefault: true } });
    const named = makeM5Vault({ acl: { strictReadDefault: true, readPaths: ["memory/**"] } });
    try {
      const a = await create(strict, "person", "Ada");
      const b = await create(named, "person", "Ada");
      expect((await strict.call("get_entity", { vault: V, entity_id: a })).ok).toBe(false);
      expect((await named.call("get_entity", { vault: V, entity_id: b })).ok).toBe(true);
    } finally {
      strict.cleanup();
      named.cleanup();
    }
  });

  it("(10) the decision uses the CURRENT note path, never a stale vault_path", async () => {
    const v = makeM5Vault({ acl: { readPaths: ["public/**"] } });
    try {
      const id = await create(v, "person", "Old");
      const renamed = await v.call(
        "rename_entity",
        { vault: V, entity_id: id, new_name: "New" },
        SETUP,
      );
      expect(renamed.ok).toBe(true);
      // A stale vault_path pointing somewhere readable must not grant access to the current note.
      v.db
        .prepare("UPDATE memory_entities SET vault_path = ? WHERE id = ?")
        .run("public/old.md", id);
      expect((await v.call("get_entity", { vault: V, entity_id: id })).ok).toBe(false);
    } finally {
      v.cleanup();
    }
    // Both the stored path and the current path must be readable (fail closed on a disagreement).
    const w = makeM5Vault({ acl: { readPaths: ["memory/person/New.md"] } });
    try {
      const id = await create(w, "person", "Old");
      await w.call("rename_entity", { vault: V, entity_id: id, new_name: "New" }, SETUP);
      expect((await w.call("get_entity", { vault: V, entity_id: id })).ok).toBe(true);
      w.db
        .prepare("UPDATE memory_entities SET vault_path = ? WHERE id = ?")
        .run("memory/person/Old.md", id);
      expect((await w.call("get_entity", { vault: V, entity_id: id })).ok).toBe(false);
    } finally {
      w.cleanup();
    }
  });
});

describe("query_entity_graph honors the read ACL", () => {
  it("(4) A(readable)-B(unreadable)-C(readable), depth 2 from A: C is NOT reached through B", async () => {
    const v = makeM5Vault({ acl: { readPaths: ["memory/person/**"] } });
    try {
      const a = await create(v, "person", "A");
      const b = await create(v, "tool", "B");
      const c = await create(v, "person", "C");
      await link(v, a, b);
      await link(v, b, c);
      const r = await v.call("query_entity_graph", { vault: V, seed_entity_id: a, depth: 2 });
      expect(r.ok).toBe(true);
      expect(ids(r)).toEqual([]);
      if (r.ok) {
        const d = r.data as { next_cursor: string | null; total_returned: number };
        expect(d.next_cursor).toBeNull();
        expect(d.total_returned).toBe(0);
      }
      // A direct readable edge still works, so the empty result above is not a broken walk.
      await link(v, a, c);
      expect(
        ids(await v.call("query_entity_graph", { vault: V, seed_entity_id: a, depth: 2 })),
      ).toEqual([c]);
    } finally {
      v.cleanup();
    }
  });

  it("(4b) pagination counts exclude unreadable nodes", async () => {
    const v = makeM5Vault({ acl: { readPaths: ["memory/person/**"] } });
    try {
      const a = await create(v, "person", "A");
      const hidden = await create(v, "tool", "Hidden");
      const d1 = await create(v, "person", "D1");
      const d2 = await create(v, "person", "D2");
      for (const t of [hidden, d1, d2]) await link(v, a, t);
      const p1 = await v.call("query_entity_graph", { vault: V, seed_entity_id: a, limit: 1 });
      const cursor = p1.ok ? (p1.data as { next_cursor: string | null }).next_cursor : null;
      expect(ids(p1)).toHaveLength(1);
      expect(cursor).not.toBeNull();
      const p2 = await v.call("query_entity_graph", {
        vault: V,
        seed_entity_id: a,
        limit: 1,
        cursor: cursor as string,
      });
      expect(ids(p2)).toHaveLength(1);
      expect(p2.ok && (p2.data as { next_cursor: string | null }).next_cursor).toBeNull();
      expect([...ids(p1), ...ids(p2)].sort()).toEqual([d1, d2].sort());
    } finally {
      v.cleanup();
    }
  });

  it("(5) an unreadable seed == 'seed entity not found', same as a nonexistent seed", async () => {
    const v = makeM5Vault({ acl: PUBLIC_ONLY });
    try {
      const id = await create(v, "person", "Ada");
      const hidden = await v.call("query_entity_graph", { vault: V, seed_entity_id: id });
      const missing = await v.call("query_entity_graph", {
        vault: V,
        seed_entity_id: "ent_nonexistent",
      });
      expect(errorOf(hidden, id)).toBe(errorOf(missing, "ent_nonexistent"));
      expect(errorOf(hidden)).toContain("seed entity not found");
    } finally {
      v.cleanup();
    }
  });
});

describe("per-vault ACL binding", () => {
  it("(7b) each vault's own read ACL decides; a second vault with a different ACL is not the first's", async () => {
    const rootA = makeTempDir("obtc-m5-a-");
    const rootB = makeTempDir("obtc-m5-b-");
    const db = openMemoryDb();
    provisionCacheDb(db);
    const acls = new Map<string, FolderAcl>([
      [
        "va",
        new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], readPaths: ["memory/**"] }),
      ],
      [
        "vb",
        new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], readPaths: ["public/**"] }),
      ],
    ]);
    const open = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
    const registry = new ToolRegistry({
      verifyElicit: elicitVerifier,
      aclResolver: (id) => acls.get(id),
    });
    registerM5Tools(registry, {
      cacheDir: makeTempDir("obtc-m5-cache-"),
      vaultRegistry: new VaultRegistry([
        { id: "va", path: rootA },
        { id: "vb", path: rootB },
      ]),
      memoryFolder: () => "memory",
    });
    const call = (name: string, input: Record<string, unknown>) =>
      registry.dispatch(name, input, {
        caller: "test",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "va",
        db,
        acl: open,
      });
    try {
      const mk = async (vault: string) => {
        const r = await call("create_entity", {
          vault: VaultId.parse(vault),
          type: "person",
          name: "Ada",
        });
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        return (r.data as { entity_id: string }).entity_id;
      };
      const a = await mk("va");
      // vb's own ACL cannot read memory/**, so create_entity would now refuse: seed the row directly.
      const b = insertEntity(db, {
        vaultId: "vb",
        entityType: "person",
        name: "Ada",
        materialize: false,
        now: 100,
      }).id;
      expect((await call("get_entity", { vault: "va", entity_id: a })).ok).toBe(true);
      expect((await call("get_entity", { vault: "vb", entity_id: b })).ok).toBe(false);
    } finally {
      rmTemp(rootA);
      rmTemp(rootB);
    }
  });
});

describe("write/lifecycle tools are not an existence oracle for unreadable entities", () => {
  it("(11) add_observation / link / unlink / rename / delete on an unreadable entity == not found", async () => {
    const v = makeM5Vault({ acl: PUBLIC_ONLY });
    try {
      const id = await create(v, "person", "Ada");
      const other = await create(v, "person", "Bob");
      const gone = "ent_nonexistent";
      const goneOther = "ent_nonexistent2";
      const pairs: [string, Record<string, unknown>, Record<string, unknown>][] = [
        [
          "add_observation",
          { entity_id: id, observation: "x" },
          { entity_id: gone, observation: "x" },
        ],
        [
          "link_entities",
          { source_id: id, target_id: other, relation_type: "knows" },
          { source_id: gone, target_id: goneOther, relation_type: "knows" },
        ],
        [
          "unlink_entities",
          { source_id: id, target_id: other, relation_type: "knows" },
          { source_id: gone, target_id: goneOther, relation_type: "knows" },
        ],
        ["rename_entity", { entity_id: id, new_name: "Z" }, { entity_id: gone, new_name: "Z" }],
      ];
      for (const [tool, real, missing] of pairs) {
        const a = await v.call(tool, { vault: V, ...real });
        const b = await v.call(tool, { vault: V, ...missing });
        const norm = (r: ToolResult) =>
          errorOf(r)
            .split(id)
            .join("<id>")
            .split(other)
            .join("<id2>")
            .split(gone)
            .join("<id>")
            .split(goneOther)
            .join("<id2>");
        expect(norm(a), tool).toBe(norm(b));
        expect(norm(a), tool).toContain("not found");
      }
      const del = await v.callConfirmed("delete_entity", { vault: V, entity_id: id });
      const delMissing = await v.callConfirmed("delete_entity", { vault: V, entity_id: gone });
      expect(errorOf(del, id)).toBe(errorOf(delMissing, gone));
      // The entity is untouched by every refused call above.
      expect(
        v.db.prepare("SELECT COUNT(*) AS n FROM memory_entities WHERE id = ?").get(id),
      ).toEqual({ n: 1 });
    } finally {
      v.cleanup();
    }
  });
});

describe("a READABLE entity the caller cannot write keeps today's write-ACL refusal", () => {
  it("(11b) add_observation / link_entities: acl_denied BEFORE anything lands", async () => {
    const v = makeM5Vault({ acl: { writePaths: ["elsewhere/**"] } });
    try {
      const a = await create(v, "person", "A", {}, SETUP);
      const b = await create(v, "person", "B", {}, SETUP);
      const obs = await v.call("add_observation", { vault: V, entity_id: a, observation: "NOPE" });
      expect(!obs.ok && obs.error.code).toBe("acl_denied");
      const edge = await v.call("link_entities", {
        vault: V,
        source_id: a,
        target_id: b,
        relation_type: "NOPE",
      });
      expect(!edge.ok && edge.error.code).toBe("acl_denied");
      const row = v.db.prepare("SELECT observations FROM memory_entities WHERE id = ?").get(a);
      expect(row).toEqual({ observations: "" });
      expect(v.db.prepare("SELECT COUNT(*) AS n FROM memory_relations").get()).toEqual({ n: 0 });
    } finally {
      v.cleanup();
    }
  });
});
