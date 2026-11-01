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
import { isCliEntryMarked } from "./spawn-argv";
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
/** A child that is asked to stop (drain, or close) and has not exited by then is killed. */
const SHUTDOWN_GRACE_MS = 5_000;
/** The embeddings.timeoutMs default (packages/shared config schema): the deadline for one request, and
 *  for the child's ready message. A child that misses it is killed and goes through the death path. */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ChildProcessHostOptions {
  /** The command that starts an embedder child: selfSpawnArgv() in production. */
  argv: readonly string[];
  init: EmbedderInitOpts;
  /** Merged over the parent's environment for the child. */
  env?: NodeJS.ProcessEnv;
  /** The circuit breaker's clock. Tests inject one. */
  now?: () => number;
  shutdownGraceMs?: number;
  /** embeddings.timeoutMs: the deadline for one embed or stats request, and for the ready message. */
  timeoutMs?: number;
}

type ChildProc = ChildProcessByStdio<Writable, Readable, null>;
type Request = Extract<ParentMessage, { t: "embed" | "stats" }>;
/** A child process or pipe whose event-loop reference can be taken and dropped. Bun's stdin has no
 *  ref/unref, so each handle is optional. */
type RefHandle = { ref?(): unknown; unref?(): unknown };

interface Running {
  proc: ChildProc;
  pid: number | undefined;
  ready: boolean;
  /** The parent asked this child to stop (drain, or close), so its exit is not a death. */
  stopping: boolean;
  dead: boolean;
  /** The grace timer: kills a child that was asked to stop and has not exited. */
  killTimer?: ReturnType<typeof setTimeout>;
  /** The deadline for the ready message, or for the request in flight. */
  deadline?: ReturnType<typeof setTimeout>;
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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
  // The child's last reported RSS (from a stats reply), so snapshot() can report it without IPC.
  let lastRssBytes: number | undefined;

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

  // An idle child must not keep the parent's event loop alive: a one-shot CLI command that embeds once
  // and never calls close() would otherwise hang on it. The child's stdin closes with this process, and
  // the child exits on that EOF. The child and its pipes are referenced only while a request is queued
  // or in flight.
  // Measured under bun 1.4: a ref() on the stdout pipe keeps the parent alive after the release, so only
  // the child process itself is ref'd while busy. Its stdout is unref'd with it while idle.
  const setHeld = (running: Running, held: boolean): void => {
    const proc = running.proc as unknown as RefHandle;
    if (held) {
      proc.ref?.();
      return;
    }
    proc.unref?.();
    (running.proc.stdout as unknown as RefHandle).unref?.();
  };

  const clearDeadline = (running: Running): void => {
    if (running.deadline) clearTimeout(running.deadline);
    running.deadline = undefined;
  };

  // A child that does not answer in time is SIGKILLed; its exit is then counted as a death, so the
  // request is retried once and the circuit breaker sees it like any other crash.
  const armDeadline = (running: Running): void => {
    clearDeadline(running);
    running.deadline = setTimeout(() => running.proc.kill("SIGKILL"), timeoutMs);
  };

  // The grace timer starts once, so a child that is already dying is not given a second grace period.
  const armKill = (running: Running): void => {
    if (running.killTimer) return;
    running.killTimer = setTimeout(() => {
      running.stopping = true;
      running.proc.kill("SIGKILL");
    }, graceMs);
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
    if (inFlight || queue.length === 0) {
      if (!inFlight && child) setHeld(child, false);
      return;
    }
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
    const running = child as Running;
    const job = queue.shift() as Job;
    inFlight = job;
    setHeld(running, true);
    write(running, job.request);
    armDeadline(running);
  };

  const submit = (job: Job): void => {
    if (closed) {
      job.reject(closedError());
      return;
    }
    // The child re-runs argv[1]. Only the CLI entry may start one (spawn-argv.ts), so a program that
    // embeds this package as a library cannot turn into a chain of children.
    if (!isCliEntryMarked()) {
      job.reject(
        err.embeddingProviderError(
          "the embedder child can only be started by the obsidian-tc CLI entry",
          {
            hint: 'use embeddings.host "in-process" when the server is embedded in another program',
          },
        ),
      );
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
    armDeadline(running);
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
        // The ready deadline is over; a request already in flight keeps its own deadline.
        clearDeadline(running);
        if (inFlight) armDeadline(running);
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
        clearDeadline(running);
        job.reject(err.embeddingProviderError(message.message));
        pump();
        return;
      }
      case "result":
      case "stats": {
        if (inFlight?.request.id !== message.id) return;
        const job = inFlight;
        inFlight = undefined;
        clearDeadline(running);
        // A successful reply does not clear the death count: a batch that kills its child every time it
        // is tried must still open the circuit when healthy batches run in between.
        probing = false;
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
    clearDeadline(running);
    if (child === running) {
      child = undefined;
      // The exited child's RSS is not the parent's to count against the memory budget.
      lastRssBytes = undefined;
    }
    if (running.stopping) {
      // Asked to stop, or killed by the grace timer. A request still in flight is lost with the child.
      const job = inFlight;
      inFlight = undefined;
      job?.reject(
        err.embeddingProviderError("embedder child stopped before it answered this request"),
      );
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
    armKill(running);
  };

  const snapshot = (): EmbedderHostStats => ({
    state,
    restarts,
    recycles,
    pid: child?.pid,
    rssBytes: lastRssBytes,
    queued: queue.length + (inFlight ? 1 : 0),
  });

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
          if (reply.t === "stats") lastRssBytes = reply.rssBytes;
        } catch {
          /* the last known RSS stands */
        }
      }
      return { ...snapshot(), rssBytes: lastRssBytes };
    },
    snapshot: () => snapshot(),
    close: async () => {
      closed = true;
      rejectQueued(closedError());
      // The grace timer starts now, even with a request in flight: a child that cannot finish within it
      // is killed, and that request rejects rather than keeping the process alive.
      if (child) armKill(child);
      await drain();
    },
  };
}
