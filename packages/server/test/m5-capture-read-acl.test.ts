// Capture queue and the folder read ACL. A capture's content is the body of the note it becomes, and
// its target_path_hint / committed_path name that note, so a caller whose read ACL cannot read the
// note must not see the capture. Denied means missing: the capture is left out of list_capture_queue
// (page, next_cursor and total_returned computed AFTER that), and commit_capture answers an
// unreadable capture id exactly like an id that was never queued. A capture naming no note at all
// (an unrouted inbox item) stays visible to read:capture.
import { type ToolResult, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier } from "../src/elicit";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { registerM5Tools } from "../src/tools/m5";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { type M5Vault, makeM5Vault } from "./m5-helpers";
import { makeTempDir, rmTemp } from "./tmp";

const V = VaultId.parse("test");
const READ_PUB = { readPaths: ["pub/**"] };

const vaults: M5Vault[] = [];
afterEach(() => {
  for (const v of vaults.splice(0)) v.cleanup();
});

function mk(acl: Record<string, unknown> | undefined): M5Vault {
  const v = makeM5Vault(acl ? { acl } : {});
  vaults.push(v);
  return v;
}

type Kind = "pub" | "secret" | "unrouted";
const HINT: Record<Kind, string | undefined> = {
  pub: "pub/note.md",
  secret: "secret/note.md",
  unrouted: undefined,
};

/** Enqueue one capture; `content` doubles as its label in comparisons. */
async function enqueue(
  v: M5Vault,
  content: string,
  kind: Kind,
  now: number,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const hint = HINT[kind];
  const r = await v.call(
    "enqueue_capture",
    { vault: V, content, ...(hint ? { target_path_hint: hint } : {}), ...extra },
    { now: () => now },
  );
  if (!r.ok) throw new Error(`enqueue_capture failed: ${JSON.stringify(r.error)}`);
  return (r.data as { capture_id: string }).capture_id;
}

/** Commit a capture to `target` keeping the committed row (committed_path set). */
async function commitKeep(v: M5Vault, id: string, target: string, now: number): Promise<void> {
  const r = await v.call(
    "commit_capture",
    { vault: V, capture_id: id, target_path: target, delete_from_queue: false },
    { now: () => now },
  );
  if (!r.ok) throw new Error(`commit_capture failed: ${JSON.stringify(r.error)}`);
}

interface Item {
  capture_id: string;
  content_preview: string;
  target_path_hint?: string | null;
  committed_path?: string | null;
  poison_assessment: unknown;
}
interface Page {
  items: Item[];
  next_cursor: string | null;
  total_returned?: number;
}

async function list(
  v: M5Vault,
  extra: Record<string, unknown> = {},
  over: Partial<CallerContext> = {},
): Promise<Page> {
  const r = await v.call("list_capture_queue", { vault: V, ...extra }, over);
  if (!r.ok) throw new Error(`list_capture_queue failed: ${JSON.stringify(r.error)}`);
  return r.data as Page;
}

/** Walk every page; ids replaced by content labels so two vaults with random ids compare. */
async function walk(v: M5Vault, limit: number, extra: Record<string, unknown> = {}) {
  const pages: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const p = await list(v, { limit, ...(cursor ? { cursor } : {}), ...extra });
    let text = JSON.stringify(p);
    for (const it of p.items) text = text.split(it.capture_id).join(`<${it.content_preview}>`);
    pages.push(text);
    if (!p.next_cursor) break;
    cursor = p.next_cursor;
  }
  return pages;
}

function shape(r: ToolResult, labels: Record<string, string> = {}): string {
  let text = JSON.stringify(r.ok ? { data: r.data } : { error: r.error });
  for (const [id, label] of Object.entries(labels)) text = text.split(id).join(label);
  return text;
}

