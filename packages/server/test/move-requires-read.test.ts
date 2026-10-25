// A move relocates the source's bytes to the destination, so it needs read access to the source as
// copy_note does. Without it, a caller who may delete under a folder it cannot read could move the
// note into a folder it can read, and read it there (the read ACL and read:notes are bypassed).
import { linkSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { registerM3Tools } from "../src/tools/m3";
import { buildBulkTools } from "../src/tools/m6/bulk-tools";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { type M6Vault, makeM6Vault } from "./m6-helpers";

const SECRET = "PIN 4821\n";

const errOf = (r: ToolResult): { code: string; message: string } | null =>
  r.ok ? null : (r.error as { code: string; message: string });

const WRITE_DELETE = new Set(["write:notes", "delete:notes"]);
const ALL_SCOPES = new Set(["read:notes", "write:notes", "delete:notes"]);
const BULK_SCOPES = new Set(["read:notes", "write:notes", "delete:notes", "bulk:notes"]);

/** A move across folders is human-confirmed: the first call is refused, the retry carries the token. */
async function confirmedMove(
  v: TestVault,
  tool: "move_note" | "move_attachment",
  args: Record<string, unknown>,
  grantedScopes: Set<string>,
): Promise<ToolResult> {
  const first = await v.call(tool, args, { grantedScopes });
  if (errOf(first)?.code !== "elicit_required") return first;
  const { details } = (first as unknown as { error: { details: { args_hash: string } } }).error;
  const elicitToken = issueElicitToken(v.db, {
    vaultId: v.id,
    toolName: tool,
    argsHash: String(details.args_hash),
    caller: "test",
  });
  return v.call(tool, args, { grantedScopes, elicitToken });
}

const moveNote = (v: TestVault, args: Record<string, unknown>, grantedScopes: Set<string>) =>
  confirmedMove(v, "move_note", args, grantedScopes);

/** A refused move leaves its source in place and creates nothing at its destination. */
const expectStays = (v: TestVault, from: string, to: string): void => {
  expect(v.exists(from)).toBe(true);
  expect(v.exists(to)).toBe(false);
};
const BATCH = [
  { from: "Private/p.md", to: "Public/p.md" },
  { from: "Public/c.md", to: "Public/c2.md" },
];
const bulkMoves = (
  v: M6Vault,
  moves: { from: string; to: string }[],
  dryRun: boolean,
  scopes: Set<string>,
) =>
  v.callConfirmed(
    "bulk_move_notes",
    { vault: "test", moves, dry_run: dryRun },
    { grantedScopes: scopes },
  );
const PRIVATE_NOTE = { vault: "test", from: "Private/p.md", to: "Private/q.md" };
const noteVault = (files: Record<string, string>, acl: Record<string, unknown>): TestVault =>
  makeTestVault({ files, acl, centralAcl: true });
const attachmentVault = (files: Record<string, string>, acl: Record<string, unknown>): TestVault =>
  makeTestVault({
    files,
    acl,
    centralAcl: true,
    registerTools: (registry, vaultRegistry) => registerM3Tools(registry, { vaultRegistry }),
  });
// conventions: true is the production wiring (runtime/governance.ts), which also supplies the
// rootResolver the central ACL stage needs. Without it the ACL refusal below never happens.
const bulkVault = (files: Record<string, string>, acl: Record<string, unknown>): M6Vault =>
  makeM6Vault({
    files,
    acl,
    conventions: true,
    register: (r, d) => {
      for (const tool of buildBulkTools(d)) r.register(tool);
    },
  });

let t: TestVault | undefined;
let b: M6Vault | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
  b?.cleanup();
  b = undefined;
});

describe("move_note needs read on its source", () => {
  it("ACL: a caller whose readPaths exclude the source is refused (op read) and nothing moves", async () => {
    t = noteVault(
      { "private/a.md": SECRET },
      { readPaths: ["open/**"], writePaths: ["**"], deletePaths: ["**"] },
    );
    const r = await moveNote(
      t,
      { vault: "test", from: "private/a.md", to: "open/a.md" },
      ALL_SCOPES,
    );
    expect(errOf(r)?.code).toBe("acl_denied");
    expect(JSON.stringify(r)).toContain("read");
    expectStays(t, "private/a.md", "open/a.md");
  });

  it("scope: a caller granted write and delete but not read:notes is refused and nothing moves", async () => {
    t = noteVault({ "Private/p.md": SECRET }, { writePaths: ["**"], deletePaths: ["**"] });
    const r = await moveNote(t, PRIVATE_NOTE, WRITE_DELETE);
    // The scope gate refuses before the move is confirmed, so no elicit token is ever asked for.
    expect(errOf(r)?.code).toBe("forbidden");
    expectStays(t, "Private/p.md", "Private/q.md");
  });

  it("a reader still moves its note, and the ack keeps the content hash", async () => {
    t = noteVault({ "Private/p.md": SECRET }, { writePaths: ["**"], deletePaths: ["**"] });
    const r = await moveNote(t, PRIVATE_NOTE, ALL_SCOPES);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(t.read("Private/q.md")).toBe(SECRET);
    expect(t.exists("Private/p.md")).toBe(false);
  });
});

