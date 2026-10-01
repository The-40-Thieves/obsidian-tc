// GH #995 — end-to-end leader-lock coverage against the REAL BUILT CLI (`node dist/cli.js` /
// `bun dist/cli.js`, matching the .mcpb bundle's own invocation — see shutdown-boot-embed.test.ts,
// whose fixture/spawn helpers this file mirrors), spawning TWO processes against the SAME config
// (same cacheDir) — the actual multi-MCP-client-on-one-vault shape GH #995 reports.
//
// Test 1 (RED on origin/main: both processes ran the boot embed — see this file's own header
// note below and PR description for the pre-fix count): only the LEADER's pid appears in the
// shared embed-call log; the follower's boot reconcile must skip embedding entirely.
// Test 2: killing the leader -9 lets the follower promote and run its OWN reconcile (embed) within
// the follower retry window (vault-lock.ts's default 5-15s jittered retry).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { stallTimeout } from "./stall-timeouts";
import { rmTemp } from "./tmp";

const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, "..");
const REPO_ROOT = join(SERVER_DIR, "..", "..");
const SHARED_DIR = join(REPO_ROOT, "packages", "shared");
const SHARED_DIST_INDEX = join(SHARED_DIR, "dist", "index.js");
const DIST_CLI = join(SERVER_DIR, "dist", "cli.js");

// 20 notes * ~150ms of SYNCHRONOUS busy work each (matching shutdown-boot-embed.test.ts's own
// deterministic-scheduling rationale — a setTimeout-based delay leaves too much room for the OS
// to schedule the two processes' embed calls apart even when unlocked) = ~3s per process's boot
// reconcile — long enough that two processes spawned back-to-back genuinely OVERLAP their
// independent reconciles instead of one finishing (and committing content-hashes the other's
// incremental walk would then skip on) before the other even starts.
const NOTE_COUNT = 20;
const BUSY_MS = 150;

/** TEST_FALSE_ASSURANCE (fix round): the newest mtime under `dir` (recursive). This file's
 *  `beforeAll` used to build dist ONLY when it was entirely absent — a stale dist built before a
 *  LATER, unrelated src edit was never rebuilt, so this whole file could keep testing OLD code
 *  indefinitely while looking green. */
function newestMtimeMs(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    newest = Math.max(newest, newestMtimeMs(join(path, entry.name)));
  }
  return newest;
}

function distIsStale(distPath: string, srcPaths: readonly string[]): boolean {
  if (!existsSync(distPath)) return true;
  const distMtime = statSync(distPath).mtimeMs;
  return srcPaths.some((path) => existsSync(path) && newestMtimeMs(path) > distMtime);
}

beforeAll(() => {
  if (distIsStale(SHARED_DIST_INDEX, [join(SHARED_DIR, "src")])) {
    execFileSync("bun", ["run", "build"], { cwd: SHARED_DIR, stdio: "pipe" });
  }
  if (distIsStale(DIST_CLI, [join(SERVER_DIR, "src"), SHARED_DIST_INDEX])) {
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
  for (const child of liveChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      // best-effort: the assertion under test has already run either way
    }
  }
});

/** ONE shared config (ONE cacheDir) both spawned processes point at — the actual "several MCP
 *  clients, one vault" shape. The stub embedder appends `${pid}\n` to `logPath` on every call.
 *  The vault directory starts EMPTY on purpose — see `prewarmMigrations` below for why.
 *  `watchEnabled` (TEST_FALSE_ASSURANCE fix round, default true): the promotion test below sets
 *  this `false` so a post-promotion embed call can ONLY come from the promotion-triggered
 *  reconcile — with the filesystem watcher running, a note write made right after the kill could
 *  instead reach the newly-promoted follower through its (now live-gated) onUpsert callback,
 *  which would make the test pass even if the reconcile-join logic this PR is about were broken. */
