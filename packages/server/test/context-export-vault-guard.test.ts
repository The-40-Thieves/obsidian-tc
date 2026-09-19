// THE-1081 review round (Medium 1) — `context-export`'s inside-vault guard used to compare a
// resolved `--out` path against only the RAW configured vault path. A vault root reached through a
// symlinked ancestor (e.g. macOS $TMPDIR under /var -> /private/var) is what `list_vaults`/the
// runtime's VaultRegistry now report as the CANONICAL root (vault/registry.ts) — an operator who
// copies that reported path into `--out` would have passed the lexical-containment check even
// though the destination is really inside the vault, letting the exfiltration bundle land
// somewhere the indexer/Obsidian Sync would reach it. `isInsideConfiguredVaultRoot`
// (cli/commands/context-export.ts) now checks both spellings of the root.
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isInsideConfiguredVaultRoot } from "../src/cli/commands/context-export";
import { rmTemp } from "./tmp";

describe("isInsideConfiguredVaultRoot — THE-1081 review round", () => {
  it("still refuses a destination inside the raw (lexical) configured root", () => {
    const root = mkdtempSync(join(tmpdir(), "otc-ctxexport-"));
    try {
      expect(isInsideConfiguredVaultRoot(join(root, "bundle.json"), root)).toBe(true);
      expect(isInsideConfiguredVaultRoot(join(tmpdir(), "elsewhere.json"), root)).toBe(false);
    } finally {
      rmTemp(root);
    }
  });

  it("refuses a destination spelled via the CANONICAL root, when the config path is a symlinked ancestor", () => {
    const base = mkdtempSync(join(tmpdir(), "otc-ctxexport-sym-"));
    try {
      const realRoot = join(base, "real-root");
      const linkRoot = join(base, "link-root");
      mkdirSync(realRoot);
      symlinkSync(realRoot, linkRoot);
      // The configured vault path is the SYMLINKED spelling; the operator's --out is spelled via
      // the canonical (realpath'd) root, exactly as list_vaults/VaultRegistry would report it.
      // Before this fix, isInsideVaultRoot(outPath, linkRoot) alone would NOT catch this: the two
      // spellings share no lexical prefix, so `path.relative` returns something starting with
      // ".." and the guard read "not inside" when it really is.
      const outPath = join(realRoot, "bundle.json");
      expect(isInsideConfiguredVaultRoot(outPath, linkRoot)).toBe(true);
    } finally {
      rmTemp(base);
    }
  });

  it("refuses a destination spelled via the lexical (symlinked-ancestor) root too", () => {
    const base = mkdtempSync(join(tmpdir(), "otc-ctxexport-sym2-"));
    try {
      const realRoot = join(base, "real-root");
      const linkRoot = join(base, "link-root");
      mkdirSync(realRoot);
      symlinkSync(realRoot, linkRoot);
      const outPath = join(linkRoot, "bundle.json");
      expect(isInsideConfiguredVaultRoot(outPath, linkRoot)).toBe(true);
    } finally {
      rmTemp(base);
    }
  });

  it("still allows a destination genuinely outside the vault, symlinked ancestor or not", () => {
    const base = mkdtempSync(join(tmpdir(), "otc-ctxexport-sym3-"));
    try {
      const realRoot = join(base, "real-root");
      const linkRoot = join(base, "link-root");
      mkdirSync(realRoot);
      symlinkSync(realRoot, linkRoot);
      const outPath = join(base, "outside-bundle.json");
      expect(isInsideConfiguredVaultRoot(outPath, linkRoot)).toBe(false);
    } finally {
      rmTemp(base);
    }
  });
});
