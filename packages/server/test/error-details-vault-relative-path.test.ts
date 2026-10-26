// Error details name a note by its vault-relative path, never the host absolute path: an
// authenticated caller must not learn the server's filesystem layout from a refusal.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FolderPins, vaultDetailPath, withFolderPins } from "../src/vault/folder-links";
import { makeTempDir, rmTemp } from "./tmp";
import { type Backend, loadNotesIo, trySymlink } from "./write-io-backends";

const nativeLoadable = (await loadNotesIo("native")) !== null;
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmTemp(dir);
});

function vaultRoot(prefix: string): string {
  const root = realpathSync(makeTempDir(prefix));
  temps.push(root);
  return root;
}

/** The refusal's code and details when `read` throws, else null. */
function refusalOf(read: () => unknown): { code: string; details: Record<string, unknown> } | null {
  try {
    read();
    return null;
  } catch (error) {
    const { code, details } = error as { code?: string; details?: Record<string, unknown> };
    return { code: String(code), details: details ?? {} };
  }
}

describe("vaultDetailPath", () => {
  it("is vault-relative with POSIX separators when a registered root holds the path", () => {
    const root = vaultRoot("otc-detail-rel-");
    withFolderPins(new FolderPins([{ root }]), () => {
      expect(vaultDetailPath(join(root, "notes", "a.md"))).toBe("notes/a.md");
    });
  });

  it("keeps a nested path vault-relative", () => {
    const root = vaultRoot("otc-detail-nested-");
    withFolderPins(new FolderPins([{ root }]), () => {
      expect(vaultDetailPath(join(root, "a", "b", "c.md"))).toBe("a/b/c.md");
    });
  });

  it("falls back to the basename when no registered root holds the path", () => {
    expect(vaultDetailPath("/srv/elsewhere/notes/a.md")).toBe("a.md");
  });

  it("turns backslash separators into POSIX ones", () => {
    expect(vaultDetailPath("C:\\vault\\notes\\a.md")).toBe("a.md");
  });

  it("keeps an in-vault folder named ..hidden vault-relative", () => {
    const root = vaultRoot("otc-detail-dotdot-");
    withFolderPins(new FolderPins([{ root }]), () => {
      expect(vaultDetailPath(join(root, "..hidden", "x.md"))).toBe("..hidden/x.md");
    });
  });

  it("falls back to the basename for a traversal that leaves the vault", () => {
    expect(vaultDetailPath("/root/../etc/passwd")).toBe("passwd");
  });

  it("names the vault root by its basename, never as an absolute path", () => {
    const root = vaultRoot("otc-detail-rootself-");
    withFolderPins(new FolderPins([{ root }]), () => {
      expect(vaultDetailPath(root)).not.toMatch(/^[\\/]/);
      expect(vaultDetailPath(root)).not.toContain(root);
    });
  });
});

describe("read refusals name the note vault-relatively", () => {
  for (const backend of ["js", "native"] as const satisfies readonly Backend[]) {
    describe(`${backend} backend`, () => {
      it.skipIf(backend === "native" && !nativeLoadable)(
        "a symlink leaf: acl_denied details.path is the relative path, never the host path",
        async () => {
          const io = await loadNotesIo(backend);
          if (!io) throw new Error("native addon availability changed after test collection");
          // loadNotesIo resets the module graph: pins must come from the same folder-links instance.
          const links = await import("../src/vault/folder-links");
          const root = vaultRoot("otc-detail-link-");
          fs.mkdirSync(join(root, "notes"));
          writeFileSync(join(root, "notes", "b.md"), "target\n");
          if (!trySymlink(fs, join(root, "notes", "b.md"), join(root, "notes", "a.md"), "file"))
            return; // host forbids file symlinks (Windows without privilege)
          const refusal = links.withFolderPins(new links.FolderPins([{ root }]), () =>
            refusalOf(() => io.readNote(join(root, "notes", "a.md"))),
          );
          expect(refusal?.code).toBe("acl_denied");
          expect(refusal?.details.path).toBe("notes/a.md");
          expect(JSON.stringify(refusal?.details)).not.toContain(root);
        },
      );
    });
  }

  describe.skipIf(process.platform === "win32")("FIFO leaf", () => {
    for (const backend of ["js", "native"] as const satisfies readonly Backend[]) {
      it.skipIf(backend === "native" && !nativeLoadable)(
        `${backend}: path_invalid details.path is the relative path`,
        async () => {
          const io = await loadNotesIo(backend);
          if (!io) throw new Error("native addon availability changed after test collection");
          // loadNotesIo resets the module graph: pins must come from the same folder-links instance.
          const links = await import("../src/vault/folder-links");
          const root = vaultRoot("otc-detail-fifo-");
          fs.mkdirSync(join(root, "notes"));
          const made = spawnSync("mkfifo", [join(root, "notes", "fifo.md")], { encoding: "utf8" });
          expect(made.status, made.stderr).toBe(0);
          const refusal = links.withFolderPins(new links.FolderPins([{ root }]), () =>
            refusalOf(() => io.readNote(join(root, "notes", "fifo.md"))),
          );
          expect(refusal?.code).toBe("path_invalid");
          expect(refusal?.details.path).toBe("notes/fifo.md");
          expect(JSON.stringify(refusal?.details)).not.toContain(root);
        },
      );
    }
  });
});

