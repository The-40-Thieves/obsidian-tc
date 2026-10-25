// The read gate reaches every tool that still read a file before a write: a caller that may write a file
// but not read it gets the fixed refusal (or, for an append in block mode, an outcome that depends only on
// its own bytes). Covers update_task, the bookmark and workspace writes, append_to_periodic_note with a
// heading, rewrite_link's scan, update_excalidraw's `unchanged` flag, append_note's memoryDefense scan,
// patch_note's frontmatter preamble, and move_note's secret refusal.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { registerM6Tools } from "../src/tools/m6";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { type M3Vault, makeM3Vault } from "./m3-helpers";
import { type M4Vault, makeM4Vault } from "./m4-helpers";
import { type M6Vault, makeM6Vault } from "./m6-helpers";

const FIXED_REFUSAL = "this operation needs read access to the target";
const WRITE_ONLY_ACL = { readPaths: ["Public/**"], writePaths: ["**"], deletePaths: ["**"] };
const READER_ACL = { writePaths: ["**"], deletePaths: ["**"] };

/** A GitHub-shaped token assembled at runtime, so no literal secret sits in this file. */
const fakeGithubToken = (): string => ["ghp", "_", "a".repeat(36)].join("");

const errOf = (r: ToolResult): { code: string; message: string } | null =>
  r.ok ? null : (r.error as { code: string; message: string });

let m1: TestVault | undefined;
let m3: M3Vault | undefined;
let m4: M4Vault | undefined;
let m6: M6Vault | undefined;
afterEach(() => {
  m1?.cleanup();
  m3?.cleanup();
  m4?.cleanup();
  m6?.cleanup();
  m1 = undefined;
  m3 = undefined;
  m4 = undefined;
  m6 = undefined;
});

describe("update_task: a non-reader gets one refusal whatever line it names", () => {
  // Line 1 is a heading (not a task); line 2 holds the secret task. A line-walk oracle would tell them apart.
  const TASKS = "# Private\n- [ ] call bank re PIN 4821 #private\n";
  const WRITER = { grantedScopes: new Set(["write:tasks"]) };

  it.each([1, 2])("line %i is refused with the fixed error and no task content", async (line) => {
    m4 = makeM4Vault({ files: { "Private/t.md": TASKS }, acl: WRITE_ONLY_ACL });
    const r = await m4.call("update_task", { vault: "test", path: "Private/t.md", line }, WRITER);
    expect(errOf(r)?.message).toBe(FIXED_REFUSAL);
    expect(JSON.stringify(r)).not.toContain("4821");
    expect(JSON.stringify(r)).not.toContain("content_hash");
  });

  it("line 1 and line 2 produce byte-identical refusals", async () => {
    m4 = makeM4Vault({ files: { "Private/t.md": TASKS }, acl: WRITE_ONLY_ACL });
    const one = await m4.call(
      "update_task",
      { vault: "test", path: "Private/t.md", line: 1 },
      WRITER,
    );
    const two = await m4.call(
      "update_task",
      { vault: "test", path: "Private/t.md", line: 2 },
      WRITER,
    );
    expect(JSON.stringify(one.ok ? null : one.error)).toBe(
      JSON.stringify(two.ok ? null : two.error),
    );
  });

  it("a reader is still served: line 2 is updated", async () => {
    m4 = makeM4Vault({ files: { "Private/t.md": TASKS }, acl: READER_ACL });
    const r = await m4.call(
      "update_task",
      { vault: "test", path: "Private/t.md", line: 2 },
      { grantedScopes: new Set(["write:tasks", "read:tasks"]) },
    );
    expect(r.ok).toBe(true);
  });
});

