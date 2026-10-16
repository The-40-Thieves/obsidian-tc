import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveVaultPath } from "../src/vault/paths";
import { makeTempDir, rmTemp } from "./tmp";
import { type Backend, loadNotesIo, trySymlink } from "./write-io-backends";

type ReadCase = {
  name: string;
  rel: string;
  code: "ok" | "ENOENT" | "path_invalid" | "acl_denied";
};

type NotesIo = NonNullable<Awaited<ReturnType<typeof loadNotesIo>>>;

const temps: string[] = [];
const nativeLoadable = (await loadNotesIo("native")) !== null;

afterEach(() => {
  for (const dir of temps.splice(0)) rmTemp(dir);
});

function errorCode(run: () => unknown): string {
  try {
    run();
    return "ok";
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
}

const readCode = (io: NotesIo, root: string, rel: string): string =>
  errorCode(() => io.readNote(resolveVaultPath(root, rel)));

function makeFixture(): { root: string; cases: ReadCase[] } {
  const root = makeTempDir("otc-read-parity-");
  temps.push(root);
  fs.writeFileSync(join(root, "regular.md"), "ordinary note\n");
  fs.mkdirSync(join(root, "directory.md"));
  fs.writeFileSync(join(root, "target.md"), "linked note\n");
  fs.mkdirSync(join(root, "target-dir"));
  fs.writeFileSync(join(root, "target-dir", "nested.md"), "nested note\n");
  if (!trySymlink(fs, join(root, "target.md"), join(root, "link.md"), "file"))
    throw new Error("this parity table requires permission to create file symlinks");
  if (!trySymlink(fs, join(root, "target-dir"), join(root, "linked-dir")))
    throw new Error("this parity table requires permission to create directory symlinks");

  // Every backend is asserted against this one table, so equal expectations are the parity claim.
  const cases: ReadCase[] = [
    { name: "regular file", rel: "regular.md", code: "ok" },
    { name: "missing file", rel: "missing.md", code: "ENOENT" },
    { name: "directory leaf", rel: "directory.md", code: "path_invalid" },
    { name: "symlink leaf", rel: "link.md", code: "acl_denied" },
    { name: "symlinked intermediate directory", rel: "linked-dir/nested.md", code: "acl_denied" },
    { name: "parent traversal", rel: "../outside.md", code: "path_invalid" },
  ];
  return { root, cases };
}

function makeFifo(): { root: string; rel: string } {
  const root = makeTempDir("otc-read-fifo-");
  temps.push(root);
  const made = spawnSync("mkfifo", [join(root, "fifo.md")], { encoding: "utf8" });
  expect(made.status, made.stderr).toBe(0);
  return { root, rel: "fifo.md" };
}

describe("vault read backend parity", () => {
  for (const backend of ["js", "native"] as const satisfies readonly Backend[]) {
    const nativeUnavailable = backend === "native" && !nativeLoadable;
    it.skipIf(nativeUnavailable)(
      nativeUnavailable
        ? "native addon is not loadable; skips only the native parity leg"
        : `matches the shared read table on ${backend}`,
      async () => {
        const io = await loadNotesIo(backend);
        if (!io) throw new Error("native addon availability changed after test collection");
        const { root, cases } = makeFixture();
        for (const readCase of cases) {
          expect(readCode(io, root, readCase.rel), `${backend}: ${readCase.name}`).toBe(
            readCase.code,
          );
        }
      },
    );
  }

  describe.skipIf(process.platform === "win32")("FIFO leaf", () => {
    it("reports path_invalid on the JS fallback without any writer", async () => {
      const io = await loadNotesIo("js");
      if (!io) throw new Error("JS backend must always load");
      const { root, rel } = makeFifo();
      expect(readCode(io, root, rel)).toBe("path_invalid");
    });

    // A blocking open would hang the synchronous native call (and the worker) forever, so a rescue
    // writer opens the FIFO after RESCUE_MS. A non-blocking open returns long before that; a
    // regression shows up as the elapsed time, not as a hung run.
    it.skipIf(!nativeLoadable)(
      "reports path_invalid on native without blocking on a FIFO that has no writer",
      async () => {
        const io = await loadNotesIo("native");
        if (!io) throw new Error("native addon availability changed after test collection");
        const { root, rel } = makeFifo();
        const RESCUE_MS = 5000;
        const rescue = spawn(
          process.execPath,
          [
            "-e",
            `setTimeout(() => { const fs = require('node:fs'); fs.closeSync(fs.openSync(process.argv[1], 'w')) }, ${RESCUE_MS})`,
            join(root, rel),
          ],
          { stdio: "ignore" },
        );
        try {
          const started = performance.now();
          const code = readCode(io, root, rel);
          const elapsed = performance.now() - started;
          expect(elapsed, "native FIFO open blocked until the rescue writer arrived").toBeLessThan(
            RESCUE_MS / 2,
          );
          expect(code).toBe("path_invalid");
        } finally {
          rescue.kill();
        }
      },
      15_000,
    );
  });
});
