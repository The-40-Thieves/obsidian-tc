// Cold `initialize` latency on a real vault, per transport. Spawns the REAL server (`cli.ts serve`)
// in a fresh process with a fresh cacheDir and times process-spawn -> the `initialize` response.
//
// boot-probe.ts cannot answer this: it times module load and registration with stubbed deps and
// stands up no transport. The client-side limits that matter (Open WebUI: 10 s initialize, Codex:
// 10 s startup) are on the whole path a client waits for, including anything the boot sequence does
// on the event loop before it reads the first request. A reconcile that walks the vault
// synchronously, or an embedding provider that probes its model, shows up here and nowhere else.
//
//   bun eval/perf/initialize-probe.ts --vault <dir> [--transport stdio|http] [--runs 3] [--embed-url http://127.0.0.1:PORT/v1]
//
// --settle-ms N: send initialize N ms AFTER the ready notice, i.e. while the boot reconcile runs,
// and time only that request (a client reconnecting after a restart; needs --embed-url to be busy).
//
// Prints one JSON line: { transport, vault_files, runs: [{initialize_ms, ready_ms}], median_ms }.
// The vault is only READ by the server; the cacheDir lives in a temp dir that is removed.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "initialize-probe", version: "0" },
  },
};

type Transport = "stdio" | "http";

interface Run {
  /** Spawn -> the initialize response. */
  initialize_ms: number;
  /** Spawn -> the "ready" notice on stderr (null if it had not printed by the response). */
  ready_ms: number | null;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  }
  return n;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** One cold run. */
async function oneRun(
  vault: string,
  transport: Transport,
  embedUrl?: string,
  settleMs = 0,
): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "obtc-init-probe-"));
  mkdirSync(join(dir, "cache"));
  const port = transport === "http" ? await freePort() : 0;
  const config = join(dir, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      vaults: [{ id: "probe", path: vault }],
      cacheDir: join(dir, "cache"),
      acl: { readOnly: false, strictReadDefault: false, readPaths: ["**"], writePaths: ["**"] },
      // A reachable OpenAI-shaped endpoint makes the boot reconcile do its real work (chunk, embed,
      // write) instead of failing fast on an unresolvable default "local" provider.
      ...(embedUrl
        ? {
            embeddings: {
              provider: "openai",
              model: "stub",
              dimensions: 16,
              baseUrl: embedUrl,
              apiKey: "stub",
            },
          }
        : {}),
      transports:
        transport === "stdio"
          ? { stdio: true, http: { enabled: false } }
          : { stdio: false, http: { enabled: true, host: "127.0.0.1", port } },
    }),
  );
  const t0 = performance.now();
  let readyAt: number | null = null;
  const child: ChildProcess = spawn("bun", [CLI, "serve", "--config", config], {
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Not forwarded: a misconfigured optional provider logs a page per run. Only the listening
  // notice is used, to separate "boot finished" from "initialize answered".
  child.stderr?.on("data", (d: Buffer) => {
    if (readyAt === null && d.includes(" ready")) readyAt = performance.now() - t0;
  });
  const done = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    return await new Promise<Run>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no initialize response in 120 s")), 120_000);
      // settleMs > 0: the client arrives LATE, while the boot-time reconcile is running (a client
      // reconnecting after a restart). Latency is then measured from the send, not from spawn.
      let sentAt = t0;
      const finish = (): void => {
        clearTimeout(timer);
        resolve({
          initialize_ms: Math.round(performance.now() - sentAt),
          ready_ms: readyAt === null ? null : Math.round(readyAt),
        });
      };
      child.once("error", reject);
      child.once("close", (code) => reject(new Error(`server exited (${code}) before initialize`)));
      const afterSettle = (go: () => void): void => {
        if (settleMs <= 0) {
          go();
          return;
        }
        const wait = (): void => {
          if (readyAt === null) {
            setTimeout(wait, 10);
            return;
          }
          setTimeout(() => {
            sentAt = performance.now();
            go();
          }, settleMs);
        };
        wait();
      };
      if (transport === "stdio") {
        let out = "";
        child.stdout?.setEncoding("utf8").on("data", (d: string) => {
          out += d;
          if (out.includes('"id":1')) finish();
        });
        afterSettle(() => child.stdin?.write(`${JSON.stringify(INIT)}\n`));
      } else {
        // The listener is not up until the boot reaches it; connection refused IS the wait.
        const attempt = (): void => {
          fetch(`http://127.0.0.1:${port}/mcp`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify(INIT),
          }).then(
            async (res) => {
              const body = await res.text();
              if (res.ok && body.includes("protocolVersion")) finish();
              else reject(new Error(`initialize failed: ${res.status} ${body.slice(0, 200)}`));
            },
            () => setTimeout(attempt, 5),
          );
        };
        afterSettle(attempt);
      }
    });
  } finally {
    child.stdin?.end();
    child.kill("SIGTERM");
    // A reconcile that hogs the loop never services SIGTERM; the probe must not wait on it.
    const hardKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await done;
    clearTimeout(hardKill);
    rmSync(dir, { recursive: true, force: true });
  }
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const vault = arg("vault");
  const transport = arg("transport", "stdio") as Transport;
  if (transport !== "stdio" && transport !== "http") throw new Error("--transport: stdio | http");
  const n = Number(arg("runs", "3"));
  const embedUrl = process.argv.includes("--embed-url") ? arg("embed-url") : undefined;
  const runs: Run[] = [];
  const settleMs = Number(arg("settle-ms", "0"));
  for (let i = 0; i < n; i++) runs.push(await oneRun(vault, transport, embedUrl, settleMs));
  const sorted = runs.map((r) => r.initialize_ms).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  process.stdout.write(
    `${JSON.stringify({ transport, vault_files: countFiles(vault), runs, median_ms: median })}\n`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`initialize probe failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
