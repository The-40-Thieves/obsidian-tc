// Round two of the pre-move link proof (security review of the first). The plan the first round
// built is now what gets committed, so this file pins the commit: a refusal never names a note the
// caller cannot read; the plan is bound to the bytes it overwrites (a note edited, or a backlink
// added, between plan and commit re-plans and re-proves, then refuses with nothing moved); the move
// and every rewrite land as ONE write batch that rolls back whole; bulk_move_notes commits the plan
// it proved instead of recomputing after the files moved; and an immutable raw note is skipped
// BEFORE its links are proven, so an unrepresentable link in it cannot veto the move.
//
// Each case runs against move_note, bulk_move_notes and move_attachment: they share one planner.
import { readdirSync } from "node:fs";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { registerM3Tools } from "../src/tools/m3";
import { buildBulkTools } from "../src/tools/m6/bulk-tools";
import type { M6Deps } from "../src/tools/m6/shared";
import * as notesIo from "../src/vault/notes-io";
import * as writeBatch from "../src/vault/write-batch";
import { hashTree, makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const SCHEMA = "---\ntypes:\n  concept:\n    required: [type]\nproperties:\n  type:\n---\n";
const secret = ["sk", "-", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
const BLOCK = { mode: "block", pii: false } as const;

let h: WikiHarness;
afterEach(() => {
  vi.restoreAllMocks();
  h?.v.cleanup();
});

interface RigOptions {
  acl?: Record<string, unknown>;
  snapshots?: { enabled: boolean; retention: number };
  memoryDefense?: typeof BLOCK;
}

function rig(files: Record<string, string>, opts: RigOptions = {}): WikiHarness {
  h = makeWikiHarness({
    files: { "wiki/SCHEMA.md": SCHEMA, ...files },
    wikiFolder: "wiki",
    ...(opts.acl ? { acl: opts.acl } : {}),
    ...(opts.snapshots ? { snapshots: opts.snapshots } : {}),
    ...(opts.memoryDefense ? { memoryDefense: opts.memoryDefense } : {}),
  });
  const md = opts.memoryDefense ? { memoryDefense: () => opts.memoryDefense } : {};
  const shared = {
    vaultRegistry: h.v.vaultRegistry,
    ...(opts.snapshots ? { snapshots: opts.snapshots } : {}),
    ...md,
  };
  registerM3Tools(h.v.registry, shared as never);
  for (const t of buildBulkTools({
    ...shared,
    throttle: { maxConcurrentWritesPerVault: 4 },
  } as unknown as M6Deps))
    h.v.registry.register(t);
  return h;
}

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

interface Case {
  tool: string;
  src: string;
  srcBody: string;
  /** A link to the source that survives any destination (a wikilink). */
  link: string;
  /** A markdown link to the source: unrepresentable at the `hostile` destination. */
  mdLink: string;
  ok: string;
  okLink: string;
  hostile: string;
  hostileLink: string;
  input: (to: string) => Record<string, unknown>;
}

const CASES: Case[] = [
  {
    tool: "move_note",
    src: "notes/Old.md",
    srcBody: "body\n",
    link: "[[Old]]",
    mdLink: "[x](Old.md)",
    ok: "notes/Fresh.md",
    okLink: "[[Fresh]]",
    hostile: "notes/Report (final).md",
    hostileLink: "[[Report (final)]]",
    input: (to) => ({ from: "notes/Old.md", to }),
  },
  {
    tool: "bulk_move_notes",
    src: "notes/Old.md",
    srcBody: "body\n",
    link: "[[Old]]",
    mdLink: "[x](Old.md)",
    ok: "notes/Fresh.md",
    okLink: "[[Fresh]]",
    hostile: "notes/Report (final).md",
    hostileLink: "[[Report (final)]]",
    input: (to) => ({ moves: [{ from: "notes/Old.md", to }], dry_run: false }),
  },
  {
    tool: "move_attachment",
    src: "assets/pic.png",
    srcBody: "PNG",
    link: "![[pic.png]]",
    mdLink: "![x](pic.png)",
    ok: "assets/pic2.png",
    okLink: "![[pic2.png]]",
    hostile: "assets/pic (1).png",
    hostileLink: "![[pic (1).png]]",
    input: (to) => ({ from: "assets/pic.png", to }),
  },
];

const base = (c: Case, extra: Record<string, string> = {}): Record<string, string> => ({
  [c.src]: c.srcBody,
  ...extra,
});

function expectRefused(r: ToolResult, code = "invalid_input"): void {
  expect(r.ok, JSON.stringify(r)).toBe(false);
  if (!r.ok) expect(r.error.code).toBe(code);
}

describe.each(CASES)("$tool: a refusal never names a note the caller cannot read", (c) => {
  const acl = { readPaths: ["notes/**", "assets/**", "wiki/**"] };

  it("a read-denied note whose link cannot be written is a count, never a path", async () => {
    rig(base(c, { "private/hidden.md": `See ${c.mdLink}\n` }), { acl });
    const before = hashTree(h.v.root);
    const r = await confirmed(c.tool, c.input(c.hostile));
    expectRefused(r);
    const wire = JSON.stringify(r);
    expect(wire).not.toContain("private");
    expect(wire).not.toContain("hidden.md");
    if (!r.ok) expect(r.error.details).toMatchObject({ hidden_notes: 1 });
    expect(hashTree(h.v.root)).toEqual(before);
  });

  it("a readable note is still named, and the hidden one is only counted", async () => {
    rig(
      base(c, {
        "private/hidden.md": `See ${c.mdLink}\n`,
        "notes/visible.md": `See ${c.mdLink}\n`,
      }),
      { acl },
    );
    const r = await confirmed(c.tool, c.input(c.hostile));
    expectRefused(r);
    if (!r.ok) {
      expect(r.error.message).toContain("notes/visible.md");
      expect(r.error.details).toMatchObject({ note: "notes/visible.md", hidden_notes: 1 });
    }
    expect(JSON.stringify(r)).not.toContain("private");
  });
});

describe.each(CASES)("$tool: a stale plan is re-planned, then refused with nothing moved", (c) => {
  const files = (): Record<string, string> => base(c, { "notes/linker.md": `See ${c.link}.\n` });

  /** Run `mutate` once the plan exists, immediately before the batch commits (`recheck`: before
   *  its re-plan; `cas`: after the re-plan, so only the CAS can see it). */
  function drift(
    mutate: (n: number) => void,
    when: "recheck" | "cas",
    times = 1,
  ): ReturnType<typeof vi.spyOn> {
    const real = writeBatch.applyWriteBatch;
    let n = 0;
    return vi.spyOn(writeBatch, "applyWriteBatch").mockImplementation((writes, hooks = {}) => {
      const k = n++;
      if (k >= times) return real(writes, hooks);
      if (when === "recheck") {
        mutate(k);
        return real(writes, hooks);
      }
      return real(writes, {
        ...hooks,
        beforeCommit: () => {
          hooks.beforeCommit?.();
          mutate(k);
        },
      });
    });
  }

  it.each(["recheck", "cas"] as const)(
    "a planned note edited before the commit (%s): re-planned, the edit survives",
    async (when) => {
      rig(files());
      const spy = drift(() => h.v.write("notes/linker.md", `See ${c.link}. Edited.\n`), when);
      const r = await confirmed(c.tool, c.input(c.ok));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(h.v.read("notes/linker.md")).toBe(`See ${c.okLink}. Edited.\n`);
      expect(h.v.exists(c.ok)).toBe(true);
      expect(h.v.exists(c.src)).toBe(false);
    },
  );

  it("a backlink that appears after planning is rewritten too", async () => {
    rig(files());
    drift(() => h.v.write("notes/late.md", `Late ${c.link}.\n`), "recheck");
    const r = await confirmed(c.tool, c.input(c.ok));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.v.read("notes/late.md")).toBe(`Late ${c.okLink}.\n`);
    expect(h.v.read("notes/linker.md")).toBe(`See ${c.okLink}.\n`);
  });

  it("a backlink that appears after planning and cannot be written refuses; nothing moved", async () => {
    rig(files());
    drift(() => h.v.write("notes/late.md", `Late ${c.mdLink}\n`), "recheck");
    const before = hashTree(h.v.root);
    const r = await confirmed(c.tool, c.input(c.hostile));
    expectRefused(r);
    expect(h.v.exists(c.src)).toBe(true);
    expect(h.v.exists(c.hostile)).toBe(false);
    expect(h.v.read("notes/linker.md")).toBe(`See ${c.link}.\n`);
    // the only difference from the start is the note the test planted
    expect({ ...hashTree(h.v.root), "notes/late.md": undefined }).toEqual({
      ...before,
      "notes/late.md": undefined,
    });
  });

  it("a vault that keeps changing is refused after the one re-plan, nothing moved", async () => {
    rig(files());
    drift((n) => h.v.write("notes/linker.md", `See ${c.link}. Edit ${n}.\n`), "recheck", 5);
    const r = await confirmed(c.tool, c.input(c.ok));
    expectRefused(r, "concurrent_modification");
    expect(h.v.exists(c.src)).toBe(true);
    expect(h.v.exists(c.ok)).toBe(false);
    expect(h.v.read("notes/linker.md")).toContain(c.link);
    expect(h.v.read("notes/linker.md")).not.toContain(c.okLink);
  });
});

describe.each(CASES)("$tool: the move and its rewrites land as one batch", (c) => {
  const files = (): Record<string, string> =>
    base(c, { "notes/a.md": `A ${c.link}\n`, "notes/b.md": `B ${c.link}\n` });

  /** Fail the rename of notes/b.md, the LAST write of the batch, after every other one landed. */
  function failLastWrite(): void {
    const real = notesIo.stageNoteWrite;
    vi.spyOn(notesIo, "stageNoteWrite").mockImplementation((abs, ...rest) => {
      const staged = real(abs, ...rest);
      if (!abs.endsWith("notes/b.md")) return staged;
      return {
        commit() {
          staged.discard();
          throw new Error("EIO: injected write failure");
        },
        discard: () => staged.discard(),
      };
    });
  }

  it("an I/O failure on the last write rolls back every earlier one, the move included", async () => {
    rig(files(), { snapshots: { enabled: true, retention: 5 } });
    const before = hashTree(h.v.root);
    failLastWrite();
    const r = await confirmed(c.tool, c.input(c.ok));
    expect(r.ok, JSON.stringify(r)).toBe(false);
    if (!r.ok) expect(r.error.details?.reason).not.toBe("rollback_incomplete");
    expect(hashTree(h.v.root)).toEqual(before);
    expect(h.v.exists(c.src)).toBe(true);
    // a failed batch leaves no recovery points behind
    expect(h.v.db.prepare("SELECT COUNT(*) AS n FROM note_snapshots").get()).toEqual({ n: 0 });
    expect(
      readdirSync(h.v.root, { recursive: true }).filter((p) => String(p).includes(".tmp-")),
    ).toEqual([]);
  });

  it("the pre-image of every rewritten note is snapshotted", async () => {
    rig(files(), { snapshots: { enabled: true, retention: 5 } });
    const r = await confirmed(c.tool, c.input(c.ok));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const rows = h.v.db
      .prepare("SELECT path, op FROM note_snapshots ORDER BY path")
      .all() as Array<{ path: string; op: string }>;
    expect(rows).toEqual([
      { path: "notes/a.md", op: c.tool },
      { path: "notes/b.md", op: c.tool },
    ]);
  });
});

describe.each(CASES)("$tool: memoryDefense block mode refuses before anything moves", (c) => {
  it("a backlink note a rewrite would leave secret-shaped refuses with the source in place", async () => {
    rig(base(c, { "notes/linker.md": `See ${c.link} ${secret}\n` }), { memoryDefense: BLOCK });
    const before = hashTree(h.v.root);
    const r = await confirmed(c.tool, c.input(c.ok));
    expectRefused(r, "secret_detected");
    expect(hashTree(h.v.root)).toEqual(before);
  });
});

describe("bulk reuses its preflight plan", () => {
  it("a row refused by the scan drops out BEFORE the plan, so nothing moves under a plan that assumed it", async () => {
    // n/Note.md is refused (a secret in it), so after the batch Note is still ambiguous and the
    // surviving move needs a path link, which the existing C#/ folder cannot carry. The old code
    // proved the plan with BOTH rows moving, moved Note.md, then recomputed and refused.
    rig(
      {
        "Note.md": "body\n",
        "n/Note.md": `key ${secret}\n`,
        "C#/keep.md": "kept\n",
        "linker.md": "See [[Note]].\n",
      },
      { memoryDefense: BLOCK },
    );
    const before = hashTree(h.v.root);
    const r = await confirmed("bulk_move_notes", {
      moves: [
        { from: "Note.md", to: "C#/Note.md" },
        { from: "n/Note.md", to: "n/Renamed.md" },
      ],
      dry_run: false,
    });
    expectRefused(r);
    expect(hashTree(h.v.root)).toEqual(before);
  });

  it("a row refused by the scan fails alone and the rest of the batch moves", async () => {
    rig(
      { "A.md": "a\n", "B.md": `key ${secret}\n`, "linker.md": "[[A]] [[B]]\n" },
      { memoryDefense: BLOCK },
    );
    const r = await confirmed("bulk_move_notes", {
      moves: [
        { from: "A.md", to: "A2.md" },
        { from: "B.md", to: "B2.md" },
      ],
      dry_run: false,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) {
      const results = (r.data as { results: Array<{ ok: boolean }> }).results;
      expect(results.map((x) => x.ok)).toEqual([true, false]);
    }
    expect(h.v.read("linker.md")).toBe("[[A2]] [[B]]\n");
    expect(h.v.exists("B.md")).toBe(true);
  });

  it("overwriting the only other note of that name keeps the bare link", async () => {
    // the trash mirror needs its own C#/ folder, which a new name cannot create
    rig({
      "n/Note.md": "moved\n",
      "C#/Note.md": "replaced\n",
      ".trash/C#/keep.md": "kept\n",
      "linker.md": "See [[n/Note]].\n",
    });
    const r = await confirmed("bulk_move_notes", {
      moves: [{ from: "n/Note.md", to: "C#/Note.md" }],
      overwrite: true,
      dry_run: false,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.v.read("C#/Note.md")).toBe("moved\n");
    expect(h.v.read("linker.md")).toBe("See [[Note]].\n");
    expect(h.v.exists("n/Note.md")).toBe(false);
  });

  it("a failing batch puts a trashed overwrite destination back", async () => {
    rig({
      "Old.md": "moved\n",
      "dest/Old.md": "replaced\n",
      "notes/a.md": "A [[Old]]\n",
      "notes/b.md": "B [[Old]]\n",
    });
    const before = hashTree(h.v.root);
    const real = notesIo.stageNoteWrite;
    vi.spyOn(notesIo, "stageNoteWrite").mockImplementation((abs, ...rest) => {
      const staged = real(abs, ...rest);
      if (!abs.endsWith("notes/b.md")) return staged;
      return {
        commit() {
          staged.discard();
          throw new Error("EIO: injected write failure");
        },
        discard: () => staged.discard(),
      };
    });
    const r = await confirmed("bulk_move_notes", {
      moves: [{ from: "Old.md", to: "dest/Old.md" }],
      overwrite: true,
      dry_run: false,
    });
    expect(r.ok).toBe(false);
    expect(hashTree(h.v.root)).toEqual(before);
  });
});

describe("bulk_move_notes: a destination that cannot be moved aside fails its row alone", () => {
  it("the other rows move, planned again without the failed one", async () => {
    rig({
      "A.md": "a\n",
      "C.md": "old c\n",
      "D.md": "d\n",
      "linker.md": "[[A]] [[D]]\n",
    });
    const real = notesIo.trashNote;
    vi.spyOn(notesIo, "trashNote").mockImplementation((root, rel) => {
      if (rel === "C.md") throw new Error("EBUSY: injected");
      return real(root, rel);
    });
    const r = await confirmed("bulk_move_notes", {
      moves: [
        { from: "A.md", to: "C.md" },
        { from: "D.md", to: "D2.md" },
      ],
      overwrite: true,
      dry_run: false,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok)
      expect((r.data as { results: Array<{ ok: boolean }> }).results.map((x) => x.ok)).toEqual([
        false,
        true,
      ]);
    expect(h.v.read("C.md")).toBe("old c\n");
    expect(h.v.exists("A.md")).toBe(true);
    expect(h.v.exists("D2.md")).toBe(true);
    expect(h.v.read("linker.md")).toBe("[[A]] [[D2]]\n");
  });
});

describe.each(CASES)("$tool: the immutable raw folder is skipped before it is proven", (c) => {
  const files = (): Record<string, string> =>
    base(c, { "raw/clip.md": `Clipping ${c.mdLink}\n`, "notes/linker.md": `See ${c.link}.\n` });

  it("an unrepresentable link in a raw note is skipped and reported, not a refusal", async () => {
    rig(files());
    const clip = h.v.read("raw/clip.md");
    const r = await confirmed(c.tool, c.input(c.hostile));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.v.read("raw/clip.md")).toBe(clip);
    expect(h.v.read("notes/linker.md")).toBe(`See ${c.hostileLink}.\n`);
    const d = (r as { data: Record<string, unknown> }).data;
    expect(d.immutable_not_updated).toEqual(["raw/clip.md"]);
    expect(String(d.immutable_warning)).toMatch(/old name/);
  });

  it("a read-denied raw note is only counted", async () => {
    rig(files(), { acl: { readPaths: ["notes/**", "assets/**", "wiki/**"] } });
    const r = await confirmed(c.tool, c.input(c.hostile));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const d = (r as { data: Record<string, unknown> }).data;
    expect(d.immutable_not_updated_hidden).toBe(1);
    expect(JSON.stringify(d)).not.toContain("raw/");
  });

  it("a raw note that does not link the target is not reported", async () => {
    rig({ ...files(), "raw/other.md": "No links here.\n" });
    const r = await confirmed(c.tool, c.input(c.hostile));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((r as { data: Record<string, unknown> }).data.immutable_not_updated).toEqual([
      "raw/clip.md",
    ]);
  });
});
