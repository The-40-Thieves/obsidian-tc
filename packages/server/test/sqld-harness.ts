// Test harness: a real libSQL server (sqld) on a loopback port, for the embedded-replica tests.
//
// sqld is the official self-hosted server (github.com/tursodatabase/libsql, release tag
// libsql-server-vX; Linux x64/arm64 and macOS x64/arm64 builds, no Windows build). Located via
// OBSIDIAN_TC_SQLD_BIN, else `sqld` on PATH. When it is absent the tests SKIP, unless
// OBSIDIAN_TC_REQUIRE_SQLD=1 (a CI leg that provisions it, or the invariant ledger) in which case
// the absence is itself a failure: a gate that skips everything reports success over nothing.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { basename, join } from "node:path";

export function sqldBinary(): string | undefined {
  const fromEnv = process.env.OBSIDIAN_TC_SQLD_BIN;
  if (fromEnv) return spawnSync(fromEnv, ["--version"]).status === 0 ? fromEnv : undefined;
  return spawnSync("sqld", ["--version"]).status === 0 ? "sqld" : undefined;
}

export function sqldRequired(): boolean {
  return process.env.OBSIDIAN_TC_REQUIRE_SQLD === "1";
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export interface Sqld {
  url: string;
  stop(): Promise<void>;
}

/** Start sqld bound to 127.0.0.1 only. With `withVec`, sqld loads sqlite-vec on every connection
 *  (`--extensions-path` + a `trusted.lst` of sha256 + file name), which a vec0 virtual table needs
 *  on the SERVER: writes to it are forwarded and executed there. */
export async function startSqld(
  bin: string,
  dir: string,
  opts: { withVec?: boolean } = {},
): Promise<Sqld> {
  const port = await freePort();
  const args = ["--db-path", join(dir, "data.sqld"), "--http-listen-addr", `127.0.0.1:${port}`];
  if (opts.withVec) {
    const extDir = join(dir, "ext");
    mkdirSync(extDir);
    const { getLoadablePath } = createRequire(import.meta.url)("sqlite-vec") as {
      getLoadablePath(): string;
    };
    const src = getLoadablePath();
    const dest = join(extDir, basename(src));
    copyFileSync(src, dest);
    const sum = createHash("sha256").update(readFileSync(dest)).digest("hex");
    writeFileSync(join(extDir, "trusted.lst"), `${sum}  ${basename(dest)}\n`);
    args.push("--extensions-path", extDir);
  }
  const child: ChildProcess = spawn(bin, args, { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`sqld did not become healthy on ${url}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    url,
    stop: async () => {
      child.kill("SIGTERM");
      const forced = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(forced);
    },
  };
}
