// Shared synchronous `bun <script> ...args` runner for the tests that exercise a real CLI process.
// The kill timeout goes through `stallTimeout`, so on a stalled Windows runner a slow-but-alive
// child gets the shared ceiling instead of being killed at its tight Linux budget (exit -1).
import { spawnSync } from "node:child_process";
import { stallTimeout } from "./stall-timeouts";

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunBunOptions {
  /** Kill timeout on Linux/macOS; Windows raises it to the shared stall ceiling. */
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
}

/** `args[0]` is the script (e.g. src/cli.ts). A killed child reports `code: -1`. */
export function runBunSync(args: string[], opts: RunBunOptions = {}): CliRun {
  const r = spawnSync("bun", args, {
    encoding: "utf8",
    timeout: stallTimeout(opts.timeoutMs ?? 20_000),
    env: { ...process.env, NO_COLOR: "1", ...opts.env },
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
