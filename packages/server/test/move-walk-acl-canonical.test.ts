// The walk-side predicates of the two move tools (move_note's backlink warnings, bulk_move_notes'
// caller-visible report) judged the WALKED path lexically (readableRel) instead of the note's
// canonical identity. A root walk never descends a junction, so the divergence shows when a walk
// starts AT an alias (`wiki -> private`, the alias name whitelisted, its target denied): the
// lexical predicate judged the whitelisted alias name readable where read_note denies the target.
// Both predicates now share read_note's decision (readableResolved / memoizedReadableResolved), and
// scripts/check-acl-canonical-identity.mjs follows a readability predicate passed as a callback, so
// a lexical one at either site fails check:acl-identity (the watched-failing RED for this fix).
//
// These tests pin the tool-level contract against the ticket's repro vault (`wiki -> private`,
// `wiki/**` whitelisted, `private` denied): read_note refuses the alias; both move tools refuse to
// move a note named through the alias (the read-on-source floor); and a denied bystander's links
// are rewritten (the carve-out) but never named or counted as visible in either tool's output.
// Junctions need no admin right on Windows; where even a junction cannot be made, the file skips
// (CI covers all three OSes).
import { mkdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildBulkTools } from "../src/tools/m6/bulk-tools";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { type M6Vault, makeM6Vault } from "./m6-helpers";
import { makeTempDir, rmTemp } from "./tmp";

const MARK = "TOPSECRETMARK";
const DENIED_NOTE_STEM = "secret-project";
/** The bystander the caller may not read; it links the note being moved. */
const BYSTANDER = `private/${DENIED_NOTE_STEM}.md`;
const FILES: Record<string, string> = {
  [BYSTANDER]: `${MARK}\nSee [[a]]\n`,
  "pages/a.md": "alpha\n",
  "pages/b.md": "beta links [[a]]\n",
};
// The repro's shape: the alias NAME is whitelisted, its target is not.
const ACL = { readPaths: ["pages/**", "wiki/**"], writePaths: ["**"], deletePaths: ["**"] };
const NOTE_SCOPES = new Set(["read:notes", "write:notes", "delete:notes"]);
const BULK_SCOPES = new Set(["read:notes", "write:notes", "delete:notes", "bulk:notes"]);

const JUNCTIONS = ((): boolean => {
  const dir = makeTempDir("obtc-junction-probe-");
  try {
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "link"), "junction");
    return statSync(join(dir, "link")).isDirectory();
  } catch {
    return false;
  } finally {
    rmTemp(dir);
  }
})();

/** `wiki -> private` (denied by the whitelist), made after the vault's files exist. */
// The junction stores its target verbatim, so name it the way the registry names the vault root
// (realpath.native): a temp dir spelled with an 8.3 short name would otherwise resolve outside it.
const alias = (root: string): void => {
  symlinkSync(realpathSync.native(join(root, "private")), join(root, "wiki"), "junction");
};

const errOf = (r: ToolResult): { code: string; message: string } | null =>
  r.ok ? null : (r.error as { code: string; message: string });
/** read_note's refusal for the aliased path: the exact refusal a move must produce. Naming the
 *  canonical target in it is read_note's own contract (the caller supplied the path); the move
 *  tools must not differ from it in either direction. */
const readRefusal = async (
  v: TestVault | M6Vault,
  path: string,
  grantedScopes: Set<string>,
): Promise<unknown> => {
  const r = await v.call("read_note", { vault: "test", path }, { grantedScopes });
  expect(r.ok).toBe(false);
  return errOf(r);
};
/** Nothing in the output may name the denied note, its folder, or its content. */
const expectNoLeak = (r: ToolResult): void => {
  const wire = JSON.stringify(r);
  expect(wire).not.toContain("private");
  expect(wire).not.toContain(DENIED_NOTE_STEM);
  expect(wire).not.toContain(MARK);
};

let t: TestVault | undefined;
let b: M6Vault | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
  b?.cleanup();
  b = undefined;
});