describe("bookmarks and workspaces: a non-reader gets the fixed refusal and no ack fields", () => {
  const BOOKMARKS = JSON.stringify({ items: [{ type: "file", path: "Private/p.md" }] });
  const WORKSPACES = JSON.stringify({
    active: "secret-ws",
    workspaces: { "secret-ws": { layout: "PIN 4821" } },
  });
  const WRITER = {
    grantedScopes: new Set(["write:bookmarks", "write:workspaces", "delete:bookmarks"]),
  };
  const READER = {
    grantedScopes: new Set([
      "read:bookmarks",
      "write:bookmarks",
      "delete:bookmarks",
      "read:workspaces",
      "write:workspaces",
    ]),
  };
  const files = { ".obsidian/bookmarks.json": BOOKMARKS, ".obsidian/workspaces.json": WORKSPACES };

  it("add_bookmark (duplicate) refuses with no duplicate, count or content_hash", async () => {
    m3 = makeM3Vault({ files, acl: WRITE_ONLY_ACL });
    const r = await m3.call(
      "add_bookmark",
      { vault: "test", bookmark: { type: "file", path: "Private/p.md" } },
      WRITER,
    );
    expect(errOf(r)?.message).toBe(FIXED_REFUSAL);
    expect(JSON.stringify(r)).not.toMatch(/duplicate|count|content_hash/);
  });

  it("remove_bookmark refuses with no removed, count or content_hash", async () => {
    m3 = makeM3Vault({ files, acl: WRITE_ONLY_ACL });
    const r = await m3.callConfirmed(
      "remove_bookmark",
      { vault: "test", match: { path: "Private/p.md" } },
      WRITER,
    );
    expect(errOf(r)?.message).toBe(FIXED_REFUSAL);
    expect(JSON.stringify(r)).not.toMatch(/removed|count|content_hash/);
  });

  it.each([
    ["an existing name", "secret-ws"],
    ["a new name", "new-ws"],
  ])("save_workspace on %s refuses identically, with no active or count", async (_label, name) => {
    m3 = makeM3Vault({ files, acl: WRITE_ONLY_ACL });
    const r = await m3.call("save_workspace", { vault: "test", name, layout: {} }, WRITER);
    expect(errOf(r)?.message).toBe(FIXED_REFUSAL);
    expect(JSON.stringify(r)).not.toMatch(/active|count|content_hash|note_exists/);
  });

  it("a reader still saves a workspace", async () => {
    m3 = makeM3Vault({ files, acl: READER_ACL });
    const r = await m3.call(
      "save_workspace",
      { vault: "test", name: "new-ws", layout: {} },
      READER,
    );
    expect(r.ok).toBe(true);
  });
});

describe("append_to_periodic_note with a heading: a non-reader is refused identically", () => {
  const NOTE = "# Day\n\n## Log\nPIN 4821\n";
  const WRITER = { grantedScopes: new Set(["write:periodic"]) };

  it("an existing heading and a missing heading get the same refusal", async () => {
    m3 = makeM3Vault({ files: { "2026-06-18.md": NOTE }, acl: WRITE_ONLY_ACL });
    const hit = await m3.call(
      "append_to_periodic_note",
      { vault: "test", period: "daily", date: "2026-06-18", content: "x", heading: "Log" },
      WRITER,
    );
    const miss = await m3.call(
      "append_to_periodic_note",
      { vault: "test", period: "daily", date: "2026-06-18", content: "x", heading: "Nope" },
      WRITER,
    );
    expect(errOf(hit)?.message).toBe(FIXED_REFUSAL);
    expect(JSON.stringify(hit.ok ? null : hit.error)).toBe(
      JSON.stringify(miss.ok ? null : miss.error),
    );
  });

  it("a reader still appends under the heading", async () => {
    m3 = makeM3Vault({ files: { "2026-06-18.md": NOTE }, acl: READER_ACL });
    const r = await m3.call(
      "append_to_periodic_note",
      { vault: "test", period: "daily", date: "2026-06-18", content: "x", heading: "Log" },
      { grantedScopes: new Set(["write:periodic", "read:periodic"]) },
    );
    expect(r.ok).toBe(true);
  });
});

