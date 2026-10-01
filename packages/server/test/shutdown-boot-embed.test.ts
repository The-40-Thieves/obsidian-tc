// GH #995: on macOS, obsidian-tc run as `bun packages/server/dist/cli.js` over stdio (one process
// per MCP client) IGNORED a plain SIGTERM during the boot reconcile/embed pass — needing SIGKILL —
// whenever that pass was still busy embedding (the reporter's in-process ONNX embedder ran at
// ~330% CPU). Root cause, confirmed here rather than assumed: the boot reconcile's embed calls are
// chained purely through `await`, and an embed call that runs its ENTIRE duration as synchronous
// JS-thread work (a native/ONNX binding is exactly this shape) resolves via a microtask, not a
// macrotask — so a long, uninterrupted run of them never hands control back to libuv. A SIGTERM is
// queued by the OS the moment it is sent, but Node/Bun only DELIVERS it to `process.on("SIGTERM")`
// on a real event-loop turn; a process stuck microtask-chaining through dozens of embed calls never
// takes one, so the handler installed in shutdown.ts simply never runs until the whole pass
// finishes (or never, if it runs forever). This is the exact shape SIGKILL was needed for — a
// bounded internal race in server-runtime.ts's close() (SHUTDOWN_DRAIN_MS) cannot help, because
// close() itself is inside the handler that never gets invoked.
//
// This spawns the REAL built CLI (`node dist/cli.js <config>`, matching the .mcpb bundle's own
// runtime) against a temp vault with a stub `embeddings.provider: "module"` embedder (the repo's
// own escape hatch for a caller-supplied provider — see providers/module-loader.ts) whose embed()
// does ~200ms of SYNCHRONOUS busy work per call, with `embeddings.batchSize: 1` so the boot embed
// makes one provider call per note and the pass runs for several seconds — long enough to prove a
// bound, without needing the full 60-note/12s pass to finish before either assertion below can
// resolve.
//
// Fixed by (1) server-runtime.ts threading a REAL AbortController through to the boot reconcile
// (not the previous throwaway `new AbortController()`, which nothing could ever abort) and
// aborting it FIRST in close(); (2) embed-batches.ts's worker loop checking that signal AND
// yielding a real macrotask turn (`setImmediate`) between provider calls, which is what actually
// lets a queued SIGTERM be delivered; (3) index-vault.ts's flush() re-checking the signal before
// either attempting or writing an embed batch, so an aborted pass never commits partial vectors —
// the next reconcile re-plans and re-embeds those notes from scratch, same as any other
// self-healing skip in that file. See test 2 below for the stdin-EOF half of the same fix.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

// The CLI ships for both runtimes (`node dist/cli.js` is the .mcpb bundle's own invocation; `bun
// dist/cli.js` is the path a bun-first client takes) and the bug this file reproduces is a
// runtime-scheduling difference (macrotask delivery of a queued SIGTERM), not a node-only quirk —
// so both get the same two assertions below. `bunAvailable` mirrors
// doctor-cli-bundle-reranker-resolution.test.ts's own guard: bun is expected on every dev/CI box
// here, but `describe.skipIf` keeps a bun-less environment from failing on a missing binary rather
// than on the behavior under test.
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, "..");
const REPO_ROOT = join(SERVER_DIR, "..", "..");
const SHARED_DIR = join(REPO_ROOT, "packages", "shared");
const SHARED_DIST_INDEX = join(SHARED_DIR, "dist", "index.js");
const DIST_CLI = join(SERVER_DIR, "dist", "cli.js");

// Per-note synchronous busy time. 60 notes * ~200ms = ~12s of uninterrupted embed work if nothing
// ever yields — comfortably over the brief's ">10s" floor — while each individual assertion below
// only waits out a single bounded window after sending its signal, never the whole pass.
const NOTE_COUNT = 60;
const BUSY_MS = 200;
const EXIT_BOUND_MS = stallTimeout(5000);

/**
 * `build-test` (ci-server.yml) already runs `bun run build` in packages/shared then packages/server
 * before the test step, so in CI these are both already the real built artifacts by the time this
 * file runs — this only builds locally, when a developer runs this file in isolation without a
 * prior build. Deliberately NOT the private-outdir/atomic-rename dance
 * doctor-cli-bundle-reranker-resolution.test.ts uses: that machinery exists to test THAT file's own
 * directory-depth path arithmetic in a throwaway fake monorepo tree, and to survive being built
 * concurrently with other test files doing the same. This file only builds when the REAL dist is
 * missing, which is never true in CI (see above) and is a one-time local cost otherwise — run this
 * file in isolation (`bun run test -- test/shutdown-boot-embed.test.ts`), not the full suite, to
 * avoid racing that other file's own build of the same packages/shared/dist.
 */
