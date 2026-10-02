// Memory WRITE ACL: write:memory is not enough, the caller also needs the folder write ACL on the
// entity's projection path (<memoryFolder>/<type>/<name>.md) in BOTH modes. `materialize: false`
// only skips the .md write; the SQLite row (the source of truth, and what get_entity returns) is
// created, extended, linked, renamed or deleted either way, so the path gate cannot depend on it.
// Every case holds read access to memory/** and withholds write (or delete) on memory/tool/**.
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { type ToolResult, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import type { CallerContext } from "../src/mcp/registry";
import { countByRuleAndFile, scanSource } from "./ast-source-scan";
import { type M5Vault, makeM5Vault } from "./m5-helpers";

const V = VaultId.parse("test");
const NO_TOOL_WRITES = { writePaths: ["memory/person/**"] };
const NO_TOOL_DELETES = { deletePaths: ["memory/person/**"] };
// Seeding runs unrestricted, like an operator preparing the graph before narrowing the caller.
const SETUP: Partial<CallerContext> = {
  acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
  now: () => 100,
};

const rows = (v: M5Vault) =>
  v.db.prepare("SELECT COUNT(*) AS n FROM memory_entities").get() as { n: number };
const edges = (v: M5Vault) =>
  v.db.prepare("SELECT COUNT(*) AS n FROM memory_relations").get() as { n: number };

async function seed(
  v: M5Vault,
  type: string,
  name: string,
  materialize: boolean,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const r = await v.call("create_entity", { vault: V, type, name, materialize, ...extra }, SETUP);
  if (!r.ok) throw new Error(`create_entity failed: ${JSON.stringify(r.error)}`);
  return (r.data as { entity_id: string }).entity_id;
}

const denied = (r: ToolResult) => !r.ok && r.error.code === "acl_denied";
const shape = (r: ToolResult) => JSON.stringify(r.ok ? { data: r.data } : { error: r.error });

describe("create_entity requires the projection path's write ACL in both modes", () => {
  for (const materialize of [false, true]) {
    it(`unwritable folder is acl_denied and no row is created (materialize=${materialize})`, async () => {
      const v = makeM5Vault({ acl: NO_TOOL_WRITES });
      try {
        const r = await v.call("create_entity", { vault: V, type: "tool", name: "X", materialize });
        expect(denied(r)).toBe(true);
        expect(rows(v).n).toBe(0);
      } finally {
        v.cleanup();
      }
    });

    it(`existing row == absent row for an unwritable folder (materialize=${materialize})`, async () => {
      const existing = makeM5Vault({ acl: NO_TOOL_WRITES });
      const absent = makeM5Vault({ acl: NO_TOOL_WRITES });
      try {
        await seed(existing, "tool", "X", materialize);
        const input = { vault: V, type: "tool", name: "X", materialize };
        const a = await existing.call("create_entity", input);
        const b = await absent.call("create_entity", input);
        expect(denied(a)).toBe(true);
        expect(shape(a)).toBe(shape(b));
        expect(rows(absent).n).toBe(0);
      } finally {
        existing.cleanup();
        absent.cleanup();
      }
    });
  }

  it("a writable folder still works with materialize:false, under every unrestricted shape", async () => {
    for (const acl of [undefined, NO_TOOL_WRITES, { writePaths: ["memory/**"] }]) {
      const v = makeM5Vault({ acl });
      try {
        const type = acl === NO_TOOL_WRITES ? "person" : "tool";
        const r = await v.call("create_entity", { vault: V, type, name: "X", materialize: false });
        expect(r.ok).toBe(true);
        expect(rows(v).n).toBe(1);
        expect(v.exists(`memory/${type}/X.md`)).toBe(false);
      } finally {
        v.cleanup();
      }
    }
  });
});

describe("every other memory write tool gates the projection path in both modes", () => {
  for (const materialize of [false, true]) {
    const label = `materialize=${materialize}`;

    it(`add_observation (${label})`, async () => {
      const v = makeM5Vault({ acl: NO_TOOL_WRITES });
      try {
        const id = await seed(v, "tool", "X", materialize);
        const r = await v.call("add_observation", { vault: V, entity_id: id, observation: "a" });
        expect(denied(r)).toBe(true);
        expect(
          v.db.prepare("SELECT observations FROM memory_entities WHERE id = ?").get(id),
        ).toEqual({ observations: "" });
      } finally {
        v.cleanup();
      }
    });

    it(`link_entities and unlink_entities (${label})`, async () => {
      const v = makeM5Vault({ acl: NO_TOOL_WRITES });
      try {
        const src = await seed(v, "tool", "X", materialize);
        const tgt = await seed(v, "person", "Ada", materialize);
        const input = { vault: V, source_id: src, target_id: tgt, relation_type: "knows" };
        expect(denied(await v.call("link_entities", input))).toBe(true);
        expect(edges(v).n).toBe(0);

        expect((await v.call("link_entities", input, SETUP)).ok).toBe(true);
        expect(denied(await v.call("unlink_entities", input))).toBe(true);
        expect(edges(v).n).toBe(1);
      } finally {
        v.cleanup();
      }
    });

    it(`rename_entity, name and status-only (${label})`, async () => {
      const v = makeM5Vault({ acl: NO_TOOL_WRITES });
      try {
        const id = await seed(v, "tool", "X", materialize);
        const byName = await v.call("rename_entity", { vault: V, entity_id: id, new_name: "Y" });
        const byStatus = await v.call("rename_entity", {
          vault: V,
          entity_id: id,
          status: "retired",
        });
        expect(denied(byName)).toBe(true);
        expect(denied(byStatus)).toBe(true);
        expect(
          v.db.prepare("SELECT name, status FROM memory_entities WHERE id = ?").get(id),
        ).toEqual({ name: "X", status: "active" });
      } finally {
        v.cleanup();
      }
    });

    it(`delete_entity needs the delete ACL on the path (${label})`, async () => {
      const v = makeM5Vault({ acl: NO_TOOL_DELETES });
      try {
        const id = await seed(v, "tool", "X", materialize);
        const r = await v.callConfirmed("delete_entity", { vault: V, entity_id: id });
        expect(denied(r)).toBe(true);
        expect(rows(v).n).toBe(1);
      } finally {
        v.cleanup();
      }
    });
  }

  // Relations are two-ended: the edge is the target's incoming relation in get_entity, so a caller
  // who can write only the SOURCE's path must not be able to add or remove it.
  for (const materialize of [false, true]) {
    it(`link/unlink need write on the TARGET path too: writable source, unwritable target (materialize=${materialize})`, async () => {
      const v = makeM5Vault({ acl: { writePaths: ["memory/tool/**"] } });
      try {
        const src = await seed(v, "tool", "Source", materialize);
        const tgt = await seed(v, "person", "Target", materialize);
        const input = { vault: V, source_id: src, target_id: tgt, relation_type: "controls" };
        expect(denied(await v.call("link_entities", input))).toBe(true);
        expect(edges(v).n).toBe(0);

        expect((await v.call("link_entities", input, SETUP)).ok).toBe(true);
        expect(denied(await v.call("unlink_entities", input))).toBe(true);
        expect(edges(v).n).toBe(1);
      } finally {
        v.cleanup();
      }
    });

    it(`link/unlink work when BOTH endpoints are writable (materialize=${materialize})`, async () => {
      const v = makeM5Vault({ acl: { writePaths: ["memory/tool/**", "memory/person/**"] } });
      try {
        const src = await seed(v, "tool", "Source", materialize);
        const tgt = await seed(v, "person", "Target", materialize);
        const input = { vault: V, source_id: src, target_id: tgt, relation_type: "controls" };
        expect((await v.call("link_entities", input)).ok).toBe(true);
        expect(edges(v).n).toBe(1);
        expect((await v.call("unlink_entities", input)).ok).toBe(true);
        expect(edges(v).n).toBe(0);
      } finally {
        v.cleanup();
      }
    });
  }

  it("deleting an entity you own still removes its edges to entities you cannot write", async () => {
    const v = makeM5Vault({
      acl: { writePaths: ["memory/tool/**"], deletePaths: ["memory/tool/**"] },
    });
    try {
      const src = await seed(v, "tool", "Source", false);
      const tgt = await seed(v, "person", "Target", false);
      const rel = { vault: V, source_id: src, target_id: tgt, relation_type: "controls" };
      expect((await v.call("link_entities", rel, SETUP)).ok).toBe(true);
      const r = await v.callConfirmed("delete_entity", {
        vault: V,
        entity_id: src,
        cascade: true,
      });
      expect(r.ok).toBe(true);
      expect(edges(v).n).toBe(0);
    } finally {
      v.cleanup();
    }
  });

  it("a fully writable caller keeps every tool working on a materialize:false entity", async () => {
    const v = makeM5Vault({ acl: { writePaths: ["memory/**"], deletePaths: ["memory/**"] } });
    try {
      const a = await seed(v, "tool", "X", false);
      const b = await seed(v, "person", "Ada", false);
      const rel = { vault: V, source_id: a, target_id: b, relation_type: "knows" };
      expect(
        (await v.call("add_observation", { vault: V, entity_id: a, observation: "o" })).ok,
      ).toBe(true);
      expect((await v.call("link_entities", rel)).ok).toBe(true);
      expect((await v.call("unlink_entities", rel)).ok).toBe(true);
      expect((await v.call("rename_entity", { vault: V, entity_id: a, new_name: "Y" })).ok).toBe(
        true,
      );
      expect((await v.callConfirmed("delete_entity", { vault: V, entity_id: a })).ok).toBe(true);
      expect(rows(v).n).toBe(1);
    } finally {
      v.cleanup();
    }
  });
});

// The write predicate is enforcePathAcl("write"/"delete") on the bound vault root, exactly like the
// read side's callerCanReadVaultPath: no lexical or "unrestricted caller" shortcut, so a symlinked
// projection folder is judged by where it REALLY points (the REAL path is what the ACL sees).
let symlinkOk = true;
try {
  const probe = makeM5Vault();
  try {
    mkdirSync(join(probe.root, "t"));
    symlinkSync(join(probe.root, "t"), join(probe.root, "l"), "dir");
  } finally {
    probe.cleanup();
  }
} catch {
  symlinkOk = false; // Windows without the privilege to create symlinks
}

describe.skipIf(!symlinkOk)("the write gate resolves symlinks like write_note", () => {
  for (const materialize of [false, true]) {
    it(`a memory folder symlinked into a non-writable folder is acl_denied (materialize=${materialize})`, async () => {
      const v = makeM5Vault({ acl: { writePaths: ["memory/**"] } });
      try {
        mkdirSync(join(v.root, "memory"), { recursive: true });
        mkdirSync(join(v.root, "locked"));
        symlinkSync(join(v.root, "locked"), join(v.root, "memory", "tool"), "dir");
        const r = await v.call("create_entity", { vault: V, type: "tool", name: "X", materialize });
        expect(denied(r)).toBe(true);
        expect(rows(v).n).toBe(0);
      } finally {
        v.cleanup();
      }
    });
  }
});

// Structural pin (ast-grep, like m5-memory-lookup-guard): which memory tool files reach the write
// ACL, and how. A new write tool that forgets the gate, or a file that re-implements it lexically,
// changes these counts and has to be justified here.
describe("memory write gates are accounted for", () => {
  const SRC = join(import.meta.dirname, "..", "src");
  const callRule = (id: string, name: string) => `id: ${id}
language: ts
rule:
  kind: call_expression
  has:
    field: function
    kind: identifier
    regex: '^${name}$'
`;
  const found = countByRuleAndFile(
    scanSource(
      join(SRC, "tools", "m5"),
      [callRule("writable", "assertMemoryPathWritable"), callRule("raw", "enforcePathAcl")].join(
        "---\n",
      ),
    ),
    [],
  );

  it("every memory write tool runs assertMemoryPathWritable (create 1, add_observation 1, update_observation 1, link 2, rename 2, unlink 2, delete 1)", () => {
    expect(found.writable).toEqual({
      "memory-tools.ts": 4,
      "memory-lifecycle-tools.ts": 5,
      "memory-observation-tools.ts": 1,
    });
  });

  it("the only raw enforcePathAcl in the memory tools are the helper itself and planNeighbors' quiet probe", () => {
    expect(found.raw?.["memory-projection.ts"]).toBe(2);
    expect(found.raw?.["memory-tools.ts"]).toBeUndefined();
    expect(found.raw?.["memory-lifecycle-tools.ts"]).toBeUndefined();
  });
});
