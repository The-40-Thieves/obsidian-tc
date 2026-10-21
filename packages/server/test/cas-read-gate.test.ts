// The write-path compare-and-swap detail is read-gated: a caller that may write a note but not read
// it must not learn that note's hash (a hash of low-entropy content is a guessing oracle), so every
// operation whose outcome or ack depends on the note's bytes refuses it with one fixed error. The
// CAS-shaped tools honour writes.requireCas and patch_note's idempotency key like their siblings.
import { createHash } from "node:crypto";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { buildBulkTools } from "../src/tools/m6/bulk-tools";
import { casConflict } from "../src/vault/cas";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { type M6Vault, makeM6Vault } from "./m6-helpers";

const SECRET = "PIN 4821\n";
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const ZERO_HASH = "0".repeat(64);
/** The one refusal a non-reader gets for a content-dependent call: fixed text, path-only details. */
const FIXED_REFUSAL = "this operation needs read access to the target";

type Details = Record<string, unknown> | undefined;
const errOf = (r: ToolResult): { code: string; message: string; details?: Details } | null =>
  r.ok ? null : (r.error as { code: string; message: string; details?: Details });
const dataOf = (r: ToolResult): Record<string, unknown> => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as Record<string, unknown>;
};

/** Writes and reads share the grant; only the path ACL separates the two callers below. */
const SCOPES = {
  grantedScopes: new Set(["read:notes", "write:notes", "delete:notes"]),
};

const WRITE_ONLY_ACL = { readPaths: ["Public/**"], writePaths: ["**"], deletePaths: ["**"] };

/** `Private/p.md` is writable but not readable by this caller (readPaths covers Public/ only). */
const writeOnlyVault = (files: Record<string, string> = { "Private/p.md": SECRET }): TestVault =>
  makeTestVault({ files, acl: WRITE_ONLY_ACL, centralAcl: true });

const readerVault = (): TestVault =>
  makeTestVault({
    files: { "Private/p.md": SECRET },
    acl: { writePaths: ["**"], deletePaths: ["**"] },
    centralAcl: true,
  });

/** Runs a HITL-gated call the way a human confirmation would: first call refused, then retried with
 *  the token minted for that refusal's args. Returns the retried result. */
async function withToken(
  v: TestVault,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const first = await v.call(tool, args, SCOPES);
  const e = errOf(first);
  if (e?.code !== "elicit_required") return first;
  const token = issueElicitToken(v.db, {
    vaultId: v.id,
    toolName: tool,
    argsHash: String(e.details?.args_hash),
    caller: "test",
  });
  return v.call(tool, args, { ...SCOPES, elicitToken: token });
}

let v: TestVault | undefined;
afterEach(() => {
  v?.cleanup();
  v = undefined;
});