const noteVault = (): TestVault => {
  t = makeTestVault({ files: FILES, acl: ACL });
  alias(t.root);
  return t;
};
const bulkVault = (): M6Vault => {
  b = makeM6Vault({
    files: FILES,
    acl: ACL,
    conventions: true,
    register: (r, d) => {
      for (const tool of buildBulkTools(d)) r.register(tool);
    },
  });
  alias(b.root);
  return b;
};

describe.skipIf(!JUNCTIONS)("move tools judge the alias by its canonical target", () => {
  it("read_note refuses the alias: the premise both move tools must share", async () => {
    const v = noteVault();
    const r = await v.call(
      "read_note",
      { vault: "test", path: `wiki/${DENIED_NOTE_STEM}.md` },
      { grantedScopes: NOTE_SCOPES },
    );
    expect(r.ok).toBe(false);
  });

  it("move_note refuses to move a note named through the alias, exactly as read_note refuses it", async () => {
    const v = noteVault();
    const r = await v.call(
      "move_note",
      { vault: "test", from: `wiki/${DENIED_NOTE_STEM}.md`, to: "pages/stolen.md" },
      { grantedScopes: NOTE_SCOPES },
    );
    expect(errOf(r)?.code, JSON.stringify(r)).toBe("acl_denied");
    expect(errOf(r)).toEqual(await readRefusal(v, `wiki/${DENIED_NOTE_STEM}.md`, NOTE_SCOPES));
    expect(v.exists(BYSTANDER)).toBe(true);
    expect(v.exists("pages/stolen.md")).toBe(false);
  });

  it("bulk_move_notes refuses a row whose source is named through the alias, dry run and real", async () => {
    const v = bulkVault();
    const moves = [{ from: `wiki/${DENIED_NOTE_STEM}.md`, to: "pages/stolen.md" }];
    for (const dryRun of [true, false]) {
      const r = await v.callConfirmed(
        "bulk_move_notes",
        { vault: "test", moves, dry_run: dryRun },
        { grantedScopes: BULK_SCOPES },
      );
      expect(errOf(r)?.code, JSON.stringify(r)).toBe("acl_denied");
      expect(errOf(r)).toEqual(await readRefusal(v, `wiki/${DENIED_NOTE_STEM}.md`, BULK_SCOPES));
      expect(v.exists(BYSTANDER)).toBe(true);
      expect(v.exists("pages/stolen.md")).toBe(false);
    }
  });

  it("move_note rewrites a denied bystander's link (the carve-out) and names nothing denied", async () => {
    const v = noteVault();
    const r = await v.call(
      "move_note",
      { vault: "test", from: "pages/a.md", to: "pages/renamed.md" },
      { grantedScopes: NOTE_SCOPES },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expectNoLeak(r);
    // The rewrite is vault-wide regardless of the caller's read set: both the readable pages/b.md
    // and the denied bystander now link the new name.
    expect(v.read("pages/b.md")).toBe("beta links [[renamed]]\n");
    expect(v.read(BYSTANDER)).toBe(`${MARK}\nSee [[renamed]]\n`);
  });

  it("bulk_move_notes' report hides the denied bystander: hidden_backlinks, never a visible count", async () => {
    const v = bulkVault();
    const moves = [{ from: "pages/a.md", to: "pages/renamed.md" }];
    const dry = await v.callConfirmed(
      "bulk_move_notes",
      { vault: "test", moves, dry_run: true },
      { grantedScopes: BULK_SCOPES },
    );
    expect(dry.ok, JSON.stringify(dry)).toBe(true);
    const report = (dry.ok ? dry.data : {}) as {
      total_backlinks_updated: number;
      hidden_backlinks?: boolean;
    };
    // Only the readable pages/b.md is counted; the bystander's link is a flag, not a number.
    expect(report.total_backlinks_updated).toBe(1);
    expect(report.hidden_backlinks).toBe(true);
    expectNoLeak(dry);
    const real = await v.callConfirmed(
      "bulk_move_notes",
      { vault: "test", moves, dry_run: false },
      { grantedScopes: BULK_SCOPES },
    );
    expect(real.ok, JSON.stringify(real)).toBe(true);
    expectNoLeak(real);
    expect(v.read(BYSTANDER)).toBe(`${MARK}\nSee [[renamed]]\n`);
  });
});
