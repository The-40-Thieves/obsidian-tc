// THE-1081 review round (Medium 1) — source-scan floor.
//
// A raw config vault path (`v.path` / `config.vaults`) reached: the watcher's flush path (via
// `wireIndexCoordinator`'s `vaults`), `run_index`'s indexed root, `forget`'s existsSync/vaultRoot
// checks, `rerun`'s `configuredVaultPath`, and `context-export`'s inside-vault guard — while
// `VaultRegistry.list()` already reported the CANONICAL root (vault/registry.ts) each of them
// could have used instead. None of this has a runtime symptom on any CI leg: no leg exercises a
// symlinked TMPDIR, so a regression here — someone deleting a `canonicalizeVaultRoot()` call while
// refactoring one of these five files — would pass every other gate and only show up on a stock
// Mac with the native addon built, exactly like #946 itself did. A source scan is the only gate
// that catches that at review time instead.
//
// Comments stripped before scanning (vault-watcher.test.ts's own note applies here too: a comment
// that quotes the OLD raw form, e.g. explaining what the bug used to be, would otherwise satisfy a
// naive positive match).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function stripped(relPath: string): string {
  const raw = readFileSync(new URL(`../src/${relPath}`, import.meta.url), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

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
});