// Source-scan gate: every error-detail `path` under src/vault must be wrapped by vaultDetailPath, so a
// refusal that echoes a host path fails here rather than in production. A detail is an object literal
// passed to `err.<kind>(` or `new ObsidianTcError(`, or a literal bound to a name such a call passes
// (`const details = {...}; err.x(msg, details)`). Object literals elsewhere (types, returns, ACL
// records) are not details. Not covered: `{ target: abs }`, and paths embedded in message strings.
const VAULT_DIR = fileURLToPath(new URL("../src/vault/", import.meta.url));
const SCANNED_FLOOR = 30;
const WRAPPED_FLOOR = 14;
const WRAPPED = /^vaultDetailPath\(|^redactSecrets\(rel\)\.text$/;
/** Flagged details that are vault-relative by construction (a caller's own note path, normalised or
 *  redacted; never a host path). Keyed by file; each entry is the flagged text. */
const RELATIVE_BY_CONSTRUCTION: Record<string, readonly string[]> = {
  "acl-path.ts": ["path: redactedPath"],
  "cas.ts": ["path: rel", "path: check.rel"],
  "frontmatter.ts": ["path"],
  "paths.ts": [
    "path: redactSecrets(relPath).text",
    "path: redactSecrets(shown).text",
    "path: redactedRelPath",
  ],
  "write-mode-errors.ts": ["path"],
};

/** `src` with comments and string/template bodies blanked; offsets still match the source. */
function codeOnly(src: string): string {
  return src.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g,
    (c) => (c.startsWith("/") ? c.replace(/[^\n]/g, " ") : c[0] + " ".repeat(c.length - 2) + c[0]),
  );
}

/** The index of the bracket closing the one at `open`, or -1. */
function closeOf(s: string, open: number): number {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    if ("({[".includes(s[k] ?? "")) depth++;
    else if (")}]".includes(s[k] ?? "") && --depth === 0) return k;
  }
  return -1;
}

/** The comma-separated entries at the top level of an object literal body. */
function entries(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of body) {
    if ("({[".includes(c)) depth++;
    if (")}]".includes(c)) depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((e) => e.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** The path details of one source file: `wrapped` vaultDetailPath-style values, `flagged` raw ones. */
function pathDetails(src: string): { wrapped: number; flagged: string[] } {
  const s = codeOnly(src);
  const calls: Array<[number, number]> = [];
  for (const m of s.matchAll(/\berr\.\w+\(|\bnew ObsidianTcError\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    calls.push([open, closeOf(s, open)]);
  }
  const names = new Set(calls.flatMap(([a, b]) => s.slice(a, b).match(/\b[A-Za-z_]\w*\b/g) ?? []));
  const out = { wrapped: 0, flagged: [] as string[] };
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    const close = closeOf(s, i);
    if (close < 0) continue;
    const inCall = calls.some(([a, b]) => i > a && close < b);
    const bound = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=\s*$/.exec(
      s.slice(Math.max(0, i - 160), i),
    );
    if (!inCall && !(bound && names.has(bound[1] ?? ""))) continue;
    for (const e of entries(s.slice(i + 1, close))) {
      if (e !== "path" && !/^path\s*:/.test(e)) continue;
      const value = e === "path" ? "path" : e.slice(e.indexOf(":") + 1).trim();
      if (WRAPPED.test(value)) out.wrapped++;
      else out.flagged.push(e);
    }
  }
  return out;
}

describe("error-details path gate", () => {
  it.each([
    [
      "the verbatim multi-key literal",
      'throw err.aclDenied("refused", { op: "delete", path: abs });',
    ],
    [
      "a details variable passed to the call",
      'const details = { path: abs };\nthrow err.aclDenied("refused", details);',
    ],
    ["new ObsidianTcError", 'throw new ObsidianTcError("acl_denied", "refused", { path: abs });'],
    ["a shorthand path", 'throw err.aclDenied("refused", { path });'],
    ["a plain literal", 'throw err.aclDenied("refused", { path: abs });'],
    ["a multi-line literal", 'throw err.aclDenied("refused", {\n  op,\n  path: abs,\n});'],
  ])("flags %s", (_name, mutant) => {
    expect(pathDetails(mutant).flagged.length).toBeGreaterThan(0);
  });

  it("passes a wrapped detail and an object literal outside an error call", () => {
    const ok = pathDetails(
      'const meta = { path: abs };\nthrow err.aclDenied("refused", { path: vaultDetailPath(abs) });',
    );
    expect(ok).toEqual({ wrapped: 1, flagged: [] });
  });

  it("every path detail under src/vault is wrapped by vaultDetailPath", () => {
    const files = readdirSync(VAULT_DIR, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts"));
    expect(files.length, "the scan is vacuous below this floor").toBeGreaterThanOrEqual(
      SCANNED_FLOOR,
    );
    const flagged: string[] = [];
    let wrapped = 0;
    for (const f of files) {
      const r = pathDetails(readFileSync(join(VAULT_DIR, f), "utf8"));
      const allowed = RELATIVE_BY_CONSTRUCTION[f] ?? [];
      flagged.push(...r.flagged.filter((e) => !allowed.includes(e)).map((e) => `${f}: ${e}`));
      wrapped += r.wrapped;
    }
    expect(flagged).toEqual([]);
    expect(
      wrapped,
      "fewer wrapped path details than the sinks are known to carry",
    ).toBeGreaterThanOrEqual(WRAPPED_FLOOR);
  });
});
