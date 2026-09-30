// An overwrite is trash-the-destination, then exclusive-create. Two ways that used to lose the
// destination: (1) an EXISTING grandfathered name (`:`, trailing dot/space — legal on Linux) passed
// the write check only because it existed, and the recreate after the trash judged it as a NEW name
// and refused, leaving the file in .trash; (2) a memoryDefense `block` refusal fired after the
// destination was already trashed. One shared step (replaceDestination) now runs every refusal
// BEFORE the trash, re-creates the grandfathered name it just vacated, and rolls back on any failure.
//
// Decision: an in-place overwrite of an existing grandfathered name SUCCEEDS (write_note already
// updates such a file in place; move/copy/bulk/attachment overwrite must not be stricter). Only a
// name that does NOT exist is judged as new.
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { buildBulkTools } from "../src/tools/m6/bulk-tools";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { makeM3Vault } from "./m3-helpers";
import { makeM6Vault } from "./m6-helpers";
import { rmTemp } from "./tmp";
import { type Backend, loadNotesIo } from "./write-io-backends";

const posix = process.platform !== "win32";
const secret = ["sk", "-", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
const BLOCK = { mode: "block", pii: false } as const;

function errCode(r: ToolResult): string {
  return r.ok ? "ok" : r.error.code;
}

async function confirmed(
  v: Pick<TestVault, "call" | "db" | "id">,
  name: string,
  input: Record<string, unknown>,
) {
  const first = await v.call(name, input);
  if (first.ok || first.error.code !== "elicit_required") return first;
  const argsHash = (first.error.details as { args_hash: string }).args_hash;
  const elicitToken = issueElicitToken(v.db, {
    vaultId: v.id,
    toolName: name,
    argsHash,
    caller: "test",
  });
  return v.call(name, input, { elicitToken });
}

/** Files in the vault's .trash mirror (empty when there is none). */
function trashed(root: string): string[] {
  try {
    return readdirSync(join(root, ".trash"));
  } catch {
    return [];
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe.skipIf(!posix)("overwrite onto an EXISTING grandfathered name succeeds in place", () => {
  it("move_note onto `a:b.md`", async () => {
    const v = makeTestVault({ files: { "a:b.md": "OLD", "src.md": "NEW" } });
    cleanups.push(v.cleanup);
    const r = await confirmed(v, "move_note", {
      vault: "test",
      from: "src.md",
      to: "a:b.md",
      overwrite: true,
    });
    expect(errCode(r)).toBe("ok");
    expect(v.read("a:b.md")).toBe("NEW");
    expect(v.exists("src.md")).toBe(false);
    expect(v.read(".trash/a:b.md")).toBe("OLD");
  });

  it("copy_note onto `a:b.md`", async () => {
    const v = makeTestVault({ files: { "a:b.md": "OLD", "src.md": "NEW" } });
    cleanups.push(v.cleanup);
    const r = await confirmed(v, "copy_note", {
      vault: "test",
      from: "src.md",
      to: "a:b.md",
      overwrite: true,
    });
    expect(errCode(r)).toBe("ok");
    expect(v.read("a:b.md")).toBe("NEW");
    expect(v.read("src.md")).toBe("NEW");
    expect(v.read(".trash/a:b.md")).toBe("OLD");
  });

  it("move_attachment onto `img.png.` (trailing dot)", async () => {
    const v = makeM3Vault({ files: { "img.png.": "OLD", "old.png": "NEW" } });
    cleanups.push(v.cleanup);
    const r = await confirmed(v, "move_attachment", {
      vault: "test",
      from: "old.png",
      to: "img.png.",
      overwrite: true,
    });
    expect(errCode(r)).toBe("ok");
    expect(v.read("img.png.")).toBe("NEW");
    expect(v.exists("old.png")).toBe(false);
    expect(v.read(".trash/img.png.")).toBe("OLD");
  });

  it("bulk_move_notes onto `a:b.md`", async () => {
    const v = makeM6Vault({
      files: { "a:b.md": "OLD", "src.md": "NEW" },
      register: (r, d) => {
        for (const t of buildBulkTools(d)) r.register(t);
      },
    });
    cleanups.push(v.cleanup);
    const r = await v.callConfirmed("bulk_move_notes", {
      vault: "test",
      dry_run: false,
      overwrite: true,
      moves: [{ from: "src.md", to: "a:b.md" }],
    });
    expect(errCode(r)).toBe("ok");
    const rows = (r as { data: { results: { ok: boolean }[] } }).data.results;
    expect(rows[0]?.ok).toBe(true);
    expect(v.read("a:b.md")).toBe("NEW");
    expect(v.read(".trash/a:b.md")).toBe("OLD");
  });
});

describe("a memoryDefense refusal happens BEFORE the destination is trashed", () => {
  it("move_note: secret in the source, overwrite of an existing destination", async () => {
    const v = makeTestVault({
      files: { "dest.md": "PRECIOUS", "src.md": `leaked ${secret}\n` },
      memoryDefense: BLOCK,
    });
    cleanups.push(v.cleanup);
    const r = await confirmed(v, "move_note", {
      vault: "test",
      from: "src.md",
      to: "dest.md",
      overwrite: true,
    });
    expect(errCode(r)).toBe("secret_detected");
    expect(v.read("dest.md")).toBe("PRECIOUS");
    expect(v.exists("src.md")).toBe(true);
    expect(trashed(v.root)).toEqual([]);
  });

  it("copy_note: secret in the source, overwrite of an existing destination", async () => {
    const v = makeTestVault({
      files: { "dest.md": "PRECIOUS", "src.md": `leaked ${secret}\n` },
      memoryDefense: BLOCK,
    });
    cleanups.push(v.cleanup);
    const r = await confirmed(v, "copy_note", {
      vault: "test",
      from: "src.md",
      to: "dest.md",
      overwrite: true,
    });
    expect(errCode(r)).toBe("secret_detected");
    expect(v.read("dest.md")).toBe("PRECIOUS");
    expect(trashed(v.root)).toEqual([]);
  });

  it("bulk_move_notes: the failed row leaves the destination and the source untouched", async () => {
    const v = makeM6Vault({
      files: { "dest.md": "PRECIOUS", "src.md": `leaked ${secret}\n` },
      register: (r, d) => {
        for (const t of buildBulkTools({ ...d, memoryDefense: () => BLOCK })) r.register(t);
      },
    });
    cleanups.push(v.cleanup);
    const r = await v.callConfirmed("bulk_move_notes", {
      vault: "test",
      dry_run: false,
      overwrite: true,
      moves: [{ from: "src.md", to: "dest.md" }],
    });
    const rows = (r as { data: { results: { ok: boolean; error?: { code: string } }[] } }).data
      .results;
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.error?.code).toBe("secret_detected");
    expect(v.read("dest.md")).toBe("PRECIOUS");
    expect(v.exists("src.md")).toBe(true);
    expect(trashed(v.root)).toEqual([]);
  });
});

describe.each(["native", "js"] as Backend[])("%s backend: replaceDestination", (backend) => {
  const made: string[] = [];
  function root(): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "otc-rd-")));
    made.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of made.splice(0)) rmTemp(d);
  });

  it("a failing write restores the destination and does NOT mark the effect committed", async () => {
    const io = await loadNotesIo(backend);
    if (!io) return;
    const r = root();
    writeFileSync(join(r, "d.md"), "PRECIOUS");
    let marked = 0;
    expect(() =>
      io.replaceDestination({
        root: r,
        toRel: "d.md",
        toAbs: join(r, "d.md"),
        replacing: true,
        write: () => {
          throw new Error("disk full (injected)");
        },
        markEffectCommitted: () => marked++,
      }),
    ).toThrow(/disk full/);
    expect(readFileSync(join(r, "d.md"), "utf8")).toBe("PRECIOUS");
    expect(fs.existsSync(join(r, ".trash", "d.md"))).toBe(false);
    expect(marked).toBe(0);
  });

  it("a failing write whose restore also fails marks the effect committed (half-applied)", async () => {
    const io = await loadNotesIo(backend);
    if (!io) return;
    const r = root();
    writeFileSync(join(r, "d.md"), "PRECIOUS");
    let marked = 0;
    expect(() =>
      io.replaceDestination({
        root: r,
        toRel: "d.md",
        toAbs: join(r, "d.md"),
        replacing: true,
        write: () => {
          writeFileSync(join(r, "d.md"), "SOMEONE ELSE");
          throw new Error("disk full (injected)");
        },
        markEffectCommitted: () => marked++,
      }),
    ).toThrow(/disk full/);
    expect(readFileSync(join(r, "d.md"), "utf8")).toBe("SOMEONE ELSE");
    expect(readFileSync(join(r, ".trash", "d.md"), "utf8")).toBe("PRECIOUS");
    expect(marked).toBe(1);
  });

  it("marks committed once after a successful replace, and reports the trash path", async () => {
    const io = await loadNotesIo(backend);
    if (!io) return;
    const r = root();
    writeFileSync(join(r, "d.md"), "OLD");
    let marked = 0;
    const out = io.replaceDestination({
      root: r,
      toRel: "d.md",
      toAbs: join(r, "d.md"),
      replacing: true,
      write: (o) => io.writeNoteAtomic(join(r, "d.md"), "NEW", true, o),
      markEffectCommitted: () => marked++,
    });
    expect(out.trashedTo).toBe(".trash/d.md");
    expect(readFileSync(join(r, "d.md"), "utf8")).toBe("NEW");
    expect(marked).toBe(1);
  });

  it.skipIf(!posix)("restoreTrashed puts back ONLY the path it trashed", async () => {
    const io = await loadNotesIo(backend);
    if (!io) return;
    const r = root();
    writeFileSync(join(r, "a.md"), "ORIGINAL");
    const t = io.trashNote(r, "a.md");
    // A different name — hostile or not — is refused: restore never mints a new name.
    expect(() => io.restoreTrashed(r, t, join(r, "x:y.md"))).toThrow();
    expect(() => io.restoreTrashed(r, t, join(r, "b.md"))).toThrow();
    expect(fs.existsSync(join(r, ".trash", "a.md"))).toBe(true);
    io.restoreTrashed(r, t, join(r, "a.md"));
    expect(readFileSync(join(r, "a.md"), "utf8")).toBe("ORIGINAL");
  });

  it.skipIf(!posix)(
    "restoreTrashed accepts the ` (n)`-suffixed trash name of the same path",
    async () => {
      const io = await loadNotesIo(backend);
      if (!io) return;
      const r = root();
      writeFileSync(join(r, "a:b.md"), "one");
      io.trashNote(r, "a:b.md");
      writeFileSync(join(r, "a:b.md"), "two");
      const t = io.trashNote(r, "a:b.md");
      expect(t).toBe(".trash/a:b (1).md");
      io.restoreTrashed(r, t, join(r, "a:b.md"));
      expect(readFileSync(join(r, "a:b.md"), "utf8")).toBe("two");
    },
  );
});
