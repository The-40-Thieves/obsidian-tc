// GH #1433 rec 4, step 2: the embedder child's side of the protocol. The child's stdout is the
// protocol channel, so anything the model stack logs must go to stderr; the child must exit on stdin
// EOF; and its import closure must stay inside embeddings/ and providers/, so a child never loads the
// vault, database, transports or native addon.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runEmbedderChild } from "../src/embeddings/host/child-main";
import { encodeMessage, parseMessage } from "../src/embeddings/host/protocol";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const INIT = { model: "m", quantized: true, modelsRoot: "/models", cacheDir: "/cache" };

describe("embedder child", () => {
  it("writes only protocol lines to stdout even when the model stack logs with console.log", async () => {
    const input = new PassThrough();
    const chunks: string[] = [];
    const output = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const load = async () => ({
      embed: async (texts: string[]) => {
        console.log("junk from the model loader");
        return texts.map((text) => [text.length]);
      },
    });
    const done = runEmbedderChild({ input, output }, load);
    input.write(encodeMessage({ t: "init", v: 1, opts: INIT }));
    input.write(encodeMessage({ t: "embed", v: 1, id: 1, texts: ["abc"] }));
    input.end();
    await done;
    const lines = chunks.join("").split("\n").filter(Boolean);
    expect(lines.map((line) => parseMessage(line).t)).toEqual(["ready", "result"]);
    expect(errorSpy).toHaveBeenCalledWith("junk from the model loader");
    errorSpy.mockRestore();
  });

  it("returns once stdin reaches EOF (the parent is gone)", async () => {
    const input = new PassThrough();
    const output = { write: () => true };
    const done = runEmbedderChild({ input, output }, async () => ({ embed: async () => [] }));
    input.end();
    await expect(done).resolves.toBeUndefined();
  });

  it("a child process started on the fixture exits 0 when its stdin closes", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/fake-embedder-child.mjs", import.meta.url));
    const child = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "inherit"] });
    const code = new Promise<number | null>((resolveExit) => child.on("exit", resolveExit));
    child.stdin.end();
    expect(await code).toBe(0);
  });

  it("imports only embeddings/ and providers/ (no vault, db, transports, cli or native addon)", () => {
    const seen = new Set<string>();
    const escapes: string[] = [];
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const rel = relative(SRC, file).split(sep).join("/");
      if (!/^(embeddings|providers)\//.test(rel)) escapes.push(rel);
      const source = readFileSync(file, "utf8");
      // Runtime imports only: `import type` is erased and cannot load anything.
      const specifiers = [
        ...source.matchAll(/^import\s+(?!type\s)[\s\S]*?from\s+"(\.{1,2}\/[^"]+)";/gm),
      ].map((m) => m[1]);
      for (const specifier of specifiers) {
        const base = resolve(dirname(file), specifier);
        const target = [`${base}.ts`, join(base, "index.ts")].find((c) => existsSync(c));
        if (target) visit(target);
      }
    };
    visit(join(SRC, "embeddings/host/child-main.ts"));
    expect(escapes).toEqual([]);
    expect(seen.size).toBeGreaterThan(3);
  });
});
