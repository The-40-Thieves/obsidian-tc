// THE-1081 review round(s) — source-scan floor.
//
// A raw config vault path (`v.path` / `config.vaults`) reached: the watcher's flush path (via
// `wireIndexCoordinator`'s `vaults`), `run_index`'s indexed root, `forget`'s existsSync/vaultRoot
// checks, `rerun`'s `configuredVaultPath`, `context-export`'s inside-vault guard, and (round 2)
// `wireScheduler` -> `configureMaintenance` -> `resolveTraceDirs`'s trace-dir resolution — while
// `VaultRegistry.list()` already reported the CANONICAL root (vault/registry.ts) each of them
// could have used instead. None of this has a runtime symptom on any CI leg: no leg exercises a
// symlinked TMPDIR or a symlinked vault root, so a regression here — someone deleting a
// `canonicalizeVaultRoot()` call, or re-threading a raw `.path` into `wireScheduler`, while
// refactoring one of these files — would pass every other gate and only show up on a stock Mac
// (#946) or, for round 2's regression, on ANY host with a symlinked vault directory (iCloud/
// Dropbox/NAS), which made `serve` refuse to start at all. A source scan is the only gate that
// catches that at review time instead.
//
// Round 2's DEFENSE item, generalized: rather than widen `resolveVaultPath`/
// `resolveVaultPathChecked`/`walkVault`/`walkVaultStream`'s signatures across their ~100 call
// sites to accept a `{root, rootCanonical}` pair (paths.ts's own comment explains why the
// unconditional lstat check makes that unnecessary for correctness), this file's last test scans
// every production source file for the one caller SHAPE that has twice been the actual bug: a
// bare `.path` passed directly as the first argument to one of those four functions.
//
// Comments stripped before scanning (vault-watcher.test.ts's own note applies here too: a comment
// that quotes the OLD raw form, e.g. explaining what the bug used to be, would otherwise satisfy a
// naive positive match).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `new URL(...).pathname` is NOT a filesystem path on Windows — it keeps a leading slash before
// the drive letter (`/D:/a/...`), which `path.win32.join`/`resolve` then treats as root-relative
// to the CURRENT drive rather than as the literal drive path, doubling it
// (`D:\D:\a\obsidian-tc\...`) the moment it is joined with anything — exactly the
// `ENOENT: scandir 'D:\D:\...'` this test failed with on windows-latest. `fileURLToPath` is the
// one correct conversion on every platform.
const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));

function stripped(relPath: string): string {
  const raw = readFileSync(join(SRC_ROOT, relPath), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every `.ts` file under `packages/server/src`, relative to `src/` (forward-slashed). */
function everySourceFile(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else if (name.endsWith(".ts")) out.push(rel);
    }
  };
  walk(SRC_ROOT, "");
  return out;
}

/** First-argument-is-`.path` calls into the four root-consuming primitives, comment-stripped. */
const PLANTED_PATH_CALL =
  /\b(?:resolveVaultPathChecked|resolveVaultPath|walkVaultStream|walkVault)\(\s*[A-Za-z0-9_$]*\.path\b/;

describe("vault root canonicalization — every named consumer (THE-1081 review round)", () => {
  it("server-runtime.ts threads vaultRegistry.list()'s canonical root into wireIndexCoordinator's `vaults`, not raw config.vaults", () => {
    const src = stripped("runtime/server-runtime.ts");
    expect(src.length).toBeGreaterThan(2000); // floor — else every assertion below is vacuous
    const call = src.match(/wireIndexCoordinator\(\{[\s\S]*?\}\);/)?.[0];
    expect(call, "wireIndexCoordinator({...}) call not found").toBeDefined();
    expect(call).toContain("vaults: vaultRegistry.list()");
    expect(call).not.toMatch(/vaults:\s*config\.vaults\b/);
  });

  it("cli/commands/index.ts (run_index) canonicalizes the root it indexes", () => {
    const src = stripped("cli/commands/index.ts");
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toMatch(/root:\s*canonicalizeVaultRoot\(v\.path\)/);
  });

  it("cli/commands/forget.ts canonicalizes before existsSync/vaultRoot", () => {
    const src = stripped("cli/commands/forget.ts");
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("canonicalizeVaultRoot(vault.path)");
    // The old raw form, pinned open so a revert is caught even if it keeps the field name.
    expect(src).not.toMatch(/vaultRoot:\s*vault\.path\b/);
  });

  it("cli/commands/rerun.ts's configuredVaultPath canonicalizes before returning", () => {
    const src = stripped("cli/commands/rerun.ts");
    expect(src.length).toBeGreaterThan(1000);
    const fn = src.match(/function configuredVaultPath\([\s\S]*?\n\}/)?.[0];
    expect(fn, "configuredVaultPath() not found").toBeDefined();
    expect(fn).toContain("canonicalizeVaultRoot(v.path)");
    expect(fn).not.toMatch(/return\s+v\.path;/);
  });

  it("cli/commands/context-export.ts's inside-vault guard checks both spellings of the configured root", () => {
    const src = stripped("cli/commands/context-export.ts");
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("isInsideConfiguredVaultRoot");
    expect(src).toContain("canonicalizeVaultRoot(configuredVaultPath)");
  });

  it("server-runtime.ts threads vaultRegistry.list()'s canonical root into wireScheduler's `vaults` (round 2)", () => {
    const src = stripped("runtime/server-runtime.ts");
    expect(src.length).toBeGreaterThan(2000);
    const call = src.match(/wireScheduler\(\{[\s\S]*?\}\);/)?.[0];
    expect(call, "wireScheduler({...}) call not found").toBeDefined();
    expect(call).toContain("root: vaultRegistry.resolve(v.id).root");
    // The bare (pre-fix) form assigns config.vaults directly, with nothing between it and the
    // next field; `.map(...)` guarantees this isn't that.
    expect(call).not.toMatch(/vaults:\s*config\.vaults\s*,/);
  });

  it("workspace/sessions.ts's resolveTraceDirs takes `root`, not `path` — the field rename that makes the round-2 bug unrepresentable", () => {
    const src = stripped("workspace/sessions.ts");
    expect(src.length).toBeGreaterThan(2000);
    const fn = src.match(/export function resolveTraceDirs\([\s\S]*?\n\}/)?.[0];
    expect(fn, "resolveTraceDirs() not found").toBeDefined();
    expect(fn).toMatch(/root:\s*string/);
    expect(fn).toContain("resolveVaultPathChecked(v.root, rel)");
    expect(fn).not.toMatch(/\bpath:\s*string/);
  });

  // The DEFENSE item, generalized (see file header): no production file may pass a bare `.path`
  // as the first argument to resolveVaultPath/resolveVaultPathChecked/walkVault/walkVaultStream.
  // Every one of ~100 real call sites already uses `.root` (a ResolvedVault) or a `root`-named
  // parameter; the two exceptions this ticket found and fixed (workspace/sessions.ts's
  // resolveTraceDirs, round 2) are pinned individually above. This is the floor that catches the
  // NEXT one, wherever it lands.
  it("no production source file passes a bare `.path` into resolveVaultPath / resolveVaultPathChecked / walkVault / walkVaultStream", () => {
    const files = everySourceFile();
    expect(files.length).toBeGreaterThan(100); // floor — else this scan is scanning nothing
    const offenders: string[] = [];
    for (const relPath of files) {
      const src = stripped(relPath);
      const m = src.match(PLANTED_PATH_CALL);
      if (m) offenders.push(`${relPath}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});