describe("rewrite_link: a caller without read:notes learns nothing about notes", () => {
  it("is refused for missing read:notes rather than scanning the vault", async () => {
    m1 = makeTestVault({
      files: { "Private/p.md": "[[Target]] PIN 4821\n", "Target.md": "x\n" },
      acl: { writePaths: ["**"] },
      centralAcl: true,
    });
    const r = await m1.call(
      "rewrite_link",
      { vault: "test", from_target: "Target", to_target: "Other" },
      { grantedScopes: new Set(["write:notes"]) },
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("Private/p.md");
  });
});

describe("update_excalidraw: a non-reader is refused before the bridge is called", () => {
  const DRAWING = "Private/Plan.excalidraw.md";
  const UPDATED = {
    "POST /obsidian-tc/v1/excalidraw/write": {
      body: { ok: true, result: { path: DRAWING, plugin_used: true, unchanged: true } },
    },
  };
  const EDIT = { vault: "test", path: DRAWING, add_elements: [{ id: "b", type: "rectangle" }] };

  it("returns the fixed refusal and sends no request", async () => {
    m4 = makeM4Vault({ installed: ["excalidraw"], routes: UPDATED, acl: WRITE_ONLY_ACL });
    const r = await m4.call("update_excalidraw", EDIT, {
      grantedScopes: new Set(["write:excalidraw"]),
    });
    expect(errOf(r)?.message).toBe(FIXED_REFUSAL);
    expect(JSON.stringify(r)).not.toContain("unchanged");
    expect(m4.bridgeRequests).toHaveLength(0);
  });

  it("a reader still reaches the bridge and gets the unchanged flag", async () => {
    m4 = makeM4Vault({ installed: ["excalidraw"], routes: UPDATED, acl: READER_ACL });
    const r = await m4.call("update_excalidraw", EDIT, {
      grantedScopes: new Set(["write:excalidraw", "read:excalidraw"]),
    });
    expect(r.ok).toBe(true);
    expect(m4.bridgeRequests).toHaveLength(1);
  });
});

describe("append_note in block mode: a non-reader's outcome depends only on the caller's bytes", () => {
  it("a note holding a pre-existing secret and a clean note get the same outcome", async () => {
    m1 = makeTestVault({
      files: { "Private/dirty.md": `token: ${fakeGithubToken()}\n`, "Private/clean.md": "clean\n" },
      acl: WRITE_ONLY_ACL,
      centralAcl: true,
      memoryDefense: { mode: "block", pii: false },
    });
    const writer = { grantedScopes: new Set(["write:notes"]) };
    const dirty = await m1.call(
      "append_note",
      { vault: "test", path: "Private/dirty.md", content: "hello\n" },
      writer,
    );
    const clean = await m1.call(
      "append_note",
      { vault: "test", path: "Private/clean.md", content: "hello\n" },
      writer,
    );
    expect(dirty.ok).toBe(clean.ok);
    expect(JSON.stringify(dirty)).not.toContain("secret_detected");
  });
});

describe("patch_note frontmatter preamble: a non-reader is refused identically for balanced and open fences", () => {
  const BALANCED = "---\ntitle: x\n---\n```\ncode\n```\n";
  const OPEN = "---\ntitle: x\n---\n```\ncode\n";
  const PREPEND = {
    vault: "test",
    path: "Private/p.md",
    operation: "prepend",
    anchor: { type: "frontmatter" },
    content: "```\n",
  };

  it("balanced and open fences get the same fixed refusal", async () => {
    m1 = makeTestVault({
      files: { "Private/p.md": BALANCED },
      acl: WRITE_ONLY_ACL,
      centralAcl: true,
    });
    const a = await m1.call("patch_note", PREPEND, { grantedScopes: new Set(["write:notes"]) });
    m1.cleanup();
    m1 = makeTestVault({ files: { "Private/p.md": OPEN }, acl: WRITE_ONLY_ACL, centralAcl: true });
    const b = await m1.call("patch_note", PREPEND, { grantedScopes: new Set(["write:notes"]) });
    expect(errOf(a)?.message).toBe(FIXED_REFUSAL);
    expect(JSON.stringify(a.ok ? null : a.error)).toBe(JSON.stringify(b.ok ? null : b.error));
  });
});

describe("move_note in block mode: a non-reader gets a refusal that names nothing", () => {
  it("the refusal carries no pattern_ids and no matched field", async () => {
    m1 = makeTestVault({
      files: { "Private/s.md": `token: ${fakeGithubToken()}\n` },
      acl: WRITE_ONLY_ACL,
      centralAcl: true,
      memoryDefense: { mode: "block", pii: false },
    });
    const r = await m1.call(
      "move_note",
      { vault: "test", from: "Private/s.md", to: "Private/t.md" },
      { grantedScopes: new Set(["write:notes", "delete:notes"]) },
    );
    // A move needs read:notes on its source, so this scope-only caller is refused by the scope gate
    // before the scan runs: no scan result (pattern ids, a matched field) reaches it.
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("pattern_ids");
    expect(r.ok ? null : r.error.code).toBe("forbidden");
  });
});

// Private/b.md links the note being moved and holds a secret. The caller reads the moved note
// (Public/**) but not Private/b.md, so the backlink rewrite's memoryDefense scan is a non-reader's.
describe("move_note and bulk_move_notes: an unreadable backlink's secret is not named", () => {
  const BACKLINK = (): string => `token: ${fakeGithubToken()}\nsee [[s]]\n`;
  const FILES = { "Public/s.md": "clean\n", "Private/b.md": BACKLINK() };
  const MOVER = { grantedScopes: new Set(["read:notes", "write:notes", "delete:notes"]) };
  const BLOCK = { mode: "block" as const, pii: false };

  it("move_note: a non-reader's refusal carries no pattern_ids and no fields", async () => {
    m1 = makeTestVault({
      files: FILES,
      acl: WRITE_ONLY_ACL,
      centralAcl: true,
      memoryDefense: BLOCK,
    });
    const r = await m1.call(
      "move_note",
      { vault: "test", from: "Public/s.md", to: "Public/t.md" },
      MOVER,
    );
    expect(r.ok).toBe(false);
    // The fixed recovery text names these keys in prose, so match the JSON key form only.
    expect(JSON.stringify(r)).not.toContain('"pattern_ids":');
    expect(JSON.stringify(r)).not.toContain('"fields":');
  });

  it("move_note: a reader of the backlink keeps the detailed refusal", async () => {
    m1 = makeTestVault({ files: FILES, acl: READER_ACL, centralAcl: true, memoryDefense: BLOCK });
    const r = await m1.call(
      "move_note",
      { vault: "test", from: "Public/s.md", to: "Public/t.md" },
      { grantedScopes: new Set([...MOVER.grantedScopes, "read:notes"]) },
    );
    expect(JSON.stringify(r)).toContain('"pattern_ids":');
  });

  it("bulk_move_notes: a non-reader's refusal carries no pattern_ids and no fields", async () => {
    m6 = makeM6Vault({
      files: FILES,
      acl: WRITE_ONLY_ACL,
      register: (registry, deps) => {
        deps.memoryDefense = () => BLOCK;
        registerM6Tools(registry, deps);
      },
    });
    const r = await m6.callConfirmed(
      "bulk_move_notes",
      { vault: "test", moves: [{ from: "Public/s.md", to: "Public/t.md" }], dry_run: false },
      { grantedScopes: new Set([...MOVER.grantedScopes, "bulk:notes"]) },
    );
    // The fixed recovery text names these keys in prose, so match the JSON key form only.
    expect(JSON.stringify(r)).not.toContain('"pattern_ids":');
    expect(JSON.stringify(r)).not.toContain('"fields":');
  });
});

describe("append_to_periodic_note with no heading: a non-reader's outcome depends only on the caller's bytes", () => {
  it("a note holding a pre-existing secret and a clean note get the same outcome", async () => {
    m3 = makeM3Vault({
      files: { "2026-06-18.md": `token: ${fakeGithubToken()}\n`, "2026-06-19.md": "clean\n" },
      acl: WRITE_ONLY_ACL,
      memoryDefense: () => ({ mode: "block", pii: false }),
    });
    const writer = { grantedScopes: new Set(["write:periodic"]) };
    const dirty = await m3.call(
      "append_to_periodic_note",
      { vault: "test", period: "daily", date: "2026-06-18", content: "hello\n" },
      writer,
    );
    const clean = await m3.call(
      "append_to_periodic_note",
      { vault: "test", period: "daily", date: "2026-06-19", content: "hello\n" },
      writer,
    );
    expect(dirty.ok).toBe(clean.ok);
    expect(JSON.stringify(dirty)).not.toContain("secret_detected");
  });
});
