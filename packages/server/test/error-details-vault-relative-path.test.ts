// Error details name a note by its vault-relative path, never the host absolute path: an
// authenticated caller must not learn the server's filesystem layout from a refusal.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
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

  it("falls back to the basename when no registered root holds the path", () => {
    expect(vaultDetailPath("/srv/elsewhere/notes/a.md")).toBe("a.md");
  });

  it("turns backslash separators into POSIX ones", () => {
    expect(vaultDetailPath("C:\\vault\\notes\\a.md")).toBe("a.md");
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
          const root = vaultRoot("otc-detail-link-");
          writeFileSync(join(root, "b.md"), "target\n");
          if (!trySymlink(fs, join(root, "b.md"), join(root, "a.md"), "file")) return; // host forbids file symlinks (Windows without privilege)
          const refusal = withFolderPins(new FolderPins([{ root }]), () =>
            refusalOf(() => io.readNote(join(root, "a.md"))),
          );
          expect(refusal?.code).toBe("acl_denied");
          expect(refusal?.details.path).toBe("a.md");
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
          const root = vaultRoot("otc-detail-fifo-");
          const made = spawnSync("mkfifo", [join(root, "fifo.md")], { encoding: "utf8" });
          expect(made.status, made.stderr).toBe(0);
          const refusal = withFolderPins(new FolderPins([{ root }]), () =>
            refusalOf(() => io.readNote(join(root, "fifo.md"))),
          );
          expect(refusal?.code).toBe("path_invalid");
          expect(refusal?.details.path).toBe("fifo.md");
          expect(JSON.stringify(refusal?.details)).not.toContain(root);
        },
      );
    }
  });
});

// Source-scan gate: every error-details `path` in the two sinks must be wrapped by vaultDetailPath,
// so a new refusal that echoes the host path fails review here rather than in production.
const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
const SINK_FILES = ["vault/notes-io.ts", "vault/native-io.ts"] as const;

/** Comment-stripped source, as the other source-scan gates read it. */
function stripped(relPath: string): string {
  const raw = readFileSync(join(SRC_ROOT, relPath), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every `path` key of an object literal: inline `{ path: X }` / `{ path }` or a multi-line one. */
const PATH_KEY = /\{\s*path(?:\s*:\s*([^,}\n]+?))?\s*[,}]|\{\s*\n\s*path\s*:\s*([^,\n]+?)\s*,/g;

/** The argument text of every `err.<kind>(` call in `src`, parens balanced. Error details live
 *  only inside these calls, so a destructured `{ path }` or a type literal is not a detail. */
function errCallArgs(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\berr\.\w+\(/g)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const from = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push(src.slice(from, i - 1));
  }
  return out;
}

describe("error-details path gate", () => {
  it("every path detail in notes-io.ts and native-io.ts is wrapped by vaultDetailPath", () => {
    const unwrapped: string[] = [];
    let wrapped = 0;
    let sites = 0;
    for (const file of SINK_FILES) {
      const src = stripped(file);
      expect(src.length).toBeGreaterThan(2000); // floor: the file was read, not emptied
      sites += errCallArgs(src).length;
      for (const m of errCallArgs(src).join("\n").matchAll(PATH_KEY)) {
        const value = (m[1] ?? m[2] ?? "").trim();
        const expr = value === "" ? "path" : value;
        // redactSecrets(rel): already vault-relative (restoreTrashed); everything else is wrapped.
        if (/^vaultDetailPath\(/.test(expr) || expr === "redactSecrets(rel).text") {
          wrapped++;
        } else {
          unwrapped.push(`${file}: ${m[0].replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(unwrapped).toEqual([]);
    expect(sites, "err.* calls found: the scan is vacuous below this floor").toBeGreaterThanOrEqual(
      8,
    );
    expect(
      wrapped,
      "fewer wrapped path details than the sinks are known to carry",
    ).toBeGreaterThanOrEqual(8);
  });
});
