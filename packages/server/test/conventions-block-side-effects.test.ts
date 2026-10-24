// A write the block gate refuses leaves nothing behind: no snapshot row, no indeterminate idempotency
// key, no spent confirmation, no trashed destination. The early preflights run before each of those.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it, vi } from "vitest";
import { replaceDestination } from "../src/vault/notes-io";
import { contentHash } from "../src/vault/paths";
import { persistGovernedNote } from "../src/vault/persist-note";
import { type NoteWriteGate, withWriteGate } from "../src/vault/write-gate";
import { CHECKED, STATUS_RULES, snapshotTotal, withVault } from "./conventions-helpers";
import { makeM3Vault } from "./m3-helpers";
import { makeWikiHarness } from "./wiki-test-helpers";

const MEETING = "meetings/SCHEMA.md";
const rules = STATUS_RULES;
const GOOD = "---\ntype: meeting\nstatus: draft\n---\nold\n";
const SNAP = { enabled: true, retention: 10 };
const blocked = (r: { ok: boolean; error?: { code: string } }): string | undefined =>
  r.ok ? undefined : r.error?.code;

describe("a blocked write leaves no trace", () => {
  it("append_note: a blocked create leaves no indeterminate key; a corrected retry runs", async () => {
    await withVault({ ...CHECKED, files: { [MEETING]: rules("block") } }, async (v) => {
      const options = { idempotency_key: "K-append-1" };
      const first = await v.call("append_note", {
        vault: "test",
        path: "meetings/new.md",
        content: "x\n",
        create_if_missing: true,
        options,
      });
      expect(blocked(first)).toBe("convention_blocked");
      const retry = await v.call("append_note", {
        vault: "test",
        path: "meetings/new.md",
        content: GOOD,
        create_if_missing: true,
        options,
      });
      expect(retry.ok ? "ok" : retry.error.code).toBe("ok");
    });
  });

  it("update_frontmatter: a blocked replace is refused before its confirmation is asked for", async () => {
    await withVault(
      { ...CHECKED, snapshots: SNAP, files: { [MEETING]: rules("block"), "meetings/m.md": GOOD } },
      async (v) => {
        const r = await v.call("update_frontmatter", {
          vault: "test",
          path: "meetings/m.md",
          operation: "replace",
          properties: { status: "draft" },
        });
        expect(blocked(r)).toBe("convention_blocked");
        expect(await snapshotTotal(v, "meetings/m.md")).toBe(0);
      },
    );
  });

  it("commit_wiki_page: a blocked overwrite is refused before its confirmation is asked for", async () => {
    const hh = makeWikiHarness({
      files: {
        "wiki/SCHEMA.md":
          "---\nconventions:\n  frontmatter:\n    required: [type]\n    severity: { type: block }\n---\n# rules\n",
        "wiki/learning.md": "---\ntype: concept\nsummary: old\n---\nold\n",
      },
      wikiFolder: "wiki",
      centralAcl: true,
      conventions: true,
    });
    const r = await hh.v.call("commit_wiki_page", {
      vault: "test",
      topic: "Learning techniques",
      type: "concept",
      allow_duplicate: true,
      page: {
        path: "wiki/learning.md",
        mode: "overwrite",
        prev_hash: contentHash(hh.v.read("wiki/learning.md")),
        frontmatter: { summary: "How to learn" },
        body: "# Learning techniques\n",
      },
      patches: [],
    });
    expect(blocked(r)).toBe("convention_blocked");
  });

  it("create_periodic_note: a blocked create leaves no indeterminate key", async () => {
    const m3 = makeM3Vault({ conventions: true, files: { "SCHEMA.md": rules("block") } });
    const input = {
      vault: "test",
      period: "daily",
      date: "2026-10-24",
      idempotency_key: "K-periodic-1",
    };
    const first = await m3.call("create_periodic_note", input);
    expect(blocked(first)).toBe("convention_blocked");
    const retry = await m3.call("create_periodic_note", input);
    expect(blocked(retry)).toBe("convention_blocked");
  });
});

describe("the preflight in each sequence refuses before its side effects", () => {
  const refuse: NoteWriteGate = {
    check(p) {
      throw err.conventionBlocked("write blocked", { path: p, violations: [] });
    },
  };
  it("persistGovernedNote takes no snapshot and marks no claim when the gate refuses", () => {
    const { db, root } = makeM3Vault({ files: { "x.md": "old\n" } });
    const markEffectCommitted = vi.fn();
    expect(() =>
      withWriteGate(refuse, () =>
        persistGovernedNote(
          db,
          { snapshots: SNAP, markEffectCommitted },
          {
            vaultId: "test",
            root,
            rel: "x.md",
            content: "new\n",
            op: "write_note",
            createDirs: false,
          },
        ),
      ),
    ).toThrow();
    expect(markEffectCommitted).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM note_snapshots").get()).toEqual({ n: 0 });
    expect(readFileSync(join(root, "x.md"), "utf8")).toBe("old\n");
  });

  it("replaceDestination refuses before it trashes the destination or writes", () => {
    const { root } = makeM3Vault({ files: { "x.md": "old\n" } });
    const write = vi.fn();
    expect(() =>
      withWriteGate(refuse, () =>
        replaceDestination({
          root,
          toRel: "x.md",
          toAbs: join(root, "x.md"),
          replacing: true,
          write,
          checkText: "new\n",
        }),
      ),
    ).toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "x.md"), "utf8")).toBe("old\n");
  });
});