describe("write-only caller: CAS detail is read-gated", () => {
  it("elicit: write_note without a token carries no hash of a note it cannot read", async () => {
    v = writeOnlyVault();
    const r = await v.call(
      "write_note",
      { vault: "test", path: "Private/p.md", mode: "overwrite", content: "x" },
      SCOPES,
    );
    expect(errOf(r)?.code).toBe("elicit_required");
    expect(errOf(r)?.details).not.toHaveProperty("prev_hash");
    expect(JSON.stringify(errOf(r)?.details)).not.toContain(sha(SECRET));
    expect(v.read("Private/p.md")).toBe(SECRET);
  });

  it("fixed refusal: a non-reader's prev_hash gets one error whether it matches or not", async () => {
    const vault = writeOnlyVault();
    v = vault;
    // delete_note is destructive, so dispatch asks for confirmation first; the refusal below is the
    // handler's, reached once the confirmation is given.
    const call = (tool: string, args: Record<string, unknown>): Promise<ToolResult> =>
      tool === "delete_note" ? withToken(vault, tool, args) : vault.call(tool, args, SCOPES);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["write_note", { path: "Private/p.md", mode: "overwrite", content: "x" }],
      ["append_note", { path: "Private/p.md", content: "" }],
      [
        "patch_note",
        {
          path: "Private/p.md",
          operation: "append",
          anchor: { type: "frontmatter" },
          content: "x",
        },
      ],
      ["delete_note", { path: "Private/p.md" }],
    ];
    for (const [tool, base] of cases) {
      const right = await call(tool, { vault: "test", ...base, prev_hash: sha(SECRET) });
      const wrong = await call(tool, { vault: "test", ...base, prev_hash: ZERO_HASH });
      expect(errOf(right)?.code, tool).toBe("invalid_input");
      expect(errOf(right)?.message, tool).toBe(FIXED_REFUSAL);
      expect(errOf(wrong), tool).toEqual(errOf(right));
      expect(JSON.stringify(errOf(right)), tool).not.toContain(sha(SECRET));
    }
    expect(v.read("Private/p.md")).toBe(SECRET);
  });

  it("ack: successful writes carry no prev_hash or quality_warning and no whole-note hash", async () => {
    v = writeOnlyVault();
    const patched = dataOf(
      await v.call(
        "patch_note",
        {
          vault: "test",
          path: "Private/p.md",
          operation: "append",
          anchor: { type: "frontmatter" },
          content: "tail\n",
        },
        SCOPES,
      ),
    );
    expect(patched).not.toHaveProperty("prev_hash");
    expect(patched).not.toHaveProperty("quality_warning");
    expect(patched.content_hash).toBeNull();

    const appended = dataOf(
      await v.call(
        "append_note",
        { vault: "test", path: "Private/p.md", content: "more\n" },
        SCOPES,
      ),
    );
    expect(appended).not.toHaveProperty("prev_hash");
    expect(appended).not.toHaveProperty("quality_warning");
    expect(appended.content_hash).toBeNull();

    const written = dataOf(
      await withToken(v, "write_note", {
        vault: "test",
        path: "Private/p.md",
        mode: "overwrite",
        content: "replaced\n",
      }),
    );
    expect(written).not.toHaveProperty("prev_hash");
    expect(written).not.toHaveProperty("quality_warning");

    const deleted = dataOf(
      await withToken(v, "delete_note", { vault: "test", path: "Private/p.md" }),
    );
    expect(deleted.prev_hash).toBeNull();
  });

  it("confirmation: overwriting an empty or a non-empty note gets the same elicit_required", async () => {
    v = writeOnlyVault({ "Private/full.md": SECRET, "Private/empty.md": "" });
    const full = await v.call(
      "write_note",
      { vault: "test", path: "Private/full.md", mode: "overwrite", content: "x" },
      SCOPES,
    );
    const empty = await v.call(
      "write_note",
      { vault: "test", path: "Private/empty.md", mode: "overwrite", content: "x" },
      SCOPES,
    );
    expect(errOf(full)?.code).toBe("elicit_required");
    expect(errOf(empty)?.code).toBe("elicit_required");
    expect(Object.keys(errOf(empty)?.details ?? {}).sort()).toEqual(
      Object.keys(errOf(full)?.details ?? {}).sort(),
    );
  });

  it("copy_note: a non-reader cannot copy a note it cannot read", async () => {
    v = writeOnlyVault();
    const r = await v.call(
      "copy_note",
      { vault: "test", from: "Private/p.md", to: "Public/copy.md" },
      SCOPES,
    );
    expect(errOf(r)?.code === "acl_denied" || errOf(r)?.message === FIXED_REFUSAL).toBe(true);
    expect(JSON.stringify(r)).not.toContain(sha(SECRET));
    expect(() => v?.read("Public/copy.md")).toThrow();
  });

  it("copy_note: a caller granted no read:notes is refused even where the path ACL allows the read", async () => {
    v = readerVault();
    const r = await v.call(
      "copy_note",
      { vault: "test", from: "Private/p.md", to: "Public/c.md" },
      { grantedScopes: new Set(["write:notes"]) },
    );
    expect(errOf(r)?.code).toBe("invalid_input");
    expect(errOf(r)?.message).toBe(FIXED_REFUSAL);
    expect(() => v?.read("Public/c.md")).toThrow();
  });

  it("move_note: a non-reader's ack carries a null content_hash", async () => {
    v = writeOnlyVault();
    const moved = dataOf(
      await v.call(
        "move_note",
        { vault: "test", from: "Private/p.md", to: "Private/q.md" },
        SCOPES,
      ),
    );
    expect(moved.content_hash).toBeNull();
    expect(v.read("Private/q.md")).toBe(SECRET);
  });
});

