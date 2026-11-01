// GH #1433 rec 4, step 2: the embedder child's side of the protocol. The child's stdout is the
// protocol channel, so anything the model stack logs must go to stderr; the child must exit on stdin
// EOF; and its import closure must stay inside embeddings/ and providers/, so a child never loads the
// vault, database, transports or native addon.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runEmbedderChild } from "../src/embeddings/host/child-main";
import { encodeMessage, parseMessage } from "../src/embeddings/host/protocol";
import { stallTimeout } from "./stall-timeouts";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const CONSOLE_CHILD = fileURLToPath(new URL("./fixtures/console-child.ts", import.meta.url));
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
      ].map((m) => m[1] as string);
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

  // Fix round (MEDIUM 4b): the child refuses to be a child of itself. The parent sets the flag for the
  // child; the child clears it before it serves, so nothing it runs can spawn another child.
  it("the child deletes OBSIDIAN_TC_EMBEDDER_HOST from its own env before serving", async () => {
    const before = process.env.OBSIDIAN_TC_EMBEDDER_HOST;
    process.env.OBSIDIAN_TC_EMBEDDER_HOST = "1";
    try {
      const input = new PassThrough();
      const output = { write: () => true };
      let seenByLoader: string | undefined = "not loaded";
      const done = runEmbedderChild({ input, output }, async () => {
        seenByLoader = process.env.OBSIDIAN_TC_EMBEDDER_HOST;
        return { embed: async () => [] };
      });
      input.write(encodeMessage({ t: "init", v: 1, opts: INIT }));
      input.end();
      await done;
      expect(seenByLoader).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.OBSIDIAN_TC_EMBEDDER_HOST;
      else process.env.OBSIDIAN_TC_EMBEDDER_HOST = before;
    }
  });

  // Fix round (LOW 5): console.dir and console.table write to stdout under node and bun. Each line
  // there would break the protocol, so the child routes every stdout console method to stderr. Run
  // under bun (the compiled server's runtime) because vitest intercepts console and hides the write.
  it("console.dir and console.table in the child keep stdout to protocol lines (under bun)", () => {
    const run = spawnSync("bun", [CONSOLE_CHILD], {
      input:
        encodeMessage({ t: "init", v: 1, opts: INIT }) +
        encodeMessage({ t: "embed", v: 1, id: 1, texts: ["abc"] }),
      encoding: "utf8",
      timeout: stallTimeout(20_000),
    });
    expect(run.error).toBeUndefined();
    const lines = run.stdout.split("\n").filter(Boolean);
    expect(lines.map((line) => parseMessage(line).t)).toEqual(["ready", "result"]);
  });

  // Fix round (MEDIUM 11): the EOF test above runs against the fixture. This one runs the real child:
  // the CLI entry with the flag set, under bun, which is the runtime the compiled server uses.
  it(
    "the real child (the cli entry with the flag, under bun) exits 0 when stdin closes",
    async () => {
      const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
      const child = spawn("bun", [cli], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, OBSIDIAN_TC_EMBEDDER_HOST: "1" },
      });
      child.stdout.resume();
      child.stderr.resume();
      const code = new Promise<number | null>((resolveExit) => child.on("exit", resolveExit));
      child.stdin.end();
      expect(await code).toBe(0);
    },
    stallTimeout(30_000),
  );
});
