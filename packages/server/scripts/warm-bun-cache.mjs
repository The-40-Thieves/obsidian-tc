import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createIsolatedHome,
  sharedBunRuntimeTranspilerCachePath,
  waitForPidExit,
} from "./lib/isolated-home.mjs";

const COMMAND_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 10_000;
const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);
const cachePath = sharedBunRuntimeTranspilerCachePath();
mkdirSync(cachePath, { recursive: true });
process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = cachePath;

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runVersion(env) {
  const { stdout } = await execFileAsync("bun", ["src/cli.ts", "--version"], {
    cwd: SERVER_DIR,
    env,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  process.stdout.write(`warm version: ${stdout.trim()}\n`);
}

function cacheMetrics(root) {
  let files = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        files += 1;
        bytes += statSync(path).size;
      }
    }
  }
  return { files, bytes };
}

async function main() {
  const isolated = createIsolatedHome("obtc-bun-cache-warm-");
  const env = {
    ...process.env,
    ...isolated.env,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: cachePath,
    NO_COLOR: "1",
  };
  const vault = join(isolated.root, "vault");
  const cache = join(isolated.root, "server-cache");
  const modulePath = join(isolated.root, "warm-embedder.mjs");
  const configPath = join(isolated.root, "config.json");
  mkdirSync(vault, { recursive: true });
  writeFileSync(
    modulePath,
    "export function createEmbeddingProvider(){return {id:'warm',provider:'module',model:'warm',dimensions:4,embed:async texts=>texts.map(()=>[0,0,0,0])}}\n",
  );
  writeFileSync(
    configPath,
    JSON.stringify({
      vaults: [{ id: "main", path: vault }],
      cacheDir: cache,
      embeddings: { provider: "module", modulePath, dimensions: 4, batchSize: 1, concurrency: 1 },
    }),
  );

  await runVersion(env);

  let stderr = "";
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["src/cli.ts", "serve", "--config", configPath],
    cwd: SERVER_DIR,
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({ name: "bun-cache-warm", version: "0.0.0" });

  try {
    await withTimeout(client.connect(transport), COMMAND_TIMEOUT_MS, "stdio initialize");
    process.stdout.write("warm serve: initialize succeeded over stdio\n");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`.trim());
  } finally {
    const pid = transport.pid;
    try {
      await withTimeout(client.close(), CLOSE_TIMEOUT_MS, "stdio close");
    } catch {
      if (pid !== null) process.kill(pid, "SIGKILL");
    }
    if (pid !== null && !(await waitForPidExit(pid, CLOSE_TIMEOUT_MS))) {
      process.kill(pid, "SIGKILL");
      await waitForPidExit(pid, CLOSE_TIMEOUT_MS);
    }
    isolated.cleanup();
  }

  const metrics = cacheMetrics(cachePath);
  process.stdout.write(
    `Bun runtime transpiler cache: ${metrics.files} files, ${metrics.bytes} bytes (${cachePath})\n`,
  );
  if (metrics.files === 0 || metrics.bytes === 0)
    throw new Error("Bun cache warm-up populated no files");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
