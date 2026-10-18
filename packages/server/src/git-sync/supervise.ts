import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:os";

/** What bootGitSync returns: the sync loop, which runs until its signal aborts. */
export interface SupervisedSync {
  run(signal: AbortSignal): Promise<void>;
}

export interface SuperviseOptions {
  /** Aborted when the launcher is asked to stop (run_git_sync maps SIGINT/SIGTERM to it). */
  shutdown: AbortSignal;
  /** Clone or verify the vault and finish one pull. A rejection means no child is started. */
  boot: () => Promise<SupervisedSync>;
  /** Starts the server child. Injected so the lifecycle is testable without a real server. */
  spawnServer: () => ChildProcess;
  logger?: (line: string) => void;
  /** How long a child may take to exit after SIGTERM before it is sent SIGKILL. */
  graceMs?: number;
}

export const DEFAULT_SUPERVISE_GRACE_MS = 10_000;

/**
 * The server child: the same runtime running the same entry script as this launcher, with the
 * launcher's environment and stdio. With no server args it reads its configuration from env.
 */
export function startServer(serverArgs: readonly string[], entry: string): ChildProcess {
  return spawn(process.execPath, [entry, ...serverArgs], { stdio: "inherit", env: process.env });
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

type StopReason =
  | { from: "child"; exit: ChildExit }
  | { from: "loop"; error: unknown }
  | { from: "shutdown" };

function exitStatus(exit: ChildExit): number {
  if (exit.code !== null) return exit.code;
  return exit.signal ? 128 + (constants.signals[exit.signal] ?? 0) : 1;
}

function terminate(child: ChildProcess, exited: Promise<ChildExit>, graceMs: number): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  void exited.then(() => clearTimeout(timer));
}

/**
 * Runs the sync loop beside the server child. Whichever stops first decides the outcome: the
 * child exiting, the loop failing, or a shutdown request. Everything else is then stopped, and the
 * launcher resolves with a status: the child's own status after a requested shutdown, otherwise a
 * non-zero status (the child's, or 1 when the child exited 0 or the loop failed).
 */
export async function superviseGitSync(options: SuperviseOptions): Promise<number> {
  const { shutdown, graceMs = DEFAULT_SUPERVISE_GRACE_MS } = options;
  const logger = options.logger ?? ((line: string) => process.stderr.write(`${line}\n`));
  let sync: SupervisedSync;
  try {
    sync = await options.boot();
  } catch (error) {
    if (shutdown.aborted) return 0;
    throw error;
  }
  if (shutdown.aborted) return 0;

  const child = options.spawnServer();
  const exited = new Promise<ChildExit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => {
      logger(`[git-sync] error server ${error.message}`);
      resolve({ code: null, signal: null });
    });
  });
  const loopAbort = new AbortController();
  const loopDone = sync.run(loopAbort.signal).then(
    () => undefined,
    (error: unknown) => error ?? new Error("git-sync loop stopped"),
  );

  const reason = await Promise.race<StopReason>([
    exited.then((exit) => ({ from: "child", exit })),
    loopDone.then((error) => ({
      from: "loop",
      error: error ?? new Error("git-sync loop stopped"),
    })),
    new Promise<StopReason>((resolve) => {
      if (shutdown.aborted) resolve({ from: "shutdown" });
      else shutdown.addEventListener("abort", () => resolve({ from: "shutdown" }), { once: true });
    }),
  ]);

  loopAbort.abort();
  if (reason.from === "loop") logger(`[git-sync] error loop ${String(reason.error)}`);
  if (reason.from !== "child") terminate(child, exited, graceMs);
  const exit = await exited;
  // Let an in-flight pull or push finish before the process exits; the loop stops at its next tick.
  await loopDone;

  const status = exitStatus(exit);
  if (reason.from === "shutdown") return status;
  // The loop failing is the cause even though the child's status is the SIGTERM we sent it.
  if (reason.from === "loop") return 1;
  return status === 0 ? 1 : status;
}
