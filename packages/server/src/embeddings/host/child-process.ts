// GH #1433 rec 4, step 2: the child-process EmbedderHost. The model runs in a child process that this
// host spawns on the first embed (child-main.ts answers the protocol in protocol.ts). Stopping the child
// returns its memory to the OS, which an in-process ONNX session cannot do.
//
// One request is in flight at a time, FIFO. The local provider's concurrency is already 1, and a single
// request in flight means a child death belongs to exactly that request.
import { type ChildProcessByStdio, spawn as spawnChild } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import {
  type ChildMessage,
  type EmbedderInitOpts,
  encodeMessage,
  type ParentMessage,
  parseMessage,
} from "./protocol";
import type {
  EmbedderHost,
  EmbedderHostState,
  EmbedderHostStats,
  EmbedderRecycleReason,
} from "./types";

/** Child deaths inside CIRCUIT_WINDOW_MS that open the circuit. */
export const CIRCUIT_DEATHS = 3;
export const CIRCUIT_WINDOW_MS = 60_000;
/** How long an open circuit rejects embeds before one spawn is allowed. */
export const CIRCUIT_COOLDOWN_MS = 60_000;
/** A drained child that has not exited by then is killed. */
const SHUTDOWN_GRACE_MS = 5_000;

export interface ChildProcessHostOptions {
  /** The command that starts an embedder child: selfSpawnArgv() in production. */
  argv: readonly string[];
  init: EmbedderInitOpts;
  /** Merged over the parent's environment for the child. */
  env?: NodeJS.ProcessEnv;
  /** The circuit breaker's clock. Tests inject one. */
  now?: () => number;
  shutdownGraceMs?: number;
}

type ChildProc = ChildProcessByStdio<Writable, Readable, null>;
type Request = Extract<ParentMessage, { t: "embed" | "stats" }>;

interface Running {
  proc: ChildProc;
  pid: number | undefined;
  ready: boolean;
  /** The parent asked this child to stop (drain or close), so its exit is not a death. */
  stopping: boolean;
  dead: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
}

interface Job {
  request: Request;
  /** Child deaths this request has been in flight for. One death is retried; a second rejects. */
  deaths: number;
  resolve: (message: ChildMessage) => void;
  reject: (error: unknown) => void;
}

