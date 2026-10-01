// Capture and memory read authorization is read_note's, not a lexical re-implementation of it.
// The shared predicate (callerCanReadVaultPath) runs enforcePathAcl(.., "read", ..) on the bound
// vault root, so hard-denied roots, invalid / `..` paths, symlink resolution and the hard-link
// refusal all apply. Each case below is a verbatim exploit from the cross-vendor review of #1085:
// before the predicate existed, the first two were reachable with ACL
// { readPaths: undefined, strictReadDefault: false } and the symlink one with readPaths ["pub/**"].
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { enqueueCapture } from "../src/capture/queue";
import { insertEntity } from "../src/memory/entities";
import { listReadableCaptures } from "../src/tools/m5/capture-read-acl";
import { type M5Vault, makeM5Vault } from "./m5-helpers";
import { makeTempDir, rmTemp } from "./tmp";

const V = VaultId.parse("test");

let symlinkOk = true;
try {
  const probe = makeTempDir("sl-probe-");
  symlinkSync(join(probe, "t"), join(probe, "l"), "dir");
  rmTemp(probe);
} catch {
  symlinkOk = false; // Windows without the privilege to create symlinks
}

const vaults: M5Vault[] = [];
afterEach(() => {
  for (const v of vaults.splice(0)) v.cleanup();
});
function mk(opts: Parameters<typeof makeM5Vault>[0] = {}): M5Vault {
  const v = makeM5Vault(opts);
  vaults.push(v);
  return v;
}

function seed(v: M5Vault, content: string, hint: string | undefined, now: number): string {
  return enqueueCapture(v.db, {
    vaultId: v.id,
    content,
    ...(hint ? { targetPathHint: hint } : {}),
    now,
  }).id;
}

async function listed(v: M5Vault): Promise<string[]> {
  const r = await v.call("list_capture_queue", { vault: V });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.data as { items: { content_preview: string }[] }).items.map((i) => i.content_preview);
}

async function commitError(v: M5Vault, id: string): Promise<string> {
  const r = await v.call("commit_capture", { vault: V, capture_id: id, target_path: "out/x.md" });
  if (r.ok) throw new Error("commit unexpectedly succeeded");
  return r.error.message;
}

const UNRESTRICTED = { readPaths: undefined, strictReadDefault: false };

describe("captures: hard-denied roots and invalid paths hide even for an unrestricted ACL", () => {
  it(".obsidian/plugins/private/data.json hint: not listed, commit says not found", async () => {
    const v = mk({ acl: UNRESTRICTED });
    seed(v, "visible", "notes/a.md", 10);
    const id = seed(v, "HIDDEN-OBSIDIAN", ".obsidian/plugins/private/data.json", 20);
    expect(await listed(v)).toEqual(["visible"]);
    expect(await commitError(v, id)).toBe("capture not found");
    expect(v.exists("out/x.md")).toBe(false);
  });

  it("a legacy ../x.md hint (row seeded by SQL) fails closed", async () => {
    const v = mk({ acl: UNRESTRICTED });
    const id = seed(v, "HIDDEN-DOTDOT", "../x.md", 20);
    expect(await listed(v)).toEqual([]);
    expect(await commitError(v, id)).toBe("capture not found");
  });

  it("a committed_path under .git is hidden too", async () => {
    const v = mk({ acl: UNRESTRICTED });
    const id = seed(v, "HIDDEN-GIT", undefined, 20);
    v.db
      .prepare("UPDATE capture_queue SET committed_at = 30, committed_path = ? WHERE id = ?")
      .run(".git/hooks/x.md", id);
    const r = await v.call("list_capture_queue", { vault: V, committed: true });
    expect(r.ok && (r.data as { items: unknown[] }).items).toEqual([]);
  });
});

describe.skipIf(!symlinkOk)(
  "captures: symlink and hard-link aliases resolve like read_note",
  () => {
    it("pub/link -> ../secret, hint pub/link/note.md: hidden, commit says not found", async () => {
      const v = mk({ acl: { readPaths: ["pub/**"] } });
      mkdirSync(join(v.root, "pub"), { recursive: true });
      mkdirSync(join(v.root, "secret"), { recursive: true });
      symlinkSync(join(v.root, "secret"), join(v.root, "pub", "link"), "dir");
      seed(v, "visible", "pub/note.md", 10);
      const id = seed(v, "HIDDEN-SYMLINK", "pub/link/note.md", 20);
      expect(await listed(v)).toEqual(["visible"]);
      expect(await commitError(v, id)).toBe("capture not found");
    });

    it("a hint on a file hard-linked into the readable folder is hidden", async () => {
      const v = mk({ acl: { readPaths: ["pub/**"] } });
      mkdirSync(join(v.root, "pub"), { recursive: true });
      mkdirSync(join(v.root, "secret"), { recursive: true });
      writeFileSync(join(v.root, "secret", "s.md"), "secret");
      linkSync(join(v.root, "secret", "s.md"), join(v.root, "pub", "hl.md"));
      const id = seed(v, "HIDDEN-HARDLINK", "pub/hl.md", 20);
      expect(await listed(v)).toEqual([]);
      expect(await commitError(v, id)).toBe("capture not found");
    });

    it("the hard-link refusal holds without any readPaths (read_note refuses it as well)", async () => {
      const v = mk({ acl: UNRESTRICTED });
      mkdirSync(join(v.root, "a"), { recursive: true });
      writeFileSync(join(v.root, "a", "s.md"), "x");
      linkSync(join(v.root, "a", "s.md"), join(v.root, "a", "hl.md"));
      seed(v, "HIDDEN-HARDLINK-OPEN", "a/hl.md", 20);
      expect(await listed(v)).toEqual([]);
    });
  },
);