function makeFixture(watchEnabled = true): {
  configPath: string;
  logPath: string;
  vaultDir: string;
} {
  const vaultDir = tmpDir("otc-leader-vault-");
  const cfgDir = tmpDir("otc-leader-cfg-");
  const logPath = join(cfgDir, "embed-calls.log");
  writeFileSync(logPath, "", "utf8");
  const stubPath = join(cfgDir, "stub-counting-embedder.mjs");
  writeFileSync(
    stubPath,
    `import { appendFileSync } from "node:fs";
// GH #995 test-only stub: records which process actually called embed(), so the failover test
// can tell the leader's boot reconcile apart from a follower that correctly skipped it.
export function createEmbeddingProvider() {
  return {
    id: "stub-counting-embedder",
    provider: "stub-counting",
    model: "stub-counting-v1",
    dimensions: 4,
    embed: async (texts) => {
      appendFileSync(${JSON.stringify(logPath)}, \`\${process.pid}\\n\`, "utf8");
      // SYNCHRONOUS busy work (no await inside the window) — deterministic scheduling, matching
      // shutdown-boot-embed.test.ts's own stub. Long enough per call that two independently-
      // reconciling processes genuinely overlap rather than one finishing before the other starts.
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
        watch: { enabled: watchEnabled },
      },
      null,
      2,
    ),
    "utf8",
  );
  return { configPath, logPath, vaultDir };
}

interface SpawnedServer {
  child: ReturnType<typeof spawn>;
  ready: Promise<void>;
}

function spawnServer(configPath: string, runtime: "node" | "bun"): SpawnedServer {
  const child = spawn(runtime, [DIST_CLI, configPath], {
    stdio: ["pipe", "pipe", "pipe"],
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
  return { child, ready };
}

/** Writes NOTE_COUNT markdown notes into an (until now empty) vault dir. */
function writeNotes(vaultDir: string): void {
  for (let i = 0; i < NOTE_COUNT; i++) {
    writeFileSync(
      join(vaultDir, `note-${String(i).padStart(3, "0")}.md`),
      `# Note ${i}\n\nUnique filler content for note number ${i}.\n`,
      "utf8",
    );
  }
}

/**
 * Boots ONE throwaway process against `configPath` and kills it once ready, so cache.db's
 * migrations are applied and COMMITTED before the real two-process race below starts. Without
 * this, two processes opening a FRESH cache.db at the exact same moment race each other's
 * migration runner (observed directly: `fatal: migration 20260713_001 failed: duplicate column
 * name: confidence` — a pre-existing, orthogonal migration-bootstrap race, not what GH #995 or
 * this file's leader lock is about) and one process crashes before ever reaching "ready", which
 * would fail this test for the wrong reason. The vault stays EMPTY through the warmup boot (see
 * `makeFixture`) so its own (trivial, zero-note) reconcile commits no content-hashes — the real
 * notes are written by `writeNotes` only AFTER this returns, so the actual race below still has
 * real, never-before-indexed content to contend over.
 */
async function prewarmMigrations(configPath: string, runtime: "node" | "bun"): Promise<void> {
  const warmup = spawnServer(configPath, runtime);
  await warmup.ready;
  warmup.child.kill("SIGKILL");
  await new Promise<void>((resolve) => warmup.child.once("exit", () => resolve()));
}

