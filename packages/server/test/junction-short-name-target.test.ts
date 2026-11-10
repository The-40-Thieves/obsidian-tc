// A Windows junction stores its target as written. When that target is spelled with an 8.3 short
// name (`RUNNER~1`, `PROGRA~3`), the JS realpath hands the short spelling back, while the vault
// root is registered through realpath.native, which expands it. Comparing the two made a junction
// that stays INSIDE the vault look as if it left it: `path_invalid` ("escapes the vault root")
// instead of the path's real identity, so an ACL-denied target was not reported as `acl_denied`
// and an allowed one could not be reached at all. The containment check and the folder pins now
// resolve the same way the root does.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderPins } from "../src/vault/folder-links";
import { resolveVaultPathChecked } from "../src/vault/paths";
import { canonicalizeVaultRoot } from "../src/vault/registry";
import { rmTemp } from "./tmp";

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The 8.3 spelling of `path`, or `path` itself where it has none. */
function shortSpelling(path: string): string {
  const comspec = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
  const args = ["/d", "/c", "for", "%I", "in", `("${path}")`, "do", "@echo", "%~sI"];
  const r = spawnSync(comspec, args, { encoding: "utf8", windowsVerbatimArguments: true });
  const out = (r.stdout ?? "").trim();
  return out === "" ? path : out;
}

/**
 * A writable directory that has a short spelling: the temp dir where the volume keeps 8.3 names
 * (GitHub's Windows runners: `RUNNER~1`), else ProgramData, whose short name dates from install
 * and exists even where generating new ones is turned off.
 */
function shortNamedBase(): { long: string; short: string } | null {
  for (const candidate of [tmpdir(), process.env.ProgramData]) {
    if (candidate === undefined) continue;
    try {
      const long = realpathSync.native(candidate);
      const short = shortSpelling(long);
      if (!same(long, short) && same(realpathSync.native(short), long)) return { long, short };
    } catch {
      // Not there or not readable: try the next one.
    }
  }
  return null;
}

const BASE = process.platform === "win32" ? shortNamedBase() : null;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

/** A vault with `private-notes/` and a junction `wiki` whose target is spelled the short way. */
function vaultWithShortNameJunction(base: { long: string; short: string }): string {
  const made = mkdtempSync(join(base.long, "obtc-short-name-junction-"));
  dirs.push(made);
  const root = canonicalizeVaultRoot(made);
  mkdirSync(join(root, "private-notes"));
  writeFileSync(join(root, "private-notes", "note.md"), "x\n");
  symlinkSync(join(base.short, basename(root), "private-notes"), join(root, "wiki"), "junction");
  return root;
}

describe.runIf(process.platform === "win32")("a junction whose target is a short name", () => {
  it("finds a short-named directory to build on (a CI host must not skip these cases)", () => {
    if (process.env.CI) expect(BASE).not.toBeNull();
  });

  it.skipIf(BASE === null)("resolves to the target's identity inside the vault", () => {
    const root = vaultWithShortNameJunction(BASE as { long: string; short: string });
    expect(resolveVaultPathChecked(root, "wiki/note.md").aclRel).toBe("private-notes/note.md");
  });

  it.skipIf(BASE === null)("does the same for a note not yet created under the junction", () => {
    const root = vaultWithShortNameJunction(BASE as { long: string; short: string });
    expect(resolveVaultPathChecked(root, "wiki/new/later.md").aclRel).toBe(
      "private-notes/new/later.md",
    );
  });
});

describe.runIf(process.platform === "win32")("configured-folder pins", () => {
  it.skipIf(BASE === null)("pins a junction folder at its long-named directory", () => {
    const root = vaultWithShortNameJunction(BASE as { long: string; short: string });
    const pins = new FolderPins([{ root, wikiFolder: "wiki" }]);
    expect(pins.forSink(join(root, "wiki", "note.md"))?.path).toBe(
      join(root, "private-notes", "note.md"),
    );
  });

  it("does not take a plain folder configured in another letter case for a link", () => {
    const made = mkdtempSync(join(realpathSync.native(tmpdir()), "obtc-case-pin-"));
    dirs.push(made);
    const root = canonicalizeVaultRoot(made);
    mkdirSync(join(root, "wiki"));
    const pins = new FolderPins([{ root, wikiFolder: "Wiki" }]);
    expect(pins.forSink(join(root, "Wiki", "note.md"))).toBeUndefined();
    expect(pins.forAcl(join(root, "Wiki", "note.md"))).toEqual({ kind: "none" });
  });
});
