// A regression for the fix this file names in its own basename: since 1.31.6 (GH #995's bounded
// shutdown), `server-runtime.ts`'s stdio `onclose` handler unconditionally routed a stdio EOF
// through the SAME bounded close()+process.exit(0) every SIGTERM uses — even when
// `transports.http.enabled` was also true. A process launched with stdin at /dev/null
// (`docker run -d`, a compose service with no `stdin_open: true`, a systemd unit) hits that EOF
// the instant it starts, so the whole process — HTTP listener included — exited immediately.
// Observed live as a crash-loop: "ready on stdio" then "shutting down (transport:stdio-eof")
// on repeat.
//
// This spawns the REAL built CLI (matching shutdown-boot-embed.test.ts's own GH #995 spawn
// pattern) with BOTH transports enabled and stdin backed by `/dev/null` FROM PROCESS BIRTH
// (`stdio: ["ignore", ...]`) — not a live pipe closed later — because the real bug's EOF races
// `connectStdio()`/`server.onclose` assignment from the very first tick, which a pipe closed
// after "ready on stdio" cannot exercise. Asserts the process stays alive and the HTTP transport
// keeps serving through that EOF, then exits GRACEFULLY on SIGTERM (exit code 0, no terminating
// signal — not just "the child eventually stopped") on POSIX; win32 has no real SIGTERM delivery
// (`child.kill("SIGTERM")` there is a bare TerminateProcess, so exit code/signal are meaningless)
// and keeps the same bounded-exit check every GH #995 sibling test already uses on that platform.
// The existing stdio-only EOF test in
// shutdown-boot-embed.test.ts is unchanged and must stay green — this file only covers the
// HTTP-also-enabled shape.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { rmTemp } from "./tmp";

const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, "..");
const REPO_ROOT = join(SERVER_DIR, "..", "..");
const SHARED_DIR = join(REPO_ROOT, "packages", "shared");
const SHARED_DIST_INDEX = join(SHARED_DIR, "dist", "index.js");
const DIST_CLI = join(SERVER_DIR, "dist", "cli.js");

const EXIT_BOUND_MS = 5000;
const KEEPALIVE_WAIT_MS = 1500;

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
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const liveChildren: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  // Kill any child still alive after a failed/timed-out assertion so a RED run never leaks a
  // process holding its HTTP port open for the next test.
  for (const child of liveChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      // Best-effort: the assertion under test has already run either way.
    }
  }
});

/** OS-assigned free TCP port, released before the CLI itself binds it — same pattern as
 *  `startHttp({ port: 0 })` in the in-process HTTP tests, needed here because the config file
 *  goes through `ServerConfigSchema`, which requires `transports.http.port >= 1`. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

/** Writes a fixture vault (a single note; no slow embed needed — this test cares only about
 *  transport lifetime, not indexing) and a config with BOTH transports on. Returns the config
 *  path and the chosen HTTP port. */
function makeFixture(httpPort: number): string {
  const vaultDir = tmpDir("otc-stdio-http-vault-");
  writeFileSync(join(vaultDir, "note.md"), "# Note\n\nfixture body\n", "utf8");
  const cfgDir = tmpDir("otc-stdio-http-cfg-");
  const stubPath = join(cfgDir, "stub-fast-embedder.mjs");
  writeFileSync(
    stubPath,
    `// Deliberately trivial and synchronous — this test only cares that the boot reconcile
// finishes without needing network access to a real embedding provider.
export function createEmbeddingProvider() {
  return {
    id: "stub-fast-embedder",
    provider: "stub-fast",
    model: "stub-fast-v1",
    dimensions: 4,
    embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
  };
}
`,
    "utf8",
  );
  const cacheDir = join(cfgDir, "cache");
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
        transports: {
          stdio: true,
          http: { enabled: true, host: "127.0.0.1", port: httpPort },
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
  ready: Promise<void>;
  exited: Promise<number | null>;
}

function spawnServer(configPath: string, runtime: "node" | "bun"): SpawnedServer {
  const child = spawn(runtime, [DIST_CLI, configPath], {
    // fd 0 = /dev/null from the moment the process starts — the actual docker/systemd shape,
    // and the one that can race `connectStdio()`'s own `server.onclose` assignment. stdout/stderr
    // stay piped so "ready on stdio" and the HTTP transport are both still observable.
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  liveChildren.push(child);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.each(["node", "bun"] as const)(
  "stdin EOF with HTTP also enabled — %s runtime",
  (runtime) => {
    const skip = runtime === "bun" && !bunAvailable;

    it.skipIf(skip)(
      "survives stdin EOF and keeps serving HTTP, then exits promptly on SIGTERM",
      async () => {
        const port = await freePort();
        const configPath = makeFixture(port);
        const server = spawnServer(configPath, runtime);
        await server.ready;
        // fd 0 was already /dev/null before this process existed, so the stdio EOF this test
        // cares about has already raced `connectStdio()` by the time "ready on stdio" printed —
        // this wait just gives the (correctly non-fatal) EOF time to have been handled.
        await sleep(KEEPALIVE_WAIT_MS);

        expect(server.child.exitCode).toBeNull();
        expect(server.child.signalCode).toBeNull();

        const client = new Client({ name: "stdio-eof-http-keepalive-test", version: "0.0.0" });
        const url = new URL(`http://127.0.0.1:${port}/mcp`);
        await client.connect(new StreamableHTTPClientTransport(url));
        const tools = await client.listTools();
        expect(tools.tools.length).toBeGreaterThan(0);
        await client.close();

        server.child.kill("SIGTERM");
        const ok = await exitsWithin(server, EXIT_BOUND_MS);
        expect(ok).toBe(true);
        if (process.platform === "win32") {
          // Windows has no real SIGTERM delivery: `child.kill("SIGTERM")` is a bare
          // TerminateProcess (Node docs) — the app's own signal handler never runs, so
          // exitCode/signalCode say nothing about graceful-vs-forced shutdown here. `exitsWithin`
          // above (matching every GH #995 sibling test's own platform-agnostic bound check) is
          // already the real assertion on this platform: process gone within EXIT_BOUND_MS.
          expect(server.child.exitCode === 0 || server.child.signalCode !== null).toBe(true);
        } else {
          // POSIX: an exit code of 0 with no terminating signal means close() ran and called
          // process.exit(0) itself — a hang killed by exitsWithin's own SIGKILL fallback, or an
          // unhandled-SIGTERM default termination, would show a null exitCode and a non-null
          // signalCode instead.
          expect(server.child.exitCode).toBe(0);
          expect(server.child.signalCode).toBeNull();
        }
      },
      30_000,
    );
  },
);