/** Every content-dependent m1 call. Each one is a write or a read-and-report that needs the bytes. */
const CONTENT_DEPENDENT: Array<[string, string, Record<string, unknown>]> = [
  ["add_tag", "add_tag", { path: "Private/p.md", tag: "zz" }],
  ["remove_tag", "remove_tag", { path: "Private/p.md", tag: "zz" }],
  [
    "update_frontmatter set",
    "update_frontmatter",
    { path: "Private/p.md", operation: "set", key: "pin", value: 4821 },
  ],
  [
    "patch_note replace_text",
    "patch_note",
    { path: "Private/p.md", operation: "replace_text", old_string: "PIN 48", new_string: "PIN 48" },
  ],
  [
    "patch_note heading append",
    "patch_note",
    {
      path: "Private/p.md",
      operation: "append",
      anchor: { type: "heading", heading: "Notes" },
      content: "x\n",
    },
  ],
  [
    "patch_note frontmatter replace",
    "patch_note",
    { path: "Private/p.md", operation: "replace", anchor: { type: "frontmatter" }, content: "x\n" },
  ],
  ["prune_hub_links", "prune_hub_links", { path: "Private/p.md", dry_run: false }],
  ["restore_note", "restore_note", { path: "Private/p.md", snapshot_id: 1 }],
  ["copy_note", "copy_note", { from: "Private/p.md", to: "Public/c.md" }],
];

describe("content-dependent writes: a non-reader is refused, a reader is not", () => {
  it.each(CONTENT_DEPENDENT)(
    "content-dependent: %s refuses a non-reader with the fixed error and writes nothing",
    async (_name, tool, args) => {
      v = writeOnlyVault();
      const r = await v.call(tool, { vault: "test", ...args }, SCOPES);
      // copy_note and prune_hub_links already fail the path's read ACL first (acl_denied, the same
      // refusal read_note gives), which carries no content either; every other tool gets the fixed one.
      const refusal = errOf(r);
      expect(refusal?.code === "acl_denied" || refusal?.message === FIXED_REFUSAL, tool).toBe(true);
      expect(JSON.stringify(r), tool).not.toContain("4821");
      expect(JSON.stringify(r), tool).not.toContain(sha(SECRET));
      expect(v.read("Private/p.md")).toBe(SECRET);
    },
  );

  it.each(CONTENT_DEPENDENT)(
    "content-dependent: %s still reaches the checks of a reader",
    async (_name, tool, args) => {
      v = readerVault();
      const r = await v.call(tool, { vault: "test", ...args }, SCOPES);
      expect(errOf(r)?.message, tool).not.toBe(FIXED_REFUSAL);
    },
  );
});

describe("casConflict: details carry the hashes only to a caller who may read", () => {
  const details = (e: unknown): Record<string, unknown> =>
    (e as { details?: Record<string, unknown> }).details ?? {};

  it("casConflict strips actual and expected unless the caller may read", () => {
    const hidden = casConflict(
      "note changed since prev_hash",
      { path: "p.md", expected: ZERO_HASH, actual: sha(SECRET) },
      { hash: sha(SECRET), mayRead: false },
    );
    expect(details(hidden)).toEqual({ path: "p.md" });

    const bare = casConflict("note changed since prev_hash", {
      path: "p.md",
      expected: ZERO_HASH,
      actual: sha(SECRET),
    });
    expect(details(bare)).toEqual({ path: "p.md" });

    const shown = casConflict(
      "note changed since prev_hash",
      { path: "p.md", expected: ZERO_HASH },
      { hash: sha(SECRET), mayRead: true },
    );
    expect(details(shown)).toEqual({ path: "p.md", expected: ZERO_HASH, actual: sha(SECRET) });
  });
});