export function createChildProcessHost(opts: ChildProcessHostOptions): EmbedderHost {
  const now = opts.now ?? Date.now;
  const graceMs = opts.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  const queue: Job[] = [];
  const drainWaiters: Array<() => void> = [];
  let inFlight: Job | undefined;
  let child: Running | undefined;
  let state: EmbedderHostState = "idle";
  let nextId = 1;
  let restarts = 0;
  let recycles = 0;
  let deaths: number[] = [];
  let openUntil: number | undefined;
  let probing = false;
  let draining = false;
  let closed = false;
  let initError: string | undefined;

  const circuitError = () =>
    err.embeddingProviderError("embedder host circuit is open after repeated child deaths", {
      hint: `the embedder child kept exiting; embeds resume after a ${CIRCUIT_COOLDOWN_MS / 1000} s cooldown`,
    });
  const closedError = () => err.embeddingProviderError("embedder host closed");

  const rejectQueued = (error: unknown): void => {
    for (const job of queue.splice(0)) job.reject(error);
  };

  const write = (running: Running, message: ParentMessage): void => {
    running.proc.stdin.write(encodeMessage(message));
  };

  const openCircuit = (): void => {
    openUntil = now() + CIRCUIT_COOLDOWN_MS;
    probing = false;
    state = "failed";
    rejectQueued(circuitError());
  };

  // Sends the head of the queue to the child, spawning one lazily. Nothing runs while draining: the
  // queue waits for the drain to finish, then the next child serves it.
  const pump = (): void => {
    if (draining) {
      stopIfIdle();
      return;
    }
    if (inFlight || queue.length === 0) return;
    if (closed) {
      rejectQueued(closedError());
      return;
    }
    if (!child) {
      if (openUntil !== undefined) {
        openUntil = undefined;
        probing = true;
      }
      startChild();
    }
    const job = queue.shift() as Job;
    inFlight = job;
    write(child as Running, job.request);
  };

  const submit = (job: Job): void => {
    if (closed) {
      job.reject(closedError());
      return;
    }
    if (openUntil !== undefined && now() < openUntil) {
      job.reject(circuitError());
      return;
    }
    queue.push(job);
    pump();
  };

  const startChild = (): void => {
    const [command, ...args] = opts.argv;
    const proc = spawnChild(command as string, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...opts.env, OBSIDIAN_TC_EMBEDDER_HOST: "1" },
    });
    const running: Running = { proc, pid: proc.pid, ready: false, stopping: false, dead: false };
    child = running;
    state = "loading";
    initError = undefined;
    createInterface({ input: proc.stdout }).on("line", (line) => onLine(running, line));
    // A dead child's broken pipe surfaces here; its exit is handled by the 'close' listener below.
    proc.stdin.on("error", () => {});
    proc.on("error", (error) => onExit(running, `spawn error: ${error.message}`));
    proc.on("close", (code, signal) =>
      onExit(running, signal ? `signal ${signal}` : `code ${code}`),
    );
    write(running, { t: "init", v: 1, opts: opts.init });
  };

  const onLine = (running: Running, line: string): void => {
    if (running.dead || running !== child) return;
    let message: ChildMessage;
    try {
      message = parseMessage(line) as ChildMessage;
    } catch {
      // A line the parent cannot parse is a crash. Kill it; the exit is then counted as a death.
      running.proc.kill("SIGKILL");
      return;
    }
    switch (message.t) {
      case "ready":
        running.ready = true;
        if (!draining) state = "ready";
        return;
      case "error": {
        if (message.id === "init") {
          initError = message.message;
          return;
        }
        if (inFlight?.request.id !== message.id) return;
        const job = inFlight;
        inFlight = undefined;
        job.reject(err.embeddingProviderError(message.message));
        pump();
        return;
      }
      case "result":
      case "stats": {
        if (inFlight?.request.id !== message.id) return;
        const job = inFlight;
        inFlight = undefined;
        probing = false;
        deaths = [];
        job.resolve(message);
        pump();
        return;
      }
      default:
        return;
    }
  };

  const onExit = (running: Running, reason: string): void => {
    if (running.dead) return;
    running.dead = true;
    if (running.killTimer) clearTimeout(running.killTimer);
    if (child === running) child = undefined;
    if (running.stopping) {
      finishDrain();
      pump();
      return;
    }
    restarts += 1;
    const at = now();
    deaths = deaths.filter((t) => at - t < CIRCUIT_WINDOW_MS);
    deaths.push(at);
    console.error(`embedder host: child ${running.pid ?? "(unspawned)"} exited (${reason})`);
    const job = inFlight;
    inFlight = undefined;
    if (job) {
      job.deaths += 1;
      if (initError !== undefined) job.reject(err.embeddingProviderError(initError));
      else if (job.deaths > 1 || closed) {
        job.reject(err.embeddingProviderError("embedder child died while serving this request"));
      } else queue.unshift(job);
    }
    if (draining) finishDrain();
    if (probing || deaths.length >= CIRCUIT_DEATHS) {
      openCircuit();
      return;
    }
    state = "idle";
    pump();
  };

  const finishDrain = (): void => {
    draining = false;
    state = "idle";
    for (const resolveWaiter of drainWaiters.splice(0)) resolveWaiter();
  };

  // Asks the child to exit once no request is in flight. The child exits on the shutdown message; the
  // grace timer kills one that does not.
  const stopIfIdle = (): void => {
    if (!draining || inFlight || !child || child.stopping) return;
    const running = child;
    running.stopping = true;
    write(running, { t: "shutdown", v: 1 });
    running.killTimer = setTimeout(() => running.proc.kill("SIGKILL"), graceMs);
  };

  const drain = (): Promise<void> =>
    new Promise((resolve) => {
      if (!child) {
        resolve();
        return;
      }
      draining = true;
      state = "draining";
      drainWaiters.push(resolve);
      stopIfIdle();
    });

  return {
    kind: "child-process",
    embed: (texts, embedOpts) =>
      new Promise((resolve, reject) => {
        submit({
          request: { t: "embed", v: 1, id: nextId++, texts, opts: embedOpts },
          deaths: 0,
          resolve: (message) => {
            if (message.t === "result") resolve(message.vectors);
            else reject(err.embeddingProviderError("embedder child sent an unexpected reply"));
          },
          reject,
        });
      }),
    recycle: async (_reason: EmbedderRecycleReason) => {
      recycles += 1;
      await drain();
    },
    stats: async (): Promise<EmbedderHostStats> => {
      const running = child;
      let rssBytes: number | undefined;
      if (running?.ready && !inFlight && !draining && queue.length === 0) {
        try {
          const reply = await new Promise<ChildMessage>((resolve, reject) =>
            submit({
              request: { t: "stats", v: 1, id: nextId++ },
              deaths: 0,
              resolve,
              reject,
            }),
          );
          if (reply.t === "stats") rssBytes = reply.rssBytes;
        } catch {
          rssBytes = undefined;
        }
      }
      return { state, restarts, recycles, pid: child?.pid, rssBytes };
    },
    close: async () => {
      closed = true;
      rejectQueued(closedError());
      await drain();
    },
  };
}