describe("bulk_move_notes needs read on every source", () => {
  it("real run: one unreadable row refuses the whole batch and moves nothing", async () => {
    b = bulkVault(
      { "private/a.md": SECRET, "open/c.md": "C" },
      { readPaths: ["open/**"], writePaths: ["**"], deletePaths: ["**"] },
    );
    const r = await b.callConfirmed(
      "bulk_move_notes",
      {
        vault: "test",
        moves: [
          { from: "private/a.md", to: "open/a.md" },
          { from: "open/c.md", to: "open/c2.md" },
        ],
        dry_run: false,
      },
      { grantedScopes: BULK_SCOPES },
    );
    expect(errOf(r)?.code).toBe("acl_denied");
    expect(b.exists("private/a.md")).toBe(true);
    expect(b.exists("open/c.md")).toBe(true);
    expect(b.exists("open/c2.md")).toBe(false);
    expect(b.exists("open/a.md")).toBe(false);
  });

  it("real run, scope only: a caller without read:notes gets a refused batch, nothing moved", async () => {
    b = bulkVault(
      { "Private/p.md": SECRET, "Public/c.md": "C" },
      { writePaths: ["**"], deletePaths: ["**"] },
    );
    const r = await bulkMoves(
      b,
      BATCH,
      false,
      new Set(["write:notes", "delete:notes", "bulk:notes"]),
    );
    expect(r.ok).toBe(false);
    expect(errOf(r)?.code).toBe("forbidden");
    expect(b.exists("Private/p.md")).toBe(true);
    expect(b.exists("Public/c.md")).toBe(true);
    expect(b.exists("Public/c2.md")).toBe(false);
    expect(b.exists("Public/p.md")).toBe(false);
  });

  it("dry_run: an ACL-unreadable source refuses the whole call, as a real run does", async () => {
    b = bulkVault(
      { "Private/p.md": SECRET, "Public/c.md": "C" },
      { readPaths: ["Public/**"], writePaths: ["**"], deletePaths: ["**"] },
    );
    const r = await bulkMoves(b, BATCH, true, BULK_SCOPES);
    expect(errOf(r)?.code).toBe("acl_denied");
    expect(b.exists("Private/p.md")).toBe(true);
    expect(b.exists("Public/p.md")).toBe(false);
  });

  it("dry_run: a hard-linked source (no ACL) is reported on its own row; a real run refuses the batch", async () => {
    b = bulkVault({ "a/p.md": SECRET, "a/c.md": "C" }, {});
    linkSync(join(b.root, "a/p.md"), join(b.root, "a/p-link.md"));
    const moves = [
      { from: "a/p.md", to: "b/p.md" },
      { from: "a/c.md", to: "b/c.md" },
    ];
    // No folder ACL in play: the hard-link refusal is then left to the row pass (an ACL caller is
    // refused by the central stage before that, as a whole call).
    const noAcl = { grantedScopes: BULK_SCOPES, acl: undefined };
    const dry = await b.callConfirmed(
      "bulk_move_notes",
      { vault: "test", moves, dry_run: true },
      noAcl,
    );
    expect(dry.ok, JSON.stringify(dry)).toBe(true);
    const rows = (dry.ok ? dry.data : {}) as {
      results: Array<{ ok: boolean; error?: { code: string } }>;
    };
    expect(rows.results[0]?.error?.code).toBe("invalid_input");
    expect(rows.results[1]?.ok).toBe(true);
    const real = await b.callConfirmed(
      "bulk_move_notes",
      { vault: "test", moves, dry_run: false },
      noAcl,
    );
    expect(real.ok).toBe(false);
    expect(b.exists("a/c.md")).toBe(true);
    expect(b.exists("b/c.md")).toBe(false);
  });
});

const moveAttachment = (v: TestVault, args: Record<string, unknown>, grantedScopes: Set<string>) =>
  confirmedMove(v, "move_attachment", args, grantedScopes);

const ATTACHMENT_SCOPES = new Set(["read:attachments", "write:attachments", "delete:attachments"]);

