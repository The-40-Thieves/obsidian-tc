// Codacy/Opengrep regex-dos on the ACL hot path (true positive, measured): the glob compiler's
// `**` -> `.*` backtracks catastrophically on a FAILING match — 5 `**/` segments vs a 200-char
// path takes ~1s in V8, 8 segments did not finish in 4 minutes. Every tool-call path is tested
// against every rule glob, so a config with several `**` segments plus a crafted path hangs the
// server. Matching must be linear in glob x path. The oracle for semantics stays the regex
// compiler (globToRegExp), fuzzed against the matcher on bounded inputs.
import { describe, expect, it } from "vitest";
import { FolderAcl, globMatch, globToRegExp } from "../src/acl";

const STAR_BOMB = `${"**/".repeat(6)}x`;

describe("glob matching is linear-time on adversarial inputs", () => {
  it("globMatch: many `**` segments against a non-matching path do not hang", () => {
    const start = performance.now();
    expect(globMatch(STAR_BOMB, "a/".repeat(100), false)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("FolderAcl.scopesForPath: a many-star rule glob does not hang a scope lookup", () => {
    const acl = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [{ glob: STAR_BOMB, scopes: ["read:docs"] }],
    });
    const start = performance.now();
    expect(acl.scopesForPath("a/".repeat(100))).toEqual([]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("the glob length ceiling still rejects pathological globs outright", () => {
    expect(() => globMatch("*".repeat(513), "x", false)).toThrow(/glob too long/);
  });
});

describe("linear matching keeps the regex compiler's exact semantics", () => {
  const cases: Array<[string, string, boolean, boolean]> = [
    ["notes/**", "notes/a/b.md", false, true],
    ["notes/**", "notes", false, false],
    ["*.md", "note.md", false, true],
    ["*.md", "a/note.md", false, false],
    ["a/**/c", "a/c", false, false],
    ["a/**/c", "a/b/c", false, true],
    ["**/x", "x", false, false],
    ["**/x", "a/b/x", false, true],
    ["a?c", "abc", false, true],
    ["a?c", "a/c", false, false],
    ["my\\\\raw", "my\\raw", false, true],
    ["README", "readme", true, true],
    ["**/*.MD", "a/b/c.md", true, true],
    ["**/*.MD", "a/b/c.md", false, false],
    ["Wiki/**", "wiki/a.md", true, true],
    ["Wiki/**", "wiki/a.md", false, false],
  ];
  for (const [glob, path, ci, expected] of cases) {
    it(`globMatch(${JSON.stringify(glob)}, ${JSON.stringify(path)}, ci=${ci}) === ${expected}`, () => {
      expect(globMatch(glob, path, ci)).toBe(expected);
    });
  }

  // Deterministic fuzz: the regex compiler is the oracle, on sizes where backtracking stays
  // trivial. ASCII-only alphabet: case-fold parity is asserted where the filesystems it
  // approximates fold (ASCII); exotic folds (U+017F, U+212A) are covered by the fixed cases below.
  it("fuzz: globMatch agrees with globToRegExp on bounded random globs and paths", () => {
    let state = 0x2f6e2b1;
    const rand = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const pick = (alphabet: string[], n: number) =>
      Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
    const globAlph = ["a", "B", "/", "*", "?", "\\", " ", "."];
    const pathAlph = ["a", "B", "/", " ", "."];
    for (let i = 0; i < 4000; i++) {
      const glob = pick(globAlph, 1 + Math.floor(rand() * 11));
      const path = pick(pathAlph, Math.floor(rand() * 20));
      for (const ci of [false, true]) {
        const oracle = globToRegExp(glob.normalize("NFC"), ci).test(path.normalize("NFC"));
        expect(
          globMatch(glob, path, ci),
          `glob=${JSON.stringify(glob)} path=${JSON.stringify(path)} ci=${ci}`,
        ).toBe(oracle);
      }
    }
  });

  it("case-insensitive matching still folds the characters the regex i-flag folds", () => {
    expect(globMatch("ſecret", "Secret", true)).toBe(true); // U+017F long s
    expect(globMatch("Kay", "kay", true)).toBe(true); // U+212A kelvin
    expect(globMatch("ſecret", "Secret", false)).toBe(false);
  });
});
