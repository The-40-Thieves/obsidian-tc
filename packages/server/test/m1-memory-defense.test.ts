// GH #994 follow-up, item 1 sibling writers — move_note/copy_note, update_frontmatter,
// add_tag/remove_tag, rewrite_link/prune_hub_links (tools/m1/{notes/move-copy,frontmatter-tools,
// tags-tools,links-tools}.ts) now route their FINAL persisted body through the same
// enforceMemoryDefenseOnNoteWrite guard write_note/append_note/patch_note already get
// (notes/write.ts), and move_note/copy_note additionally refuse a secret-shaped DESTINATION path
// outright, even in redact mode (mirrors commit_capture's target_path refusal).
//
// Table-driven where the tool's own confirmation contract allows it (update_frontmatter, add_tag);
// rewrite_link/prune_hub_links need their own elicit-token dance (both always gate real runs on
// confirmation) so they get dedicated blocks below — still one block per writer, so a new writer
// is still easy to find and add.
//
// Every secret value is assembled at runtime from pieces, matching test/memory-defense.test.ts's
// house rule.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { issueElicitToken } from "../src/elicit";
import type { CallerContext } from "../src/mcp/registry";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import { contentHash } from "../src/vault/paths";
import { openMemoryDb } from "./helpers";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { makeTempDir, rmTemp } from "./tmp";

function un<T>(r: { ok: boolean; data?: unknown }): T {
  return (r as { data: T }).data;
}
function errOf(r: { ok: boolean; error?: unknown }): { code: string } {
  return (r as { error: { code: string } }).error;
}
function hashOf(r: ToolResult): string {
  if (r.ok) throw new Error("expected an error result");
  return String((r.error.details as { args_hash?: string }).args_hash);
}
function mint(v: TestVault, toolName: string, argsHash: string): string {
  return issueElicitToken(v.db, { vaultId: v.id, toolName, argsHash, caller: "test" });
}

