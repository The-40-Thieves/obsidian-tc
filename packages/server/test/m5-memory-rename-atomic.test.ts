// rename_entity and delete_entity are atomic against the vault: a refused or failed call leaves
// the notes exactly as they were, a rename onto its own path keeps the note it wrote, a permanent
// delete_entity snapshots the note it removes, and the index hears about neighbour rewrites even
// when the trash step throws after the commit.
import { chmodSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { buildSnapshotTools } from "../src/tools/m1/snapshot-tools";
import { VaultRegistry } from "../src/vault/registry";
import { type M5Vault, makeM5Vault } from "./m5-helpers";

// `trash.fail` forces trashNote to throw after the delete commits (the trash-throws case only).
// `hardDeleteFails.path` forces hardDelete to throw for that one file name (the old-note case only).
// `fsWrites` logs every note write or removal, so a refusal can be shown to touch nothing.
const trash = vi.hoisted(() => ({ fail: false }));
const hardDeleteFails = vi.hoisted(() => ({ name: undefined as string | undefined }));
const fsWrites = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("../src/vault/notes-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault/notes-io")>();
  return {
    ...actual,
    writeNoteAtomic: (...args: Parameters<typeof actual.writeNoteAtomic>) => {
      fsWrites.paths.push(args[0]);
      return actual.writeNoteAtomic(...args);
    },
    hardDelete: (...args: Parameters<typeof actual.hardDelete>) => {
      fsWrites.paths.push(args[0]);
      if (hardDeleteFails.name !== undefined && basename(args[0]) === hardDeleteFails.name)
        throw new Error("hardDelete failed");
      return actual.hardDelete(...args);
    },
    trashNote: (...args: Parameters<typeof actual.trashNote>) => {
      if (trash.fail) throw new Error("trash failed");
      return actual.trashNote(...args);
    },
  };
});

// Vault-relative note paths are forward-slash literals (the hooks receive them that way on every OS);
// join() is only for filesystem calls.
const ALICE = "memory/person/Alice.md";
const ALICE2 = "memory/person/Alice2.md";
const ACME = "memory/org/Acme.md";
const ORG_DIR = "memory/org";
const TEAM_DIR = "memory/team";
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

/** seedPair plus Bob (team), who also links to Alice. Acme is linked first, so its note is
 *  rewritten before Bob's (in memory/team) is attempted. */
async function seedTriple(v: M5Vault): Promise<string> {
  const alice = await seedPair(v);
  const bob = dataOf<{ entity_id: string }>(
    await v.call("create_entity", { vault: "test", type: "team", name: "Bob" }, SETUP),
    "create_entity",
  ).entity_id;
  dataOf(
    await v.call(
      "link_entities",
      { vault: "test", source_id: bob, target_id: alice, relation_type: "member" },
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
      fsWrites.paths.length = 0;
      const r = await v.call("rename_entity", {
        vault: "test",
        entity_id: alice,
        new_name: "Alice2",
      });
      expect(denied(r)).toBe(true);
      expect(fsWrites.paths).toEqual([]);
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
      fsWrites.paths.length = 0;
      const r = await v.callConfirmed("delete_entity", {
        vault: "test",
        entity_id: alice,
        cascade: true,
        permanent: false,
      });
      expect(denied(r)).toBe(true);
      expect(fsWrites.paths).toEqual([]);
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

  it.skipIf(process.platform === "win32" || isRoot)(
    "restores a neighbour note it had already rewritten when a later neighbour write fails",
    async () => {
      const v = makeM5Vault();
      try {
        const alice = await seedTriple(v);
        const acmeBefore = v.read(ACME);
        chmodSync(join(v.root, TEAM_DIR), 0o555);
        try {
          const r = await v.call("rename_entity", {
            vault: "test",
            entity_id: alice,
            new_name: "Alice2",
          });
          expect(r.ok).toBe(false);
          expect(v.read(ACME)).toBe(acmeBefore);
          expect(v.exists(ALICE)).toBe(true);
          expect(v.exists(ALICE2)).toBe(false);
          expect(await nameOf(v, alice)).toBe("Alice");
        } finally {
          chmodSync(join(v.root, TEAM_DIR), 0o755);
        }
      } finally {
        v.cleanup();
      }
    },
  );

  it("reindexes the new note and the neighbours, then surfaces the error, when the old note cannot be removed", async () => {
    const reindex = vi.fn();
    const v = makeM5Vault({ reindex });
    try {
      const alice = await seedPair(v);
      reindex.mockClear();
      hardDeleteFails.name = "Alice.md";
      const r = await v.call("rename_entity", {
        vault: "test",
        entity_id: alice,
        new_name: "Alice2",
      });
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ ok: false, error: { code: "internal" } });
      expect(reindex).toHaveBeenCalledWith("test", ALICE2, v.read(ALICE2));
      expect(reindex).toHaveBeenCalledWith("test", ACME, v.read(ACME));
    } finally {
      hardDeleteFails.name = undefined;
      v.cleanup();
    }
  });
});

describe("a failed cascade delete restores the neighbour notes it rewrote", () => {
  it.skipIf(process.platform === "win32" || isRoot)(
    "restores Acme and keeps Alice when a team neighbour write fails",
    async () => {
      const v = makeM5Vault();
      try {
        const alice = await seedTriple(v);
        const acmeBefore = v.read(ACME);
        chmodSync(join(v.root, TEAM_DIR), 0o555);
        try {
          const r = await v.callConfirmed("delete_entity", {
            vault: "test",
            entity_id: alice,
            cascade: true,
            permanent: false,
          });
          expect(r.ok).toBe(false);
          expect(v.read(ACME)).toBe(acmeBefore);
          expect(v.exists(ALICE)).toBe(true);
          expect(await nameOf(v, alice)).toBe("Alice");
        } finally {
          chmodSync(join(v.root, TEAM_DIR), 0o755);
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
      const sameNote = "memory/person/a-b.md";
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

/** A vault with snapshots enabled and the snapshot tools registered (restore_note, list_snapshots). */
function snapshotVault(): M5Vault {
  const v = makeM5Vault({ snapshots: { enabled: true, retention: 5 } });
  const snapshotTools = buildSnapshotTools({
    vaultRegistry: new VaultRegistry([{ id: "test", path: v.root }]),
    version: "test",
    startedAt: 0,
    embeddings: { provider: "none", model: "none" },
    snapshots: { enabled: true, retention: 5 },
  });
  for (const tool of snapshotTools) v.registry.register(tool);
  return v;
}

describe("delete_entity snapshots the note it removes", () => {
  it("permanent delete_entity snapshots the note so restore_note brings it back", async () => {
    const v = snapshotVault();
    try {
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

  it("a trash-mode delete_entity also snapshots the note it moves to the trash", async () => {
    const v = snapshotVault();
    try {
      const alice = await seedPair(v);
      const deleted = await v.callConfirmed("delete_entity", {
        vault: "test",
        entity_id: alice,
        cascade: true,
        permanent: false,
      });
      dataOf(deleted, "delete_entity");
      const list = dataOf<{ snapshots: { op: string }[] }>(
        await v.call("list_snapshots", { vault: "test", path: ALICE }),
        "list_snapshots",
      );
      expect(list.snapshots.map((s) => s.op)).toEqual(["delete_entity"]);
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
