// The raw folder is immutable, and that includes the SECONDARY writes of a rename: move_note,
// bulk_move_notes and move_attachment repoint the links in every note that links the moved target,
// outside the caller's write whitelist (a deliberate graph-integrity carve-out). That carve-out must
// never reach an immutable path: the move proceeds, a raw note that links the target is left alone,
// and the result says so. Reproductions are the two security reviews' of the raw-folder change.
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { buildAcls } from "../src/runtime/acl-build";
import { registerM3Tools } from "../src/tools/m3";
import { buildBulkTools } from "../src/tools/m6/bulk-tools";
import type { M6Deps } from "../src/tools/m6/shared";
import { ImmutableRewriteSkips } from "../src/vault/acl-path";
import { hashTree, makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const SOURCE = "# Source\n\nSee ![[old.png]] and [[Target]].\n";
const HIDDEN = "# Hidden\n\n[[Target]] and ![[old.png]].\n";
const FILES: Record<string, string> = {
  "wiki/SCHEMA.md": "---\ntypes:\n  concept:\n    required: [type]\nproperties:\n  type:\n---\n",
  "raw/source.md": SOURCE,
  "raw/hidden.md": HIDDEN,
  "notes/Target.md": "# Target\n",
  "notes/linker.md": "Links [[Target]] and embeds ![[old.png]].\n",
  "assets/old.png": "PNG",
};

let h: WikiHarness;
afterEach(() => h?.v.cleanup());

function harness(opts: Parameters<typeof makeWikiHarness>[0] = {}): WikiHarness {
  h = makeWikiHarness({ files: FILES, wikiFolder: "wiki", ...opts });
  registerM3Tools(h.v.registry, { vaultRegistry: h.v.vaultRegistry } as never);
  for (const t of buildBulkTools({
    vaultRegistry: h.v.vaultRegistry,
    throttle: { maxConcurrentWritesPerVault: 4 },
  } as unknown as M6Deps))
    h.v.registry.register(t);
  return h;
}

const rawBytes = (): Record<string, string> =>
  Object.fromEntries(Object.entries(hashTree(h.v.root)).filter(([p]) => p.startsWith("raw/")));

/** Run `name`, answering the confirmation (a folder change, or a bulk move) when it asks. */
async function confirmed(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const first = await h.call(name, input);
  if (first.ok || first.error?.code !== "elicit_required") return first;
  const argsHash = (first.error.details as { args_hash: string }).args_hash;
  const elicitToken = issueElicitToken(h.v.db, {
    vaultId: "test",
    toolName: name,
    argsHash,
    caller: "test",
  });
  return h.v.call(name, { vault: "test", ...input }, { elicitToken });
}

describe("move_attachment (the codex reproduction)", () => {
  it("does not rewrite ![[old.png]] in raw/source.md, and names the note it left", async () => {
    harness();
    const before = rawBytes();
    const r = await confirmed("move_attachment", { from: "assets/old.png", to: "assets/new.png" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.v.exists("assets/new.png")).toBe(true);
    expect(h.v.read("raw/source.md")).toBe(SOURCE);
    expect(rawBytes()).toEqual(before);
    // the ordinary linker is still repointed: only the immutable notes are exempt
    expect(h.v.read("notes/linker.md")).toContain("![[new.png]]");
    const d = (r as { data: Record<string, unknown> }).data;
    expect(d.immutable_not_updated).toEqual(["raw/hidden.md", "raw/source.md"]);
    expect(String(d.immutable_warning)).toMatch(/old name/);
    expect(d.references_updated).toEqual({ notes: 1, refs: 1 });
  });
});

describe("move_note (a same-folder rename of a note a raw file links)", () => {
  it("leaves the raw notes alone, repoints the rest, and reports the raw ones", async () => {
    harness();
    const before = rawBytes();
    const r = await confirmed("move_note", { from: "notes/Target.md", to: "notes/Renamed.md" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.v.exists("notes/Renamed.md")).toBe(true);
    expect(rawBytes()).toEqual(before);
    expect(h.v.read("notes/linker.md")).toContain("[[Renamed]]");
    const d = (r as { data: Record<string, unknown> }).data;
    expect(d.backlinks_updated).toEqual({ notes: 1, links: 1 });
    expect(d.immutable_not_updated).toEqual(["raw/hidden.md", "raw/source.md"]);
    expect(String(d.immutable_warning)).toMatch(/old name/);
  });

  it("an unaffected move reports nothing extra", async () => {
    harness();
    const r = await confirmed("move_note", { from: "notes/linker.md", to: "notes/linker2.md" });
    expect(r.ok).toBe(true);
    const d = (r as { data: Record<string, unknown> }).data;
    expect(d).not.toHaveProperty("immutable_not_updated");
    expect(d).not.toHaveProperty("immutable_warning");
  });
});

describe("bulk_move_notes", () => {
  const input = {
    moves: [{ from: "notes/Target.md", to: "notes/Renamed.md" }],
    dry_run: false,
  };

  it("leaves the raw notes alone and reports them", async () => {
    harness();
    const before = rawBytes();
    const r = await confirmed("bulk_move_notes", input);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.v.exists("notes/Renamed.md")).toBe(true);
    expect(rawBytes()).toEqual(before);
    expect(h.v.read("notes/linker.md")).toContain("[[Renamed]]");
    const d = (r as { data: Record<string, unknown> }).data;
    expect(d.total_backlinks_updated).toBe(1);
    expect(d.immutable_not_updated).toEqual(["raw/hidden.md", "raw/source.md"]);
    expect(String(d.immutable_warning)).toMatch(/old name/);
  });

  it("the dry run predicts the same: raw links are not counted, and are listed", async () => {
    harness();
    const before = hashTree(h.v.root);
    const r = await confirmed("bulk_move_notes", { ...input, dry_run: true });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const d = (r as { data: Record<string, unknown> }).data;
    expect(d.total_backlinks_updated).toBe(1);
    expect(d.immutable_not_updated).toEqual(["raw/hidden.md", "raw/source.md"]);
    expect(hashTree(h.v.root)).toEqual(before);
  });
});

describe("a raw note the caller cannot read", () => {
  // read-denied everywhere but the folders the moves touch: raw/ is neither readable nor writable.
  const acl = { readPaths: ["notes/**", "assets/**", "wiki/**"] };

  for (const [tool, input] of [
    ["move_attachment", { from: "assets/old.png", to: "assets/new.png" }],
    ["move_note", { from: "notes/Target.md", to: "notes/Renamed.md" }],
    [
      "bulk_move_notes",
      { moves: [{ from: "notes/Target.md", to: "notes/Renamed.md" }], dry_run: false },
    ],
  ] as const) {
    it(`${tool}: is not touched, and is a count, never a path`, async () => {
      harness({ acl });
      const before = rawBytes();
      const r = await confirmed(tool, { ...input });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(rawBytes()).toEqual(before);
      const out = JSON.stringify((r as { data: unknown }).data);
      expect(out).not.toContain("raw/");
      expect((r as { data: Record<string, unknown> }).data.immutable_not_updated_hidden).toBe(2);
      expect((r as { data: Record<string, unknown> }).data).not.toHaveProperty(
        "immutable_not_updated",
      );
    });
  }

  it("a mix: the readable raw note is named, the other is only counted", async () => {
    harness({ acl: { readPaths: ["notes/**", "assets/**", "wiki/**", "raw/source.md"] } });
    const r = await confirmed("move_note", { from: "notes/Target.md", to: "notes/Renamed.md" });
    expect(r.ok).toBe(true);
    const d = (r as { data: Record<string, unknown> }).data;
    expect(d.immutable_not_updated).toEqual(["raw/source.md"]);
    expect(d.immutable_not_updated_hidden).toBe(1);
    expect(JSON.stringify(d)).not.toContain("raw/hidden.md");
  });
});

describe.skipIf(process.platform === "win32")("the guard judges the resolved path too", () => {
  // The vault walk does not follow symlinks, so no rewrite reaches a raw note through one today; the
  // guard must still not depend on that.
  it("a path that resolves into raw/ is blocked though its name is not under raw/", () => {
    harness();
    const abs = join(h.v.root, "notes/lnk");
    mkdirSync(dirname(abs), { recursive: true });
    symlinkSync(join(h.v.root, "raw"), abs);
    const acl = buildAcls({ readOnly: false, defaultScopes: [], rules: [] }, [
      { id: "test", wiki: { folder: "wiki" } },
    ]).aclByVault.get("test");
    const skips = new ImmutableRewriteSkips(acl, h.v.root, ["*"]);
    expect(skips.blocks("notes/lnk/source.md")).toBe(true);
    expect(skips.blocks("notes/linker.md")).toBe(false);
    expect(skips.out().immutable_not_updated).toEqual(["notes/lnk/source.md"]);
  });

  it("a path that cannot be resolved fails closed", () => {
    harness();
    const acl = buildAcls({ readOnly: false, defaultScopes: [], rules: [] }, [
      { id: "test", wiki: { folder: "wiki" } },
    ]).aclByVault.get("test");
    const skips = new ImmutableRewriteSkips(acl, h.v.root, ["*"]);
    symlinkSync("/", join(h.v.root, "notes/out"));
    expect(skips.blocks("notes/out/etc/passwd")).toBe(true);
  });
});

describe("a vault with no raw folder keeps the carve-out unchanged", () => {
  it("rewrites every linking note, as before", async () => {
    h = makeWikiHarness({ files: FILES });
    const r = await h.call("move_note", { from: "notes/Target.md", to: "notes/Renamed.md" });
    expect(r.ok).toBe(true);
    expect(h.v.read("raw/source.md")).toContain("[[Renamed]]");
    expect((r as { data: Record<string, unknown> }).data).not.toHaveProperty(
      "immutable_not_updated",
    );
  });
});
