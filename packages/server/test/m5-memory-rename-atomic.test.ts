// rename_entity and delete_entity are atomic against the vault: a refused or failed call leaves
// the notes exactly as they were, a rename onto its own path keeps the note it wrote, a permanent
// delete_entity snapshots the note it removes, and the index hears about neighbour rewrites even
// when the trash step throws after the commit.
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { buildSnapshotTools } from "../src/tools/m1/snapshot-tools";
import { VaultRegistry } from "../src/vault/registry";
import { type M5Vault, makeM5Vault } from "./m5-helpers";

// Forces trashNote to throw after the delete commits, for the trash-throws case only.
const trash = vi.hoisted(() => ({ fail: false }));
vi.mock("../src/vault/notes-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault/notes-io")>();
  return {
    ...actual,
    trashNote: (...args: Parameters<typeof actual.trashNote>) => {
      if (trash.fail) throw new Error("trash failed");
      return actual.trashNote(...args);
    },
  };
});

const ALICE = join("memory", "person", "Alice.md");
const ALICE2 = join("memory", "person", "Alice2.md");
const ACME = join("memory", "org", "Acme.md");
const ORG_DIR = join("memory", "org");
const SETUP = { acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }) };
const PERSON_ONLY = { writePaths: ["memory/person/**"], deletePaths: ["memory/person/**"] };
const denied = (r: { ok: boolean; error?: { code: string } }) =>
  !r.ok && r.error?.code === "acl_denied";
const isRoot = process.getuid?.() === 0;

function dataOf<T>(r: { ok: boolean; data?: unknown; error?: unknown }, call: string): T {
  if (!r.ok) throw new Error(`${call} failed: ${JSON.stringify(r.error)}`);
  return r.data as T;
}

/** Alice (person) and Acme (org) with Acme -> Alice "employs", seeded under a permissive ACL. */
async function seedPair(v: M5Vault): Promise<string> {
  const alice = dataOf<{ entity_id: string }>(
    await v.call("create_entity", { vault: "test", type: "person", name: "Alice" }, SETUP),
    "create_entity",
  ).entity_id;
  const acme = dataOf<{ entity_id: string }>(
    await v.call("create_entity", { vault: "test", type: "org", name: "Acme" }, SETUP),
    "create_entity",
  ).entity_id;
  dataOf(
    await v.call(
      "link_entities",
      { vault: "test", source_id: acme, target_id: alice, relation_type: "employs" },
      SETUP,
    ),
    "link_entities",
  );
  return alice;
}

async function nameOf(v: M5Vault, entityId: string): Promise<string> {
  const e = dataOf<{ name: string }>(
    await v.call("get_entity", { vault: "test", entity_id: entityId }),
    "get_entity",
  );
  return e.name;
}

describe("rename_entity and delete_entity leave the vault unchanged when they refuse", () => {
  it("rename refuses a read-only neighbour before any change", async () => {
    const reindex = vi.fn();
    const deindex = vi.fn();
    const v = makeM5Vault({ acl: PERSON_ONLY, reindex, deindex });
    try {
      const alice = await seedPair(v);
      const acmeBefore = v.read(ACME);
      reindex.mockClear();
      const r = await v.call("rename_entity", {
        vault: "test",
        entity_id: alice,
        new_name: "Alice2",
      });
      expect(denied(r)).toBe(true);
      expect(v.exists(ALICE)).toBe(true);
      expect(v.exists(ALICE2)).toBe(false);
      expect(v.read(ACME)).toBe(acmeBefore);
      expect(await nameOf(v, alice)).toBe("Alice");
      expect(reindex.mock.calls).toEqual([]);
      expect(deindex).not.toHaveBeenCalled();
    } finally {
      v.cleanup();
    }
  });

  it("cascade delete refuses a read-only neighbour before any change", async () => {
    const v = makeM5Vault({ acl: PERSON_ONLY });
    try {
      const alice = await seedPair(v);
      const acmeBefore = v.read(ACME);
      const r = await v.callConfirmed("delete_entity", {
        vault: "test",
        entity_id: alice,
        cascade: true,
        permanent: false,
      });
      expect(denied(r)).toBe(true);
      expect(v.exists(ALICE)).toBe(true);
      expect(v.read(ACME)).toBe(acmeBefore);
      expect(await nameOf(v, alice)).toBe("Alice");
    } finally {
      v.cleanup();
    }
  });
});