describe("list_capture_queue omits captures whose target note the caller cannot read", () => {
  it("readPaths excluding the target folder: the capture is absent, content included", async () => {
    const v = mk(READ_PUB);
    await enqueue(v, "visible-body", "pub", 10);
    await enqueue(v, "HIDDEN-BODY", "secret", 20, { title: "HIDDEN-TITLE" });
    const p = await list(v);
    expect(p.items.map((i) => i.content_preview)).toEqual(["visible-body"]);
    const text = JSON.stringify(p);
    for (const leak of ["HIDDEN", "secret/note.md", "secret/"]) expect(text).not.toContain(leak);
    expect(p.total_returned).toBe(1);
  });

  it("an unrouted capture (no hint, not committed) stays visible", async () => {
    const v = mk(READ_PUB);
    await enqueue(v, "inbox-item", "unrouted", 10);
    await enqueue(v, "HIDDEN-BODY", "secret", 20);
    expect((await list(v)).items.map((i) => i.content_preview)).toEqual(["inbox-item"]);
  });

  it("a committed capture in an unreadable folder is absent, content_preview included", async () => {
    const v = mk(READ_PUB);
    const a = await enqueue(v, "COMMITTED-SECRET-BODY", "unrouted", 10);
    const b = await enqueue(v, "committed-visible", "unrouted", 11);
    await commitKeep(v, a, "secret/c.md", 20);
    await commitKeep(v, b, "pub/c.md", 21);
    const p = await list(v, { committed: true });
    expect(p.items.map((i) => i.content_preview)).toEqual(["committed-visible"]);
    const text = JSON.stringify(p);
    expect(text).not.toContain("COMMITTED-SECRET");
    expect(text).not.toContain("secret/c.md");
  });

  it("a capture hinted at a readable folder but committed to an unreadable one is absent", async () => {
    const v = mk(READ_PUB);
    const id = await enqueue(v, "MOVED-BODY", "pub", 10);
    await commitKeep(v, id, "secret/moved.md", 20);
    expect((await list(v, { committed: true })).items).toEqual([]);
  });

  it("a capture hinted at an unreadable folder but committed to a readable one is absent", async () => {
    const v = mk(READ_PUB);
    const id = await enqueue(v, "HINTED-BODY", "secret", 10);
    // commit_capture itself now refuses this capture, so seed the state a pre-fix commit left.
    v.db
      .prepare("UPDATE capture_queue SET committed_at = 20, committed_path = ? WHERE id = ?")
      .run("pub/moved.md", id);
    expect((await list(v, { committed: true })).items).toEqual([]);
  });

  it("strictReadDefault with no readPaths hides routed captures, keeps unrouted ones", async () => {
    const v = mk({ strictReadDefault: true });
    await enqueue(v, "routed", "pub", 10);
    await enqueue(v, "unrouted", "unrouted", 11);
    expect((await list(v)).items.map((i) => i.content_preview)).toEqual(["unrouted"]);
  });

  it("a stored hint that cannot be normalized fails closed (hidden)", async () => {
    const v = mk(READ_PUB);
    await enqueue(v, "ok", "pub", 10);
    const id = await enqueue(v, "LEGACY-BODY", "unrouted", 20);
    v.db.prepare("UPDATE capture_queue SET target_path_hint = ? WHERE id = ?").run("../x.md", id);
    expect((await list(v)).items.map((i) => i.content_preview)).toEqual(["ok"]);
  });

  it("source filter composes with the ACL filter", async () => {
    const v = mk(READ_PUB);
    await enqueue(v, "p-cli", "pub", 10, { source: "cli" });
    await enqueue(v, "s-cli", "secret", 20, { source: "cli" });
    await enqueue(v, "p-web", "pub", 30, { source: "web" });
    const p = await list(v, { source: "cli" });
    expect(p.items.map((i) => i.content_preview)).toEqual(["p-cli"]);
  });
});

