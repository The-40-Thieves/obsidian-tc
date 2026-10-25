// A move relocates the source's bytes to the destination, so it needs read access to the source as
// copy_note does. Without it, a caller who may delete under a folder it cannot read could move the
// note into a folder it can read, and read it there (the read ACL and read:notes are bypassed).
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { buildBulkTools } from "../src/tools/m6/bulk-tools";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { type M6Vault, makeM6Vault } from "./m6-helpers";

const SECRET = "PIN 4821\n";
/** The one refusal a caller without read:notes gets for a content-dependent call. */
const FIXED_REFUSAL = "this operation needs read access to the target";

const errOf = (r: ToolResult): { code: string; message: string } | null =>
  r.ok ? null : (r.error as { code: string; message: string });

const WRITE_DELETE = new Set(["write:notes", "delete:notes"]);
const ALL_SCOPES = new Set(["read:notes", "write:notes", "delete:notes"]);
const BULK_SCOPES = new Set(["read:notes", "write:notes", "delete:notes", "bulk:notes"]);

/** A move across folders is human-confirmed: the first call is refused, the retry carries the token. */
async function moveNote(
  v: TestVault,
  args: Record<string, unknown>,
  grantedScopes: Set<string>,
): Promise<ToolResult> {
  const first = await v.call("move_note", args, { grantedScopes });
  if (errOf(first)?.code !== "elicit_required") return first;
  const { details } = (first as unknown as { error: { details: { args_hash: string } } }).error;
  const argsHash = String(details.args_hash);
  const elicitToken = issueElicitToken(v.db, {
    vaultId: v.id,
    toolName: "move_note",
    argsHash,
    caller: "test",
  });
  return v.call("move_note", args, { grantedScopes, elicitToken });
}

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
    t = makeTestVault({
      files: { "private/a.md": SECRET },
      acl: { readPaths: ["open/**"], writePaths: ["**"], deletePaths: ["**"] },
      centralAcl: true,
    });
    const r = await moveNote(
      t,
      { vault: "test", from: "private/a.md", to: "open/a.md" },
      ALL_SCOPES,
    );
    expect(errOf(r)?.code).toBe("acl_denied");
    expect(JSON.stringify(r)).toContain("read");
    expect(t.exists("private/a.md")).toBe(true);
    expect(t.exists("open/a.md")).toBe(false);
  });

  it("scope: a caller granted write and delete but not read:notes is refused and nothing moves", async () => {
    t = makeTestVault({
      files: { "Private/p.md": SECRET },
      acl: { writePaths: ["**"], deletePaths: ["**"] },
      centralAcl: true,
    });
    const r = await moveNote(
      t,
      { vault: "test", from: "Private/p.md", to: "Private/q.md" },
      WRITE_DELETE,
    );
    expect(errOf(r)?.code).toBe("invalid_input");
    expect(errOf(r)?.message).toBe(FIXED_REFUSAL);
    expect(t.exists("Private/p.md")).toBe(true);
    expect(t.exists("Private/q.md")).toBe(false);
  });

  it("a reader still moves its note, and the ack keeps the content hash", async () => {
    t = makeTestVault({
      files: { "Private/p.md": SECRET },
      acl: { writePaths: ["**"], deletePaths: ["**"] },
      centralAcl: true,
    });
    const r = await moveNote(
      t,
      { vault: "test", from: "Private/p.md", to: "Private/q.md" },
      ALL_SCOPES,
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(t.read("Private/q.md")).toBe(SECRET);
    expect(t.exists("Private/p.md")).toBe(false);
  });
});

describe("bulk_move_notes needs read on every source", () => {
  const register = (r: M6Vault["registry"], d: Parameters<typeof buildBulkTools>[0]) => {
    for (const tool of buildBulkTools(d)) r.register(tool);
  };

  it("real run: one unreadable row refuses the whole batch and moves nothing", async () => {
    b = makeM6Vault({
      files: { "private/a.md": SECRET, "open/c.md": "C" },
      acl: { readPaths: ["open/**"], writePaths: ["**"], deletePaths: ["**"] },
      register,
    });
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
    expect(r.ok).toBe(false);
    expect(b.exists("private/a.md")).toBe(true);
    expect(b.exists("open/c.md")).toBe(true);
    expect(b.exists("open/c2.md")).toBe(false);
    expect(b.exists("open/a.md")).toBe(false);
  });

  it("real run, scope only: a caller without read:notes gets a refused batch, nothing moved", async () => {
    b = makeM6Vault({
      files: { "Private/p.md": SECRET, "Public/c.md": "C" },
      acl: { writePaths: ["**"], deletePaths: ["**"] },
      register,
    });
    const r = await b.callConfirmed(
      "bulk_move_notes",
      {
        vault: "test",
        moves: [
          { from: "Private/p.md", to: "Public/p.md" },
          { from: "Public/c.md", to: "Public/c2.md" },
        ],
        dry_run: false,
      },
      { grantedScopes: new Set(["write:notes", "delete:notes", "bulk:notes"]) },
    );
    expect(r.ok).toBe(false);
    expect(errOf(r)?.message).toBe(FIXED_REFUSAL);
    expect(b.exists("Private/p.md")).toBe(true);
    expect(b.exists("Public/c.md")).toBe(true);
    expect(b.exists("Public/c2.md")).toBe(false);
    expect(b.exists("Public/p.md")).toBe(false);
  });

  it("dry_run: an unreadable source is reported on its own row", async () => {
    b = makeM6Vault({
      files: { "Private/p.md": SECRET, "Public/c.md": "C" },
      acl: { writePaths: ["**"], deletePaths: ["**"] },
      register,
    });
    const r = await b.callConfirmed(
      "bulk_move_notes",
      {
        vault: "test",
        moves: [{ from: "Private/p.md", to: "Public/p.md" }],
        dry_run: true,
      },
      { grantedScopes: new Set(["write:notes", "delete:notes", "bulk:notes"]) },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const data = (r.ok ? r.data : {}) as {
      results: Array<{ ok: boolean; error?: { message: string } }>;
    };
    expect(data.results[0]?.ok).toBe(false);
    expect(data.results[0]?.error?.message).toBe(FIXED_REFUSAL);
    expect(b.exists("Private/p.md")).toBe(true);
  });
});
