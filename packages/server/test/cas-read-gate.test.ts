// The write-path compare-and-swap detail is read-gated: a caller that may write a note but not read
// it must not learn that note's hash (a hash of low-entropy content is a guessing oracle), and the
// CAS-shaped tools honour writes.requireCas and patch_note's idempotency key like their siblings.
import { createHash } from "node:crypto";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { makeTestVault, type TestVault } from "./m1-helpers";

const SECRET = "PIN 4821\n";
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const ZERO_HASH = "0".repeat(64);

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

/** `Private/p.md` is writable but not readable by this caller (readPaths covers Public/ only). */
const writeOnlyVault = (): TestVault =>
  makeTestVault({
    files: { "Private/p.md": SECRET },
    acl: { readPaths: ["Public/**"], writePaths: ["**"], deletePaths: ["**"] },
    centralAcl: true,
  });

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

  it("wrong prev_hash: write_note, patch_note, append_note and delete_note refuse without actual", async () => {
    v = writeOnlyVault();
    const refusals: Array<[string, ToolResult]> = [
      [
        "write_note",
        await v.call(
          "write_note",
          {
            vault: "test",
            path: "Private/p.md",
            mode: "overwrite",
            content: "x",
            prev_hash: ZERO_HASH,
          },
          SCOPES,
        ),
      ],
      [
        "patch_note",
        await v.call(
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
        ),
      ],
      [
        "append_note",
        await v.call(
          "append_note",
          { vault: "test", path: "Private/p.md", content: "x", prev_hash: ZERO_HASH },
          SCOPES,
        ),
      ],
      [
        "delete_note",
        await withToken(v, "delete_note", {
          vault: "test",
          path: "Private/p.md",
          prev_hash: ZERO_HASH,
        }),
      ],
    ];
    for (const [tool, r] of refusals) {
      expect(errOf(r)?.code, tool).toBe("concurrent_modification");
      expect(errOf(r)?.details, tool).not.toHaveProperty("actual");
      expect(JSON.stringify(errOf(r)?.details), tool).not.toContain(sha(SECRET));
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
  it("requireCas: patch_note and patch_active_file refuse a missing prev_hash like append_note", async () => {
    v = makeTestVault({ files: { "a.md": "old\n" }, requireCas: true });
    const appendRefusal = await v.call("append_note", {
      vault: "test",
      path: "a.md",
      content: "x",
    });
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