describe("captures: a path that does not exist yet resolves through its parent", () => {
  it("an unmaterialized hint in a readable folder stays visible, one in a denied folder hides", async () => {
    const v = mk({ acl: { readPaths: ["pub/**"] } });
    seed(v, "visible", "pub/new/deep/note.md", 10);
    seed(v, "HIDDEN", "secret/new/note.md", 20);
    expect(await listed(v)).toEqual(["visible"]);
  });
});

describe("listReadableCaptures bounds the hidden rows it examines per request", () => {
  it("returns the page so far with a cursor that resumes past the examined rows, never naming a hidden row", () => {
    const v = mk({ acl: { readPaths: ["pub/**"] } });
    const hiddenIds: string[] = [];
    for (let i = 0; i < 12; i++) hiddenIds.push(seed(v, `H${i}`, "secret/n.md", 100 - i));
    seed(v, "visible-tail", "pub/n.md", 1);
    const ctx = v.ctx();
    const vault = { id: v.id, root: v.root };
    const first = listReadableCaptures(ctx, vault, {}, 5, 5);
    expect(first.page).toEqual([]);
    expect(first.more).toBe(true);
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();
    for (const id of hiddenIds) expect(String(cursor)).not.toContain(id);
    // Resuming eventually reaches the visible row and then terminates.
    const seen: string[] = [];
    let next = cursor ?? undefined;
    for (let i = 0; i < 10 && next; i++) {
      const p = listReadableCaptures(ctx, vault, { afterCursor: next }, 5, 5);
      seen.push(...p.page.map((r) => r.content));
      next = p.more ? (p.nextCursor ?? undefined) : undefined;
    }
    expect(seen).toEqual(["visible-tail"]);
    // A cursor from another process (or forged) reads as an exhausted queue, not an error.
    expect(listReadableCaptures(ctx, vault, { afterCursor: "s1.AAAA" }, 5, 5).page).toEqual([]);
  });
});

describe("memory entities use read_note's read check on their projection note", () => {
  it("a memoryFolder under a hard-denied root hides the entity from an unrestricted caller", async () => {
    const v = mk({ acl: UNRESTRICTED, memoryFolder: ".obsidian/mem" });
    const e = insertEntity(v.db, { vaultId: v.id, entityType: "person", name: "Ada", now: 1 });
    const r = await v.call("get_entity", { vault: V, entity_id: e.id });
    expect(r.ok).toBe(false);
  });

  it.skipIf(!symlinkOk)(
    "a memoryFolder reached through a symlink into an unreadable dir hides the entity",
    async () => {
      const v = mk({ acl: { readPaths: ["pub/**"] }, memoryFolder: "pub/link" });
      mkdirSync(join(v.root, "pub"), { recursive: true });
      mkdirSync(join(v.root, "secret"), { recursive: true });
      symlinkSync(join(v.root, "secret"), join(v.root, "pub", "link"), "dir");
      const e = insertEntity(v.db, { vaultId: v.id, entityType: "person", name: "Ada", now: 1 });
      const r = await v.call("get_entity", { vault: V, entity_id: e.id });
      expect(r.ok).toBe(false);
    },
  );

  it.skipIf(!symlinkOk)(
    "create_entity refuses (acl_denied) a note path that resolves into an unreadable dir, writing nothing",
    async () => {
      const v = mk({ acl: { readPaths: ["pub/**"] }, memoryFolder: "pub/link" });
      mkdirSync(join(v.root, "pub"), { recursive: true });
      mkdirSync(join(v.root, "secret"), { recursive: true });
      symlinkSync(join(v.root, "secret"), join(v.root, "pub", "link"), "dir");
      const r = await v.call("create_entity", { vault: V, type: "person", name: "Ada" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("acl_denied");
      expect(v.exists("secret/person/Ada.md")).toBe(false);
    },
  );
});