describe("reader caller keeps actual and prev_hash", () => {
  it("reader: refusals still carry actual, elicit and acks still carry prev_hash", async () => {
    v = readerVault();
    const refused = await v.call(
      "write_note",
      {
        vault: "test",
        path: "Private/p.md",
        mode: "overwrite",
        content: "x",
        prev_hash: ZERO_HASH,
      },
      SCOPES,
    );
    expect(errOf(refused)?.details?.actual).toBe(sha(SECRET));

    const elicit = await v.call(
      "write_note",
      { vault: "test", path: "Private/p.md", mode: "overwrite", content: "x" },
      SCOPES,
    );
    expect(errOf(elicit)?.details?.prev_hash).toBe(sha(SECRET));

    const patchRefused = await v.call(
      "patch_note",
      {
        vault: "test",
        path: "Private/p.md",
        operation: "append",
        anchor: { type: "frontmatter" },
        content: "x",
        prev_hash: ZERO_HASH,
      },
      SCOPES,
    );
    expect(errOf(patchRefused)?.details?.actual).toBe(sha(SECRET));

    const acked = dataOf(
      await v.call(
        "append_note",
        { vault: "test", path: "Private/p.md", content: "more\n", prev_hash: sha(SECRET) },
        SCOPES,
      ),
    );
    expect(acked.prev_hash).toBe(sha(SECRET));
    expect(acked.content_hash).toEqual(expect.any(String));
  });
});

describe("writes.requireCas on patch_note", () => {
  it("requireCas: patch_note refuses a missing prev_hash like append_note does", async () => {
    v = makeTestVault({ files: { "a.md": "old\n" }, requireCas: true });
    const appendRefusal = await v.call("append_note", {
      vault: "test",
      path: "a.md",
      content: "x",
    });
    expect(errOf(appendRefusal)?.code).toBe("invalid_input");
    const expected = errOf(appendRefusal)?.message;
    expect(expected).toBeTypeOf("string");

    const replace = await v.call("patch_note", {
      vault: "test",
      path: "a.md",
      operation: "replace_text",
      old_string: "old",
      new_string: "new",
    });
    expect(errOf(replace)?.code).toBe("invalid_input");
    expect(errOf(replace)?.message).toBe(expected);

    const prepend = await v.call("patch_note", {
      vault: "test",
      path: "a.md",
      operation: "prepend",
      anchor: { type: "frontmatter" },
      content: "x\n",
    });
    expect(errOf(prepend)?.message).toBe(expected);
    expect(v.read("a.md")).toBe("old\n");

    const withHash = await v.call("patch_note", {
      vault: "test",
      path: "a.md",
      operation: "replace_text",
      old_string: "old",
      new_string: "new",
      prev_hash: sha("old\n"),
    });
    expect(withHash.ok).toBe(true);
    expect(v.read("a.md")).toBe("new\n");
  });
});

describe("patch_note idempotency", () => {
  it("idempotency: a retried patch append with the same options.idempotency_key appends once", async () => {
    v = makeTestVault({ files: { "a.md": "base\n" } });
    const args = {
      vault: "test",
      path: "a.md",
      operation: "append",
      anchor: { type: "frontmatter" },
      content: "more\n",
      options: { idempotency_key: "patch-retry-1" },
    };
    const first = await v.call("patch_note", args);
    const second = await v.call("patch_note", args);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(v.read("a.md").split("more").length - 1).toBe(1);
  });
});

describe("content-dependent: bulk_set_property", () => {
  let b: M6Vault | undefined;
  afterEach(() => {
    b?.cleanup();
    b = undefined;
  });

  it("content-dependent: bulk_set_property refuses a non-readable note per item, never its prev_value", async () => {
    b = makeM6Vault({
      files: {
        "Private/p.md": "---\npin: 4821\n---\nA",
        "Public/q.md": "---\nstatus: draft\n---\nB",
      },
      acl: { readPaths: ["Public/**"], writePaths: ["**"], deletePaths: ["**"] },
      register: (r, d) => {
        for (const t of buildBulkTools(d)) r.register(t);
      },
    });
    const r = await b.callConfirmed("bulk_set_property", {
      vault: "test",
      paths: ["Private/p.md", "Public/q.md"],
      key: "status",
      value: "published",
    });
    expect(r.ok).toBe(true);
    const out = (r.ok ? r.data : {}) as {
      results: Array<{
        path: string;
        ok: boolean;
        prev_value?: unknown;
        error?: { message: string };
      }>;
    };
    const [priv, pub] = out.results;
    expect(priv?.ok).toBe(false);
    expect(priv?.error?.message).toBe(FIXED_REFUSAL);
    expect(priv).not.toHaveProperty("prev_value");
    expect(JSON.stringify(out)).not.toContain("4821");
    expect(pub?.ok).toBe(true);
    expect(pub?.prev_value).toBe("draft");
  });
});
