import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { globMatch, globToRegExp } from "../src/acl";
import { normalizeVaultPath } from "../src/vault/paths";

// Deterministic PRNG so generated cases are reproducible across runs.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Segment alphabet: letters, digits, a space (for the over-match invariant), dash, underscore.
// No "/", "\\", "*", "?", or "." — so a generated segment never forms "..", a wildcard, or a
// separator, and never collides with a Windows reserved name (the alphabet has no o/n/u/x/l/m/p/t).
const SAFE = "abcDEF012 -_";

function seg(r: () => number): string {
  const n = 1 + Math.floor(r() * 5);
  let out = "";
  for (let i = 0; i < n; i++) out += SAFE[Math.floor(r() * SAFE.length)];
  return out.trim() || "x";
}

function genPath(r: () => number): string {
  const depth = 1 + Math.floor(r() * 4);
  const segs: string[] = [];
  for (let i = 0; i < depth; i++) segs.push(seg(r));
  return segs.join("/");
}

describe("glob engine — properties", () => {
  it("compiles to an anchored regex", () => {
    for (const g of ["a", "a/*", "**", "a.b", "x?y", "docs/my notes/**"]) {
      const re = globToRegExp(g);
      expect(re.source.startsWith("^")).toBe(true);
      expect(re.source.endsWith("$")).toBe(true);
    }
  });

  it("a wildcard-free path matches only itself", () => {
    const r = rng(1);
    for (let i = 0; i < 500; i++) {
      const p = genPath(r);
      expect(globMatch(p, p)).toBe(true);
      expect(globMatch(p, `${p}x`)).toBe(false);
    }
  });

  it("`*` stays within a segment; `**` crosses segments", () => {
    const r = rng(2);
    for (let i = 0; i < 500; i++) {
      const dir = genPath(r);
      const a = seg(r);
      const b = seg(r);
      expect(globMatch(`${dir}/*`, `${dir}/${a}`)).toBe(true);
      expect(globMatch(`${dir}/*`, `${dir}/${a}/${b}`)).toBe(false);
      expect(globMatch(`${dir}/**`, `${dir}/${a}`)).toBe(true);
      expect(globMatch(`${dir}/**`, `${dir}/${a}/${b}`)).toBe(true);
    }
  });

  it("regex metacharacters in a glob are matched literally", () => {
    expect(globMatch("a.b", "a.b")).toBe(true);
    expect(globMatch("a.b", "aXb")).toBe(false);
    for (const g of ["a+b", "a(b)", "a[b]", "a{b}", "a^b", "a$b", "a|b"]) {
      expect(globMatch(g, g)).toBe(true);
    }
  });

  it("`?` matches exactly one non-separator character", () => {
    expect(globMatch("a?", "ab")).toBe(true);
    expect(globMatch("a?", "abc")).toBe(false);
    expect(globMatch("a?", "a")).toBe(false);
    expect(globMatch("a?b", "a/b")).toBe(false);
  });

  it("a space is literal and does not over-match across `/` (NUL-sentinel invariant)", () => {
    expect(globMatch("a b", "a b")).toBe(true);
    expect(globMatch("a b", "a/b")).toBe(false);
    expect(globMatch("docs/my notes/*", "docs/my notes/x")).toBe(true);
    expect(globMatch("docs/my notes/*", "docs/my notes/x/y")).toBe(false);
  });
});

describe("normalizeVaultPath — properties", () => {
  it("a safe relative path normalizes to forward-slash form, idempotently", () => {
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const n = normalizeVaultPath(genPath(r));
      expect(n).not.toMatch(/\\/);
      expect(n.startsWith("/")).toBe(false);
      const segs = n.split("/");
      expect(segs.some((s) => s === ".." || s === "" || s === ".")).toBe(false);
      expect(normalizeVaultPath(n)).toBe(n);
    }
  });

  it("collapses ./empty segments and normalizes backslashes", () => {
    expect(normalizeVaultPath("a/./b//c")).toBe("a/b/c");
    expect(normalizeVaultPath("a\\b\\c")).toBe("a/b/c");
    expect(normalizeVaultPath("")).toBe("");
    expect(normalizeVaultPath("./")).toBe("");
  });

  it("rejects traversal, absolute, drive, and Windows-reserved paths with path_invalid", () => {
    for (const bad of [
      "../x",
      "a/../b",
      "..",
      "/abs",
      "\\abs",
      "C:/x",
      "c:\\x",
      "CON",
      "a/NUL.txt",
      "com1",
    ]) {
      expect(() => normalizeVaultPath(bad)).toThrow();
    }
    let threw = false;
    try {
      normalizeVaultPath("../x");
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(ObsidianTcError);
      expect((e as ObsidianTcError).code).toBe("path_invalid");
    }
    expect(threw).toBe(true);
  });

  it("a `..` segment inserted into any generated path is rejected", () => {
    const r = rng(9);
    for (let i = 0; i < 300; i++) {
      const segs = genPath(r).split("/");
      segs.splice(Math.floor(r() * (segs.length + 1)), 0, "..");
      expect(() => normalizeVaultPath(segs.join("/"))).toThrow();
    }
  });
});