function distinctPids(logPath: string): Set<string> {
  const raw = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  return new Set(
    raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.each(["node", "bun"] as const)(
  "GH #995: one indexing leader per vault across stdio processes — %s runtime",
  (runtime) => {
    const skip = runtime === "bun" && !bunAvailable;

    it.skipIf(skip)(
      "exactly one of two processes on the same vault runs the boot embed",
      async () => {
        const { configPath, logPath, vaultDir } = makeFixture();
        await prewarmMigrations(configPath, runtime);
        writeNotes(vaultDir);
        writeFileSync(logPath, "", "utf8"); // warmup's own (zero-note) reconcile wrote nothing, belt-and-braces
        // Spawned back-to-back, BEFORE awaiting either's readiness, so their boot reconciles
        // genuinely race on the same never-before-indexed vault (see NOTE_COUNT/BUSY_MS above).
        const a = spawnServer(configPath, runtime);
        const b = spawnServer(configPath, runtime);
        await Promise.all([a.ready, b.ready]);
        // Bounded wait for the reconcile(s) to settle: NOTE_COUNT * BUSY_MS + generous overhead.
        await sleep(NOTE_COUNT * BUSY_MS + 3_000);
        // TEST_FALSE_ASSURANCE (fix round): pids.size===1 alone is satisfied just as well by ONE
        // process having crashed — assert BOTH are still alive first, so a size of 1 can only mean
        // "the follower correctly skipped embedding", never "there was only one survivor to embed".
        expect(a.child.exitCode).toBeNull();
        expect(a.child.signalCode).toBeNull();
        expect(b.child.exitCode).toBeNull();
        expect(b.child.signalCode).toBeNull();
        const pids = distinctPids(logPath);
        expect(pids.size).toBe(1);
      },
      60_000,
    );

    it.skipIf(skip)(
      "killing the leader -9 lets the follower promote and reconcile within the retry window",
      async () => {
        // TEST_FALSE_ASSURANCE (fix round): watch disabled — see makeFixture's own doc comment for
        // why a live watcher would let this test pass even with a broken reconcile-promotion path.
        const { configPath, logPath, vaultDir } = makeFixture(false);
        await prewarmMigrations(configPath, runtime);
        writeNotes(vaultDir);
        writeFileSync(logPath, "", "utf8");
        const a = spawnServer(configPath, runtime);
        const b = spawnServer(configPath, runtime);
        await Promise.all([a.ready, b.ready]);
        await sleep(NOTE_COUNT * BUSY_MS + 3_000); // let the leader finish its boot embed
        const beforePids = distinctPids(logPath);
        expect(beforePids.size).toBe(1);
        const leaderPid = String([...beforePids][0]);
        // Kill whichever spawned process actually became leader, not necessarily `a`.
        const leaderChild = String(a.child.pid) === leaderPid ? a.child : b.child;
        leaderChild.kill("SIGKILL");
        // Modify a note's content right after the kill: the follower's watcher is running (only
        // its onUpsert/onDelete CALLBACK is gated) but stays a follower for a while yet, so this
        // change is deliberately missed by the watcher gate — proving it's ONLY the promotion-
        // triggered RECONCILE (a fresh vault walk, content-hash mismatch) that catches it back up,
        // not a queued watcher event. A fresh embed call for this pid is therefore unambiguous
        // evidence that the follower actually promoted and ran ITS OWN reconcile.
        writeFileSync(
          join(vaultDir, "note-000.md"),
          "# Note 0\n\nCHANGED after the leader was killed.\n",
          "utf8",
        );
        // vault-lock.ts's default follower retry window is 5-15s (jittered, unref'd) — bounded
        // wait past the worst case.
        const deadline = Date.now() + stallTimeout(20_000);
        let promoted = false;
        while (Date.now() < deadline) {
          await sleep(500);
          const pids = distinctPids(logPath);
          if ([...pids].some((p) => p !== leaderPid)) {
            promoted = true;
            break;
          }
        }
        expect(promoted).toBe(true);
      },
      60_000,
    );
  },
);

// GH #995 fix round — COLD_BOOT_PRELOCK: two real processes booting the SAME, FRESH cacheDir
// together (no warmup) previously raced each other's cache.db migration runner directly
// (`migration 20260820_001 failed: duplicate column name: scope_caller`, reproduced with two real
// built CLIs) — wireStores' migration pass used to run BEFORE any election existed to serialize it.
// This is the exact race `prewarmMigrations` above exists to dodge; this block deliberately does
// NOT call it, so `withBootstrapBarrier` (vault-lock.ts) is what has to make both processes survive.
describe.each(["node", "bun"] as const)(
  "GH #995 fix round: COLD_BOOT_PRELOCK — two processes booting a FRESH cacheDir together",
  (runtime) => {
    const skip = runtime === "bun" && !bunAvailable;

    it.skipIf(skip)(
      "both processes come up against an empty cacheDir, deliberately NOT prewarmed",
      async () => {
        const { configPath } = makeFixture();
        const a = spawnServer(configPath, runtime);
        const b = spawnServer(configPath, runtime);
        let aStderr = "";
        let bStderr = "";
        a.child.stderr?.on("data", (c: Buffer) => {
          aStderr += c.toString("utf8");
        });
        b.child.stderr?.on("data", (c: Buffer) => {
          bStderr += c.toString("utf8");
        });
        const readyOrCrash = (spawned: SpawnedServer, label: string, stderrOf: () => string) =>
          new Promise<void>((resolve, reject) => {
            let settled = false;
            spawned.ready.then(() => {
              if (!settled) {
                settled = true;
                resolve();
              }
            });
            spawned.child.once("exit", (code, signal) => {
              if (!settled) {
                settled = true;
                reject(
                  new Error(
                    `${label} (${runtime}) exited (code=${code} signal=${signal}) before reaching ready; stderr:\n${stderrOf()}`,
                  ),
                );
              }
            });
          });
        await Promise.all([
          readyOrCrash(a, "process A", () => aStderr),
          readyOrCrash(b, "process B", () => bStderr),
        ]);
      },
      // withBootstrapBarrier SERIALIZES the two processes' migration passes (by design, that's the
      // fix), so worst-case boot time is closer to two sequential boots than one on a box this
      // shared (4 cores, ~43 other containers) — 30s and even 60s both measurably timed out here;
      // matches BOOTSTRAP_BARRIER_TIMEOUT_MS's own 60s busy_timeout plus headroom for the rest of
      // boot after the barrier releases.
      90_000,
    );
  },
);