beforeAll(() => {
  if (!existsSync(SHARED_DIST_INDEX)) {
    execFileSync("bun", ["run", "build"], { cwd: SHARED_DIR, stdio: "pipe" });
  }
  if (!existsSync(DIST_CLI)) {
    execFileSync("bun", ["run", "build"], { cwd: SERVER_DIR, stdio: "pipe" });
  }
}, 120_000);

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = makeTempDir(prefix);
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      // Best-effort: the assertion under test has already run either way.
    }
  }
});

/** Writes the stub embedder module, the fixture vault, and config.json; returns the config path. */
function makeFixture(): string {
  const vaultDir = tmpDir("otc-shutdown-vault-");
  for (let i = 0; i < NOTE_COUNT; i++) {
    writeFileSync(
      join(vaultDir, `note-${String(i).padStart(3, "0")}.md`),
      `# Note ${i}\n\nUnique filler content for note number ${i}, so no two notes dedup to the same embed text.\n`,
      "utf8",
    );
  }
  const cfgDir = tmpDir("otc-shutdown-cfg-");
  const stubPath = join(cfgDir, "stub-slow-embedder.mjs");
  writeFileSync(
    stubPath,
    `// Test-only stub for GH #995's shutdown-boot-embed repro. Deliberately SYNCHRONOUS —
// no setTimeout/setImmediate/await inside the busy window — matching the shape a native/ONNX
// binding takes on the JS main thread (the embedder-local package this box cannot rely on being
// built): a call that returns via a resolved promise with no macrotask in between.
export function createEmbeddingProvider() {
  return {
    id: "stub-slow-embedder",
    provider: "stub-slow",
    model: "stub-slow-v1",
    dimensions: 4,
    embed: async (texts) => {
      const until = Date.now() + ${BUSY_MS};
      while (Date.now() < until) {
        // busy-spin
      }
      return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
    },
  };
}
`,
    "utf8",
  );
  const cacheDir = join(cfgDir, "cache");
  mkdirSync(cacheDir, { recursive: true });
  const configPath = join(cfgDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        vaults: [{ id: "main", path: vaultDir }],
        cacheDir,
        embeddings: {
          provider: "module",
          modulePath: stubPath,
          dimensions: 4,
          batchSize: 1,
          concurrency: 1,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return configPath;
}

interface SpawnedServer {
  child: ReturnType<typeof spawn>;
  /** Resolves once "ready on stdio" has been seen on stderr — the boot reconcile is fire-and-forget
   *  (server-runtime.ts's start()) so this fires long before a 12s reconcile could finish, while
   *  the process is still deep in the embed pass. */
  ready: Promise<void>;
  /** Resolves with the exit code once the child has actually terminated. */
  exited: Promise<number | null>;
}

function spawnServer(configPath: string, runtime: "node" | "bun"): SpawnedServer {
  const child = spawn(runtime, [DIST_CLI, configPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  let stderrBuf = "";
  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
    if (stderrBuf.includes("ready on stdio")) resolveReady();
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  return { child, ready, exited };
}

/** Races `exited` against the bound; force-kills the child either way so a RED run never leaks a
 *  process still busy-spinning through the rest of the 12s reconcile. */
async function exitsWithin(server: SpawnedServer, ms: number): Promise<boolean> {
  try {
    const winner = await Promise.race([
      server.exited.then(() => "exited" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms)),
    ]);
    return winner === "exited";
  } finally {
    if (server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill("SIGKILL");
    }
  }
}

describe.each(["node", "bun"] as const)(
  "bounded shutdown during a slow boot embed (GH #995) — %s runtime",
  (runtime) => {
    // `bun` is skipped, not failed, when the binary is absent — see `bunAvailable`'s own comment.
    // `node` always runs: it is this repo's own vitest runtime, so it is unconditionally present.
    const skip = runtime === "bun" && !bunAvailable;

    it.skipIf(skip)(
      "exits within 5s of SIGTERM sent mid-reconcile, not needing SIGKILL",
      async () => {
        const configPath = makeFixture();
        const server = spawnServer(configPath, runtime);
        await server.ready;
        // THE-926/GH #995: reconcile is fire-and-forget from start(), so "ready" fires almost
        // immediately (see this file's header) while ~12s of stub embed work is still ahead —
        // send SIGTERM right away rather than polling for "mid-reconcile", to keep this
        // deterministic rather than timing-dependent.
        server.child.kill("SIGTERM");
        const ok = await exitsWithin(server, EXIT_BOUND_MS);
        expect(ok).toBe(true);
      },
      stallTimeout(30_000),
    );

    it.skipIf(skip)(
      "exits within 5s of the client closing stdin mid-reconcile (transport EOF), not just SIGTERM",
      async () => {
        const configPath = makeFixture();
        const server = spawnServer(configPath, runtime);
        await server.ready;
        server.child.stdin?.end();
        const ok = await exitsWithin(server, EXIT_BOUND_MS);
        expect(ok).toBe(true);
      },
      stallTimeout(30_000),
    );
  },
);
