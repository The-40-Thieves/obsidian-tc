// A client's prompt cache keys on the byte prefix tools -> system -> messages, so ONE changed byte
// in `tools/list` (or in the `instructions` the client folds into the system prompt) invalidates
// the whole cached prefix. MCP 2026-07-28 also says a server SHOULD list tools in a deterministic
// order. This pins that the two payloads are byte-identical across server restarts: it boots the
// REAL server twice per facade mode over stdio, each boot with its own cacheDir and its own vault
// (the second has extra notes and a Dataview plugin manifest), and compares sha256 of the exact
// `result` bytes the server serialized.
//
// Ordering: `ToolStore` keeps tools in a Map, so tools/list order IS registration order (cli.ts ->
// runtime/server-runtime.ts, registerM1..M8) -- there is no explicit sort key. A deterministic
// reorder of those calls is a deliberate one-time cache break; what this catches is
// NON-deterministic order (Promise.all registration, Set/object iteration, a shuffle) and any
// volatile value in a name/description/schema (a timestamp, a counter, a random id). Both were
// shown RED by patching the server locally and reverting: a shuffled `listVisible` fails the flat
// case (the only mode whose list is the registry's own order); `Date.now()` in a tool description
// (ToolStore.register) fails flat, and in the find_capability description fails triad, with the
// same stamp as a description prefix failing domain.
//
// `instructions` names the caller-visible catalog, built from the registry only: it does not vary
// with vault contents, so it is asserted equal as a whole, not just in part.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/mcp/registry";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

type FacadeMode = "triad" | "domain" | "flat";
// triad is the default surface: no `toolFacade` key at all.
const MODES: Record<FacadeMode, Record<string, unknown>> = {
  triad: {},
  domain: { toolFacade: { mode: "domain" } },
  flat: { toolFacade: { mode: "flat" } },
};
// Floors, so a server that boots empty (or fails and prints nothing) cannot compare equal to itself.
const MIN_TOOLS: Record<FacadeMode, number> = { triad: 3, domain: 10, flat: 100 };

interface Boot {
  /** Exact bytes of the `result` object of the tools/list response, as the server serialized it. */
  toolsResult: string;
  initResult: string;
  instructions: string;
  toolNames: string[];
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let root: string;
beforeAll(() => {
  root = makeTempDir("obtc-tools-list-stable-");
});
afterAll(() => rmTemp(root));

/** Complete (newline-terminated) JSON-RPC lines in `out`; a trailing partial line is ignored. */
function completeLines(out: string): string[] {
  return out
    .split("\n")
    .slice(0, -1)
    .filter((l) => l.startsWith("{"));
}

/** Runs the real server over stdio with stdin held OPEN like a client does (the server exits on
 *  EOF, which would truncate a 286 KB flat response still sitting in the pipe), and resolves with
 *  stdout once the response to request id `lastId` has arrived. */
function runServer(config: string, input: string, lastId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [CLI, "serve", "--config", config], {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let answered = false;
    // Kill timer only: a healthy run ends via stdin EOF below. Settling waits for the child's exit
    // so the temp dir is never removed under a live SQLite handle (Windows refuses that).
    const timer = setTimeout(() => child.kill(), stallTimeout(60_000));
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      out += d;
      if (completeLines(out).some((l) => (JSON.parse(l) as { id?: number }).id === lastId)) {
        answered = true;
        child.stdin.end();
      }
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      err += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (answered) resolve(out);
      else reject(new Error(`no answer for id ${lastId} (exit ${code})\n${out}\n${err}`));
    });
    child.stdin.write(input);
  });
}

async function boot(mode: FacadeMode, label: string, extraVault: boolean): Promise<Boot> {
  const dir = join(root, `${mode}-${label}`);
  const vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "a.md"), "# a\n");
  if (extraVault) {
    for (let i = 0; i < 25; i++) writeFileSync(join(vault, `extra-${i}.md`), `# extra ${i}\n`);
    const plugin = join(vault, ".obsidian", "plugins", "dataview");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(
      join(plugin, "manifest.json"),
      JSON.stringify({
        id: "dataview",
        name: "Dataview",
        version: "0.5.67",
        minAppVersion: "1.0.0",
      }),
    );
  }
  const config = join(dir, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      vaults: [{ id: "t", path: vault }],
      cacheDir: join(dir, "cache"),
      acl: {
        readOnly: false,
        strictReadDefault: false,
        readPaths: ["**"],
        writePaths: ["**"],
        deletePaths: [],
      },
      transports: { stdio: true, http: { enabled: false } },
      ...MODES[mode],
    }),
  );
  const input = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "byte-stable", version: "0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]
    .map((m) => JSON.stringify(m))
    .join("\n");
  const stdout = await runServer(config, `${input}\n`, 2);
  const lines = completeLines(stdout);
  const raw = (id: number) => {
    const line = lines.find((l) => (JSON.parse(l) as { id?: number }).id === id);
    if (line === undefined) throw new Error(`no response for id ${id}:\n${stdout}`);
    const result = JSON.stringify((JSON.parse(line) as { result: unknown }).result);
    // JSON.stringify(JSON.parse(x)) re-emits the same compact bytes; prove the slice is the
    // server's own serialization rather than ours.
    expect(line, "result is the server's own bytes").toContain(`"result":${result}`);
    return result;
  };
  const initResult = raw(1);
  const toolsResult = raw(2);
  const tools = (JSON.parse(toolsResult) as { tools: { name: string }[]; nextCursor?: string })
    .tools;
  return {
    toolsResult,
    initResult,
    instructions: (JSON.parse(initResult) as { instructions: string }).instructions,
    toolNames: tools.map((t) => t.name),
  };
}

describe("tools/list is byte-identical across restarts (prompt-cache prefix)", () => {
  for (const mode of Object.keys(MODES) as FacadeMode[]) {
    it(`${mode}: tools/list result and initialize instructions match across two boots with different cacheDir + vault contents`, {
      timeout: stallTimeout(120_000),
    }, async () => {
      const [a, b] = await Promise.all([boot(mode, "a", false), boot(mode, "b", true)]);
      expect(a.toolNames.length).toBeGreaterThanOrEqual(MIN_TOOLS[mode]);
      expect(a.instructions.length).toBeGreaterThan(100);
      expect(new Set(a.toolNames).size, "tool names are unique").toBe(a.toolNames.length);
      // Names first: a shuffle then reports the reordered names, not an opaque hash mismatch.
      expect(b.toolNames).toEqual(a.toolNames);
      expect(sha(b.toolsResult)).toBe(sha(a.toolsResult));
      expect(b.instructions).toBe(a.instructions);
      expect(sha(b.initResult)).toBe(sha(a.initResult));
    });
  }

  it("the registry lists tools in registration order (the contract the restart check relies on)", () => {
    const registry = new ToolRegistry();
    const names = ["zeta", "alpha", "mid"];
    for (const name of names) {
      registry.register({
        name,
        description: name,
        inputSchema: z.object({}),
        requiredScopes: [],
        handler: () => ({ name }),
      });
    }
    expect(registry.list().map((t) => t.name)).toEqual(names);
  });
});