describe("pagination and totals are computed after the ACL filter", () => {
  async function fill(v: M5Vault, withHidden: boolean): Promise<void> {
    // newest-first: u5 h4 p3 h2 u1 -- hidden ones interleaved, including the newest and a run.
    await enqueue(v, "u1", "unrouted", 10);
    if (withHidden) await enqueue(v, "h2", "secret", 20);
    await enqueue(v, "p3", "pub", 30);
    if (withHidden) await enqueue(v, "h4", "secret", 40);
    await enqueue(v, "u5", "unrouted", 50);
    if (withHidden) await enqueue(v, "h6", "secret", 60);
    if (withHidden) await enqueue(v, "h7", "secret", 70);
  }

  for (const limit of [1, 2, 3]) {
    it(`limit ${limit}: every page, next_cursor and total_returned equal a vault without the hidden captures`, async () => {
      const withHidden = mk(READ_PUB);
      const without = mk(READ_PUB);
      await fill(withHidden, true);
      await fill(without, false);
      const a = await walk(withHidden, limit);
      const b = await walk(without, limit);
      // Cursors embed the last visible item's id, so compare with the id labelled out.
      const norm = (pages: string[]) => pages.map((t) => t.replace(/"next_cursor":"[^"]*"/, "C"));
      expect(norm(a)).toEqual(norm(b));
      expect(a.length).toBe(b.length);
    });
  }

  it("a page is full of visible items, never short because hidden rows took its slots", async () => {
    const v = mk(READ_PUB);
    await fill(v, true);
    const p = await list(v, { limit: 2 });
    expect(p.items.map((i) => i.content_preview)).toEqual(["u5", "p3"]);
    expect(p.total_returned).toBe(2);
    expect(p.next_cursor).not.toBeNull();
    const last = await list(v, { limit: 2, cursor: p.next_cursor as string });
    expect(last.items.map((i) => i.content_preview)).toEqual(["u1"]);
    expect(last.next_cursor).toBeNull();
  });

  it("no next_cursor when only hidden captures remain past the page", async () => {
    const v = mk(READ_PUB);
    await enqueue(v, "p1", "pub", 10);
    await enqueue(v, "h2", "secret", 20);
    const p = await list(v, { limit: 1 });
    expect(p.items.map((i) => i.content_preview)).toEqual(["p1"]);
    expect(p.next_cursor).toBeNull();
  });

  it("a queue of only hidden captures is an empty page like an empty queue", async () => {
    const v = mk(READ_PUB);
    await enqueue(v, "h1", "secret", 10);
    const empty = mk(READ_PUB);
    expect(JSON.stringify(await list(v))).toBe(JSON.stringify(await list(empty)));
  });
});

describe("concise and detailed formats show the same captures", () => {
  it("concise == detailed visibility", async () => {
    const v = mk(READ_PUB);
    await enqueue(v, "p1", "pub", 10);
    await enqueue(v, "h2", "secret", 20);
    await enqueue(v, "u3", "unrouted", 30);
    const ids = async (format: string) =>
      (await list(v, { response_format: format })).items.map((i) => i.content_preview);
    expect(await ids("concise")).toEqual(["u3", "p1"]);
    expect(await ids("detailed")).toEqual(["u3", "p1"]);
    const c = await list(v, { response_format: "concise" });
    expect(c.total_returned).toBeUndefined();
    expect(JSON.stringify(c)).not.toContain("secret/");
  });
});

describe("commit_capture does not confirm or yield an unreadable capture", () => {
  it("an unreadable pending capture id answers like a nonexistent id", async () => {
    const hiddenWorld = mk(READ_PUB);
    const emptyWorld = mk(READ_PUB);
    const hidden = await enqueue(hiddenWorld, "HIDDEN-BODY", "secret", 10);
    const ghost = "cap_000000000000000000000000";
    const input = (id: string) => ({ vault: V, capture_id: id, target_path: "out/n.md" });
    const a = await hiddenWorld.call("commit_capture", input(hidden));
    const b = await emptyWorld.call("commit_capture", input(ghost));
    expect(a.ok).toBe(false);
    expect(shape(a, { [hidden]: "<id>" })).toBe(shape(b, { [ghost]: "<id>" }));
    // Nothing was written or consumed.
    expect(hiddenWorld.exists("out/n.md")).toBe(false);
    expect(hiddenWorld.db.prepare("SELECT COUNT(*) AS n FROM capture_queue").get()).toEqual({
      n: 1,
    });
  });

  it("an unreadable COMMITTED capture answers not-found, not 'already committed'", async () => {
    const v = mk(READ_PUB);
    const id = await enqueue(v, "C-BODY", "unrouted", 10);
    await commitKeep(v, id, "secret/c.md", 20);
    const ghost = "cap_000000000000000000000000";
    const input = (i: string) => ({ vault: V, capture_id: i, target_path: "out/n.md" });
    const a = await v.call("commit_capture", input(id));
    const b = await v.call("commit_capture", input(ghost));
    expect(shape(a, { [id]: "<id>" })).toBe(shape(b, { [ghost]: "<id>" }));
  });

  it("a readable capture still commits and a readable committed one still says already committed", async () => {
    const v = mk(READ_PUB);
    const ok = await enqueue(v, "fine", "pub", 10);
    const done = await enqueue(v, "done", "unrouted", 11);
    await commitKeep(v, done, "pub/done.md", 12);
    expect(
      (await v.call("commit_capture", { vault: V, capture_id: ok, target_path: "pub/x.md" })).ok,
    ).toBe(true);
    const again = await v.call("commit_capture", {
      vault: V,
      capture_id: done,
      target_path: "pub/y.md",
    });
    expect(!again.ok && again.error.message).toBe("capture already committed");
  });
});

describe("unchanged for unrestricted callers and for poison_assessment", () => {
  it("no ACL restriction: every capture is listed with its paths", async () => {
    const v = mk(undefined);
    await enqueue(v, "p1", "pub", 10);
    await enqueue(v, "h2", "secret", 20);
    await enqueue(v, "u3", "unrouted", 30);
    const p = await list(v);
    expect(p.items.map((i) => i.content_preview)).toEqual(["u3", "h2", "p1"]);
    expect(p.items.find((i) => i.content_preview === "h2")?.target_path_hint).toBe(
      "secret/note.md",
    );
    expect(p.total_returned).toBe(3);
  });

  it("a read-only ACL (no readPaths) is not a read restriction", async () => {
    const v = mk({ readOnly: true });
    // readOnly blocks enqueue; seed the row directly.
    v.db
      .prepare(
        "INSERT INTO capture_queue (id, vault_id, content, captured_at, target_path_hint) VALUES ('cap_a', 'test', 'seeded', 1, 'secret/x.md')",
      )
      .run();
    expect((await list(v)).items.map((i) => i.content_preview)).toEqual(["seeded"]);
  });

  it("poison_assessment is present on every visible capture, null for a never-scanned row", async () => {
    const v = mk(READ_PUB);
    await enqueue(v, "clean text", "pub", 10);
    await enqueue(v, "hidden", "secret", 20);
    const legacy = await enqueue(v, "legacy", "unrouted", 30);
    v.db
      .prepare("UPDATE capture_queue SET poison_risk = NULL, poison_signals = NULL WHERE id = ?")
      .run(legacy);
    const p = await list(v);
    expect(p.items.map((i) => i.content_preview)).toEqual(["legacy", "clean text"]);
    for (const it of p.items) expect("poison_assessment" in it).toBe(true);
    expect(p.items[0]?.poison_assessment).toBeNull();
    expect(p.items[1]?.poison_assessment).toEqual({ risk: "none", signals: [] });
  });
});

describe("per-vault ACL binding", () => {
  it("the same hint is visible in the vault whose ACL reads it and hidden in the other", async () => {
    const rootA = makeTempDir("obtc-cap-a-");
    const rootB = makeTempDir("obtc-cap-b-");
    const cacheDir = makeTempDir("obtc-cap-cache-");
    const db = openMemoryDb();
    provisionCacheDb(db);
    const acls = new Map<string, FolderAcl>([
      [
        "va",
        new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], readPaths: ["shared/**"] }),
      ],
      [
        "vb",
        new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], readPaths: ["other/**"] }),
      ],
    ]);
    // The root ACL is deliberately the most permissive: only the per-vault swap can hide anything.
    const rootAcl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
    const registry = new ToolRegistry({
      verifyElicit: elicitVerifier,
      aclResolver: (id) => acls.get(id),
    });
    registerM5Tools(registry, {
      cacheDir,
      vaultRegistry: new VaultRegistry([
        { id: "va", path: rootA },
        { id: "vb", path: rootB },
      ]),
      memoryFolder: () => "memory",
      traceFolder: () => ".obsidian-tc/traces",
    });
    const ctx = (): CallerContext => ({
      caller: "test",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "va",
      db,
      acl: rootAcl,
      now: () => 10,
    });
    try {
      for (const vault of ["va", "vb"]) {
        const r = await registry.dispatch(
          "enqueue_capture",
          { vault, content: `body-of-${vault}`, target_path_hint: "shared/x.md" },
          ctx(),
        );
        expect(r.ok).toBe(true);
      }
      const seen = async (vault: string) => {
        const r = await registry.dispatch("list_capture_queue", { vault }, ctx());
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        return (r.data as Page).items.map((i) => i.content_preview);
      };
      expect(await seen("va")).toEqual(["body-of-va"]);
      expect(await seen("vb")).toEqual([]);
    } finally {
      rmTemp(rootA);
      rmTemp(rootB);
      rmTemp(cacheDir);
    }
  });
});