describe("a failed rename restores the notes it touched", () => {
  it.skipIf(process.platform === "win32" || isRoot)(
    "restores the target and neighbour notes when a neighbour write fails mid-transaction",
    async () => {
      const v = makeM5Vault();
      try {
        const alice = await seedPair(v);
        const acmeBefore = v.read(ACME);
        chmodSync(join(v.root, ORG_DIR), 0o555);
        try {
          const r = await v.call("rename_entity", {
            vault: "test",
            entity_id: alice,
            new_name: "Alice2",
          });
          expect(r.ok).toBe(false);
          expect(v.exists(ALICE)).toBe(true);
          expect(v.exists(ALICE2)).toBe(false);
          expect(v.read(ACME)).toBe(acmeBefore);
          expect(await nameOf(v, alice)).toBe("Alice");
        } finally {
          chmodSync(join(v.root, ORG_DIR), 0o755);
        }
      } finally {
        v.cleanup();
      }
    },
  );
});

describe("a rename onto the same path keeps the note it wrote", () => {
  it("a rename onto the same path keeps the note it wrote", async () => {
    const reindex = vi.fn();
    const deindex = vi.fn();
    const v = makeM5Vault({ reindex, deindex });
    try {
      const created = dataOf<{ entity_id: string }>(
        await v.call("create_entity", { vault: "test", type: "person", name: "a?b" }),
        "create_entity",
      );
      const sameNote = join("memory", "person", "a-b.md");
      expect(v.exists(sameNote)).toBe(true);
      const r = await v.call("rename_entity", {
        vault: "test",
        entity_id: created.entity_id,
        new_name: "a-b",
      });
      dataOf(r, "rename_entity");
      expect(v.exists(sameNote)).toBe(true);
      expect(deindex.mock.calls.map((c) => c[1])).not.toContain(sameNote);
      expect(reindex).toHaveBeenLastCalledWith("test", sameNote, v.read(sameNote));
    } finally {
      v.cleanup();
    }
  });
});

describe("delete_entity snapshots the note it removes", () => {
  it("permanent delete_entity snapshots the note so restore_note brings it back", async () => {
    const v = makeM5Vault({ snapshots: { enabled: true, retention: 5 } });
    try {
      const snapshotTools = buildSnapshotTools({
        vaultRegistry: new VaultRegistry([{ id: "test", path: v.root }]),
        version: "test",
        startedAt: 0,
        embeddings: { provider: "none", model: "none" },
        snapshots: { enabled: true, retention: 5 },
      });
      for (const tool of snapshotTools) v.registry.register(tool);

      const alice = await seedPair(v);
      const bytes = v.read(ALICE);
      const deleted = await v.callConfirmed("delete_entity", {
        vault: "test",
        entity_id: alice,
        cascade: true,
        permanent: true,
      });
      dataOf(deleted, "delete_entity");
      expect(v.exists(ALICE)).toBe(false);

      const list = dataOf<{ snapshots: { id: number; op: string }[] }>(
        await v.call("list_snapshots", { vault: "test", path: ALICE }),
        "list_snapshots",
      );
      expect(list.snapshots.map((s) => s.op)).toEqual(["delete_entity"]);

      const restored = await v.callConfirmed("restore_note", {
        vault: "test",
        path: ALICE,
        snapshot_id: list.snapshots[0]?.id as number,
      });
      dataOf(restored, "restore_note");
      expect(v.read(ALICE)).toBe(bytes);
    } finally {
      v.cleanup();
    }
  });

  it("delete_entity without snapshot config captures nothing", async () => {
    const v = makeM5Vault();
    try {
      const alice = await seedPair(v);
      const deleted = await v.callConfirmed("delete_entity", {
        vault: "test",
        entity_id: alice,
        cascade: true,
        permanent: true,
      });
      dataOf(deleted, "delete_entity");
      const n = v.db.prepare("SELECT COUNT(*) AS n FROM note_snapshots").get() as { n: number };
      expect(n.n).toBe(0);
    } finally {
      v.cleanup();
    }
  });
});

describe("the index hears about committed neighbour rewrites", () => {
  it("reindexes the committed neighbour rewrites when the trash throws", async () => {
    const reindex = vi.fn();
    const deindex = vi.fn();
    const v = makeM5Vault({ reindex, deindex });
    try {
      const alice = await seedPair(v);
      reindex.mockClear();
      trash.fail = true;
      const r = await v.callConfirmed("delete_entity", {
        vault: "test",
        entity_id: alice,
        cascade: true,
        permanent: false,
      });
      expect(r.ok).toBe(false);
      expect(reindex).toHaveBeenCalledWith("test", ACME, v.read(ACME));
    } finally {
      trash.fail = false;
      v.cleanup();
    }
  });
});