function fakeOpenAiKey(): string {
  return ["sk", "-", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
}

// ---------------------------------------------------------------------------------------------
// table-driven: writers whose real run needs no elicit token for a fresh/non-destructive edit.
// ---------------------------------------------------------------------------------------------

interface WriterCase {
  name: string;
  seedFiles: Record<string, string>;
  buildArgs: (secret: string) => { tool: string; args: Record<string, unknown> };
  targetPath: string;
}

const writerCases: WriterCase[] = [
  {
    name: "update_frontmatter",
    seedFiles: { "fm.md": "---\ntitle: fm\n---\nbody\n" },
    buildArgs: (secret) => ({
      tool: "update_frontmatter",
      args: { vault: "test", path: "fm.md", operation: "merge", properties: { note: secret } },
    }),
    targetPath: "fm.md",
  },
  {
    name: "add_tag",
    seedFiles: { "tag.md": "---\ntitle: tag\n---\nbody\n" },
    buildArgs: (secret) => ({
      tool: "add_tag",
      args: { vault: "test", path: "tag.md", tag: secret, location: "frontmatter" },
    }),
    targetPath: "tag.md",
  },
];

describe("M1 sibling writers — block mode refuses a secret-shaped write, table-driven (item 1)", () => {
  let v: TestVault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  for (const tc of writerCases) {
    it(`${tc.name}: refused, secret never persisted`, async () => {
      const secret = fakeOpenAiKey();
      v = makeTestVault({ files: tc.seedFiles, memoryDefense: { mode: "block", pii: false } });
      const { tool, args } = tc.buildArgs(secret);
      const res = await v.call(tool, args);
      expect(res.ok, `${tool} should have been refused`).toBe(false);
      if (!res.ok) expect(errOf(res).code).toBe("secret_detected");
      const onDisk = v.read(tc.targetPath);
      expect(onDisk).not.toContain(secret);
    });
  }
});

describe("M1 sibling writers — redact mode persists [REDACTED], never the raw secret (item 1)", () => {
  let v: TestVault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  for (const tc of writerCases) {
    it(`${tc.name}: redacted on disk`, async () => {
      const secret = fakeOpenAiKey();
      v = makeTestVault({ files: tc.seedFiles, memoryDefense: { mode: "redact", pii: false } });
      const { tool, args } = tc.buildArgs(secret);
      const res = await v.call(tool, args);
      expect(res.ok, `${tool} should have succeeded (redact mode never refuses)`).toBe(true);
      const onDisk = v.read(tc.targetPath);
      expect(onDisk).not.toContain(secret);
      expect(onDisk).toContain("[REDACTED]");
    });
  }
});

// ---------------------------------------------------------------------------------------------
// remove_tag — a pre-existing secret elsewhere in the note (predates memoryDefense) refuses the
// whole rewrite atomically: block mode leaves the note BYTE-IDENTICAL to its seed (the tag is
// NOT removed either — there is no partial effect), redact mode removes the tag AND redacts.
// ---------------------------------------------------------------------------------------------

describe("remove_tag — a pre-existing secret elsewhere in frontmatter refuses/redacts the whole rewrite (item 1)", () => {
  let v: TestVault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("block mode: refused, note left byte-identical (the tag removal is NOT partially applied)", async () => {
    const secret = fakeOpenAiKey();
    const seed = `---\ntitle: rmtag\ntags: [drop-me]\nleftover: ${secret}\n---\nbody\n`;
    v = makeTestVault({
      files: { "rmtag.md": seed },
      memoryDefense: { mode: "block", pii: false },
    });
    const res = await v.call("remove_tag", {
      vault: "test",
      path: "rmtag.md",
      tag: "drop-me",
      location: "frontmatter",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(errOf(res).code).toBe("secret_detected");
    expect(v.read("rmtag.md")).toBe(seed); // byte-identical — no partial rewrite
  });

  it("redact mode: the tag IS removed, and the pre-existing secret is redacted in the same write", async () => {
    const secret = fakeOpenAiKey();
    const seed = `---\ntitle: rmtag\ntags: [drop-me]\nleftover: ${secret}\n---\nbody\n`;
    v = makeTestVault({
      files: { "rmtag.md": seed },
      memoryDefense: { mode: "redact", pii: false },
    });
    const res = await v.call("remove_tag", {
      vault: "test",
      path: "rmtag.md",
      tag: "drop-me",
      location: "frontmatter",
    });
    expect(res.ok).toBe(true);
    const onDisk = v.read("rmtag.md");
    expect(onDisk).not.toContain(secret);
    expect(onDisk).toContain("[REDACTED]");
    expect(onDisk).not.toContain("drop-me");
  });
});

// ---------------------------------------------------------------------------------------------
// rewrite_link — `to_target` is caller-controlled and gets spliced into potentially many notes;
// a real run always gates on confirmation (elicit token), so this needs the probe -> mint ->
// retry dance every other rewrite_link test in links-tools.test.ts already uses.
// ---------------------------------------------------------------------------------------------

describe("rewrite_link — a secret-shaped to_target refuses the whole rewrite, scanned before any note is written (item 1)", () => {
  let v: TestVault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("block mode: refused after confirmation, note left untouched", async () => {
    const secret = fakeOpenAiKey();
    v = makeTestVault({
      files: { "link.md": "See [[old-target]].\n" },
      memoryDefense: { mode: "block", pii: false },
    });
    const input = { vault: "test", from_target: "old-target", to_target: secret, dry_run: false };
    const need = await v.call("rewrite_link", input);
    expect(need.ok).toBe(false);
    if (!need.ok) expect(need.error.code).toBe("elicit_required");
    const token = mint(v, "rewrite_link", hashOf(need));
    const res = await v.call("rewrite_link", input, { elicitToken: token });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(errOf(res).code).toBe("secret_detected");
    expect(v.read("link.md")).toContain("old-target");
    expect(v.read("link.md")).not.toContain(secret);
  });

  it("redact mode: the rewrite lands with the secret redacted, never raw", async () => {
    const secret = fakeOpenAiKey();
    v = makeTestVault({
      files: { "link.md": "See [[old-target]].\n" },
      memoryDefense: { mode: "redact", pii: false },
    });
    const input = { vault: "test", from_target: "old-target", to_target: secret, dry_run: false };
    const need = await v.call("rewrite_link", input);
    const token = mint(v, "rewrite_link", hashOf(need));
    const res = await v.call("rewrite_link", input, { elicitToken: token });
    expect(res.ok).toBe(true);
    const onDisk = v.read("link.md");
    expect(onDisk).not.toContain(secret);
    expect(onDisk).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------------------------
// prune_hub_links — same elicit-token contract as rewrite_link; a pre-existing secret elsewhere
// in the hub note (predates memoryDefense) refuses/redacts the whole rewrite.
// ---------------------------------------------------------------------------------------------

describe("prune_hub_links — a pre-existing secret elsewhere in the hub note refuses/redacts the whole rewrite (item 1)", () => {
  let v: TestVault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("block mode: refused after confirmation, note left byte-identical", async () => {
    const secret = fakeOpenAiKey();
    const seed = `# Hub\n- [[Dangling]]\n\n${secret}\n`;
    v = makeTestVault({
      files: { "hub.md": seed },
      memoryDefense: { mode: "block", pii: false },
    });
    const input = { vault: "test", path: "hub.md", dry_run: false };
    const need = await v.call("prune_hub_links", input);
    expect(need.ok).toBe(false);
    if (!need.ok) expect(need.error.code).toBe("elicit_required");
    const token = mint(v, "prune_hub_links", hashOf(need));
    const res = await v.call("prune_hub_links", input, { elicitToken: token });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(errOf(res).code).toBe("secret_detected");
    expect(v.read("hub.md")).toBe(seed);
  });

  it("redact mode: the dangling link IS pruned, and the pre-existing secret is redacted", async () => {
    const secret = fakeOpenAiKey();
    const seed = `# Hub\n- [[Dangling]]\n\n${secret}\n`;
    v = makeTestVault({
      files: { "hub.md": seed },
      memoryDefense: { mode: "redact", pii: false },
    });
    const input = { vault: "test", path: "hub.md", dry_run: false };
    const need = await v.call("prune_hub_links", input);
    const token = mint(v, "prune_hub_links", hashOf(need));
    const res = await v.call("prune_hub_links", input, { elicitToken: token });
    expect(res.ok).toBe(true);
    const onDisk = v.read("hub.md");
    expect(onDisk).not.toContain(secret);
    expect(onDisk).toContain("[REDACTED]");
    expect(onDisk).not.toContain("[[Dangling]]");
  });
});

// ---------------------------------------------------------------------------------------------
// move_note / copy_note — content scan (pre-existing secret) AND destination-path refusal
// (mirrors commit_capture's target_path refusal, even in redact mode)
// ---------------------------------------------------------------------------------------------

describe("move_note / copy_note — relocated content is scanned (item 1)", () => {
  let v: TestVault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("move_note: a pre-existing secret in the source note (predates memoryDefense) is refused in block mode", async () => {
    const secret = fakeOpenAiKey();
    v = makeTestVault({
      files: { "src.md": `legacy note\n\n${secret}\n` },
      memoryDefense: { mode: "block", pii: false },
    });
    const res = await v.call("move_note", { vault: "test", from: "src.md", to: "dest.md" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(errOf(res).code).toBe("secret_detected");
    expect(v.exists("dest.md")).toBe(false);
    // Source untouched — the write refused before hardDelete(fromAbs) ran.
    expect(v.exists("src.md")).toBe(true);
  });

  it("copy_note: a pre-existing secret in the source note is refused in block mode, source unaffected", async () => {
    const secret = fakeOpenAiKey();
    v = makeTestVault({
      files: { "src.md": `legacy note\n\n${secret}\n` },
      memoryDefense: { mode: "block", pii: false },
    });
    const res = await v.call("copy_note", { vault: "test", from: "src.md", to: "dest.md" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(errOf(res).code).toBe("secret_detected");
    expect(v.exists("dest.md")).toBe(false);
  });

  it("move_note: redact mode relocates with the secret redacted, never raw", async () => {
    const secret = fakeOpenAiKey();
    v = makeTestVault({
      files: { "src.md": `legacy note\n\n${secret}\n` },
      memoryDefense: { mode: "redact", pii: false },
    });
    const res = await v.call("move_note", { vault: "test", from: "src.md", to: "dest.md" });
    expect(res.ok).toBe(true);
    expect(v.read("dest.md")).not.toContain(secret);
    expect(v.read("dest.md")).toContain("[REDACTED]");
  });
});

describe("move_note / copy_note — a secret-shaped DESTINATION path is refused even in redact mode (item 1, mirrors commit_capture)", () => {
  let v: TestVault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("move_note: destination path itself secret-shaped -> refused in redact mode, nothing written at ANY path", async () => {
    const secret = fakeOpenAiKey();
    v = makeTestVault({
      files: { "clean-src.md": "clean note, nothing secret here\n" },
      memoryDefense: { mode: "redact", pii: false },
    });
    const res = await v.call("move_note", {
      vault: "test",
      from: "clean-src.md",
      to: `${secret}.md`,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(errOf(res).code).toBe("secret_detected");
    expect(v.exists(`${secret}.md`)).toBe(false);
    expect(v.exists("clean-src.md")).toBe(true);
  });

  it("copy_note: destination path itself secret-shaped -> refused in redact mode", async () => {
    const secret = fakeOpenAiKey();
    v = makeTestVault({
      files: { "clean-src.md": "clean note, nothing secret here\n" },
      memoryDefense: { mode: "redact", pii: false },
    });
    const res = await v.call("copy_note", {
      vault: "test",
      from: "clean-src.md",
      to: `${secret}.md`,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(errOf(res).code).toBe("secret_detected");
    expect(v.exists(`${secret}.md`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// move_note backlink rewrite — security review round (MEDIUM #5): updateBacklinks used to write
// its rewritten body straight via writeNoteAtomic, with NO memoryDefense scan at all — a note
// whose ONLY hit is a pre-existing secret elsewhere in its body (untouched by the link-text edit
// itself) used to be silently re-persisted unscanned by a move that only intended to repoint one
// link. This is the RED case that gap would have missed.
// ---------------------------------------------------------------------------------------------

describe("move_note — the backlink rewrite in OTHER notes is scanned too, not just the moved note itself (item 5)", () => {
  let v: TestVault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("block mode: a pre-existing secret in a note that links to the moved note refuses the whole move, backlink left unrewritten", async () => {
    const secret = fakeOpenAiKey();
    v = makeTestVault({
      files: {
        "src.md": "clean note being moved\n",
        "linker.md": `See [[src]].\n\n${secret}\n`,
      },
      memoryDefense: { mode: "block", pii: false },
    });
    const res = await v.call("move_note", {
      vault: "test",
      from: "src.md",
      to: "dest.md",
      update_backlinks: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(errOf(res).code).toBe("secret_detected");
    // linker.md's backlink is byte-identical — never rewritten to point at dest.
    expect(v.read("linker.md")).toContain("[[src]]");
    expect(v.read("linker.md")).not.toContain("[[dest]]");
  });

  it("redact mode: the backlink IS rewritten, and the pre-existing secret in that same note is redacted in the same write", async () => {
    const secret = fakeOpenAiKey();
    v = makeTestVault({
      files: {
        "src.md": "clean note being moved\n",
        "linker.md": `See [[src]].\n\n${secret}\n`,
      },
      memoryDefense: { mode: "redact", pii: false },
    });
    const res = await v.call("move_note", {
      vault: "test",
      from: "src.md",
      to: "dest.md",
      update_backlinks: true,
    });
    expect(res.ok).toBe(true);
    const onDisk = v.read("linker.md");
    expect(onDisk).not.toContain(secret);
    expect(onDisk).toContain("[REDACTED]");
    expect(onDisk).toContain("[[dest]]");
  });
});

// ---------------------------------------------------------------------------------------------
// Response echoes — security review round (MEDIUM #7): a tool that embeds a caller-supplied
// value into persisted content must not still hand the RAW value back in its own response after
// redacting it on disk — that just relocates the leak from the file to the response payload.
// ---------------------------------------------------------------------------------------------

describe("response echoes are scanned, not raw (item 7)", () => {
  let v: TestVault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("add_tag: redact mode returns the SCANNED tag, not the raw caller-supplied one", async () => {
    const secret = fakeOpenAiKey();
    v = makeTestVault({
      files: { "tag.md": "---\ntitle: tag\n---\nbody\n" },
      memoryDefense: { mode: "redact", pii: false },
    });
    const res = await v.call("add_tag", {
      vault: "test",
      path: "tag.md",
      tag: secret,
      location: "inline",
    });
    expect(res.ok).toBe(true);
    const tag = un<{ tag: string }>(res).tag;
    expect(tag).not.toContain(secret);
    expect(v.read("tag.md")).not.toContain(secret);
  });

  it("rewrite_link: redact mode returns the SCANNED to_target in a dry_run PREVIEW too, not just a real run", async () => {
    const secret = fakeOpenAiKey();
    v = makeTestVault({
      files: { "link.md": "See [[old-target]].\n" },
      memoryDefense: { mode: "redact", pii: false },
    });
    const res = await v.call("rewrite_link", {
      vault: "test",
      from_target: "old-target",
      to_target: secret,
      dry_run: true,
    });
    expect(res.ok).toBe(true);
    const echoed = un<{ to_target: string }>(res).to_target;
    expect(echoed).not.toContain(secret);
  });

  it("prune_hub_links: content_hash matches the bytes ACTUALLY persisted, not the pre-scan preview", async () => {
    const secret = fakeOpenAiKey();
    const seed = `# Hub\n- [[Dangling]]\n\n${secret}\n`;
    v = makeTestVault({
      files: { "hub.md": seed },
      memoryDefense: { mode: "redact", pii: false },
    });
    const input = { vault: "test", path: "hub.md", dry_run: false };
    const need = await v.call("prune_hub_links", input);
    const token = mint(v, "prune_hub_links", hashOf(need));
    const res = await v.call("prune_hub_links", input, { elicitToken: token });
    expect(res.ok).toBe(true);
    const { content_hash } = un<{ content_hash: string }>(res);
    // Same contentHash the tool itself uses, over the note as it sits on disk NOW.
    const onDisk = v.read("hub.md");
    expect(onDisk).not.toContain(secret);
    expect(content_hash).toBe(contentHash(onDisk));
  });
});

// ---------------------------------------------------------------------------------------------
// REAL-WIRING integration test — buildServerRuntime + configFromVaultPath, dispatched through the
// registry exactly as production wires it, mirroring test/memory-defense.test.ts's own "all N
// writers, through the PRODUCTION composition root" pattern — proves wireM1Tools in
// server-runtime.ts actually threads memoryDefense/metrics through, not just that M1Deps' shape
// supports it.
// ---------------------------------------------------------------------------------------------

describe("M1 sibling writers — real wiring (buildServerRuntime), block mode refuses through the PRODUCTION composition root (item 1)", () => {
  const tmpDirs: string[] = [];
  const tmpDir = (prefix: string): string => {
    const d = makeTempDir(prefix);
    tmpDirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmTemp(d);
      } catch {
        // best-effort, same concession memory-defense.test.ts's own real-wiring test makes
      }
    }
  });

  it("update_frontmatter, add_tag, and move_note's destination-path check all refuse a planted secret through buildServerRuntime, and nothing persists", async () => {
    const vaultDir = tmpDir("otc-m1-memdef-vault-");
    writeFileSync(join(vaultDir, "fm.md"), "---\ntitle: fm\n---\nbody\n");
    writeFileSync(join(vaultDir, "tag.md"), "---\ntitle: tag\n---\nbody\n");
    writeFileSync(join(vaultDir, "move-src.md"), "clean note\n");

    const config = configFromVaultPath(vaultDir);
    config.cacheDir = tmpDir("otc-m1-memdef-cache-");
    const vault = config.vaults[0];
    if (!vault) throw new Error("configFromVaultPath did not return a vault");
    vault.memoryDefense = { mode: "block", pii: false };

    const runtime = await buildServerRuntime(config, join(vaultDir, "config.json"));
    try {
      const db: Database = openMemoryDb();
      provisionCacheDb(db);
      const ctx: CallerContext = {
        caller: "test",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "main",
        db,
      };

      const secret = fakeOpenAiKey();
      const table: Array<{ tool: string; args: Record<string, unknown> }> = [
        {
          tool: "update_frontmatter",
          args: { vault: "main", path: "fm.md", operation: "merge", properties: { note: secret } },
        },
        {
          tool: "add_tag",
          args: { vault: "main", path: "tag.md", tag: secret, location: "frontmatter" },
        },
        {
          tool: "move_note",
          args: { vault: "main", from: "move-src.md", to: `${secret}.md` },
        },
      ];

      for (const tc of table) {
        const res = await runtime.registry.dispatch(tc.tool, tc.args, ctx);
        expect(res.ok, `${tc.tool} should have been refused`).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("secret_detected");
      }

      // Nothing persisted: the frontmatter/tag notes are byte-identical to their seed, and the
      // move destination was never created.
      const read = un<{ content: string }>(
        await runtime.registry.dispatch("read_note", { vault: "main", path: "fm.md" }, ctx),
      );
      expect(read.content).not.toContain(secret);
      const tagRead = un<{ content: string }>(
        await runtime.registry.dispatch("read_note", { vault: "main", path: "tag.md" }, ctx),
      );
      expect(tagRead.content).not.toContain(secret);
      const exists = un<{ exists: boolean }>(
        await runtime.registry.dispatch(
          "note_exists",
          { vault: "main", path: `${secret}.md` },
          ctx,
        ),
      );
      expect(exists.exists).toBe(false);
    } finally {
      await runtime.close("test cleanup");
    }
  });
});