describe("move_attachment refuses a note or non-attachment path", () => {
  it.each([
    [
      "a note moved under an attachment name",
      { "private/a.md": SECRET },
      "private/a.md",
      "open/a.png",
    ],
    ["a note as its destination", { "private/s.png": "PNGSECRET" }, "private/s.png", "open/s.md"],
  ])("move_attachment refuses %s, and nothing moves", async (_label, files, from, to) => {
    t = attachmentVault(files, { writePaths: ["**"], deletePaths: ["**"] });
    const r = await moveAttachment(t, { vault: "test", from, to }, ATTACHMENT_SCOPES);
    expect(errOf(r)?.code).toBe("invalid_input");
    expectStays(t, from, to);
  });
});

describe("move_attachment refuses a script or drawing as its destination", () => {
  it.each([
    ["an existing Dataview view script", "views/v/view.js"],
    ["an existing Excalidraw drawing", "drawings/d.excalidraw"],
    ["a trailing-dot name that Windows reads as a script", "views/v/view.js."],
  ])("refuses to overwrite %s, and leaves every file unchanged", async (_label, to) => {
    t = attachmentVault(
      {
        "pics/evil.png": "PAYLOAD",
        "views/v/view.js": "dv.paragraph('original');\n",
        "drawings/d.excalidraw": "{}",
      },
      { readPaths: ["**"], writePaths: ["**"], deletePaths: ["**"] },
    );
    const r = await moveAttachment(
      t,
      { vault: "test", from: "pics/evil.png", to, overwrite: true },
      ATTACHMENT_SCOPES,
    );
    // A trailing-dot name is refused by path normalisation (path_invalid) before the attachment check.
    expect(["invalid_input", "path_invalid"]).toContain(errOf(r)?.code);
    expect(t.read("pics/evil.png")).toBe("PAYLOAD");
    expect(t.read("views/v/view.js")).toBe("dv.paragraph('original');\n");
    expect(t.read("drawings/d.excalidraw")).toBe("{}");
  });

  it("moves a grandfathered trailing-dot attachment to a safe name", async () => {
    t = attachmentVault(
      { "pics/img.png.": "PNG" },
      { readPaths: ["**"], writePaths: ["**"], deletePaths: ["**"] },
    );
    const r = await moveAttachment(
      t,
      { vault: "test", from: "pics/img.png.", to: "pics/img.png" },
      ATTACHMENT_SCOPES,
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(t.read("pics/img.png")).toBe("PNG");
    expect(t.exists("pics/img.png.")).toBe(false);
  });
});

describe("move_attachment needs read on its source", () => {
  it("ACL: an attachment the caller may not read is refused and moved nowhere", async () => {
    t = attachmentVault(
      { "private/s.png": "PNGSECRET" },
      { readPaths: ["open/**"], writePaths: ["**"], deletePaths: ["**"] },
    );
    const r = await moveAttachment(
      t,
      { vault: "test", from: "private/s.png", to: "open/s.png" },
      ATTACHMENT_SCOPES,
    );
    expect(errOf(r)?.code).toBe("acl_denied");
    expectStays(t, "private/s.png", "open/s.png");
  });

  it("scope: a caller without read:attachments is refused and moved nowhere", async () => {
    t = attachmentVault(
      { "private/s.png": "PNGSECRET" },
      { writePaths: ["**"], deletePaths: ["**"] },
    );
    const r = await moveAttachment(
      t,
      { vault: "test", from: "private/s.png", to: "open/s.png" },
      new Set(["write:attachments", "delete:attachments"]),
    );
    expect(errOf(r)?.code).toBe("forbidden");
    expectStays(t, "private/s.png", "open/s.png");
  });

  it("a reader still moves an attachment", async () => {
    t = attachmentVault(
      { "private/s.png": "PNGSECRET" },
      { readPaths: ["**"], writePaths: ["**"], deletePaths: ["**"] },
    );
    const r = await moveAttachment(
      t,
      { vault: "test", from: "private/s.png", to: "open/s.png" },
      ATTACHMENT_SCOPES,
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expectStays(t, "open/s.png", "private/s.png");
  });
});

describe("bulk_move_notes scope refusal", () => {
  it("a scope-only caller gets the scope refusal before any HITL prompt, with no state_fp", async () => {
    b = bulkVault({ "Private/p.md": SECRET }, { writePaths: ["**"], deletePaths: ["**"] });
    const r = await b.call(
      "bulk_move_notes",
      { vault: "test", moves: [{ from: "Private/p.md", to: "Public/p.md" }], dry_run: false },
      { grantedScopes: new Set(["write:notes", "delete:notes", "bulk:notes"]) },
    );
    expect(errOf(r)?.code).not.toBe("elicit_required");
    expect(JSON.stringify(r)).not.toContain("state_fp");
    expect(b.exists("Private/p.md")).toBe(true);
  });
});
