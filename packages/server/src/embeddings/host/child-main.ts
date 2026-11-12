// GH #1433 rec 4, step 2: the embedder child. cli.ts runs this instead of the CLI when a parent spawned
// it with RELIQUARY_TC_EMBEDDER_HOST=1 (child-process.ts). It loads the local embedder through the same
// resolution ladder as the in-process host and answers the protocol (protocol.ts) on the given streams.
// Its stdout IS the protocol channel, so everything else it logs goes to stderr.
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { loadLocalEmbedderProvider } from "../../providers/local-embedder-registry";
import type { LoadedEmbedder } from "./in-process";
import {
  type ChildMessage,
  type EmbedderInitOpts,
  encodeMessage,
  type ParentMessage,
  parseMessage,
} from "./protocol";

export interface ChildIo {
  input: Readable;
  output: { write(chunk: string): unknown };
}

export type LoadEmbedder = (opts: EmbedderInitOpts) => Promise<LoadedEmbedder>;

/** The local embedder, resolved exactly as the in-process host resolves it. */
export const loadLocalEmbedder: LoadEmbedder = loadLocalEmbedderProvider;

/** Serves the protocol until stdin closes or the parent sends shutdown. Lines are answered in order:
 *  the parent sends one request at a time, and the model is single-threaded. */
export async function runEmbedderChild(
  io: ChildIo,
  load: LoadEmbedder = loadLocalEmbedder,
): Promise<void> {
  // The flag that started this child must not reach the model stack: a child that inherits it would
  // treat any child it starts as another embedder child.
  delete process.env.RELIQUARY_TC_EMBEDDER_HOST;
  const restoreConsole = routeConsoleToStderr();
  const reply = (message: ChildMessage): void => {
    io.output.write(encodeMessage(message));
  };
  let embedder: LoadedEmbedder | undefined;
  let stopped = false;
  let stop: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    stop = resolve;
  });

  const handle = async (line: string): Promise<void> => {
    if (stopped) return;
    let message: ParentMessage;
    try {
      message = parseMessage(line) as ParentMessage;
    } catch (error) {
      console.error(`embedder child: ignored a line from the parent: ${errorText(error)}`);
      return;
    }
    switch (message.t) {
      case "init":
        try {
          embedder = await load(message.opts);
          reply({ t: "ready", v: 1, pid: process.pid });
        } catch (error) {
          reply({ t: "error", v: 1, id: "init", message: errorText(error) });
          stopped = true;
          stop();
        }
        return;
      case "embed":
        if (!embedder) {
          reply({ t: "error", v: 1, id: message.id, message: "embed before init" });
          return;
        }
        try {
          const vectors = await embedder.embed(message.texts, message.opts);
          reply({ t: "result", v: 1, id: message.id, vectors });
        } catch (error) {
          reply({ t: "error", v: 1, id: message.id, message: errorText(error) });
        }
        return;
      case "stats":
        reply({ t: "stats", v: 1, id: message.id, rssBytes: process.memoryUsage().rss });
        return;
      case "shutdown":
        stopped = true;
        stop();
        return;
    }
  };

  let chain: Promise<void> = Promise.resolve();
  const lines = createInterface({ input: io.input, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (line) => {
    chain = chain.then(() => handle(line));
  });
  // The parent closing our stdin means the parent is gone: finish what is queued, then return.
  lines.on("close", () => {
    chain = chain.then(() => stop());
  });
  try {
    await finished;
  } finally {
    lines.close();
    restoreConsole();
  }
}

// Every console method that writes to stdout (node and bun alike): the model stack may log with any of
// them, and one stray line on stdout breaks the protocol. console.trace and console.warn already write
// to stderr.
const STDOUT_CONSOLE_METHODS = [
  "log",
  "info",
  "debug",
  "dir",
  "dirxml",
  "table",
  "group",
  "groupCollapsed",
  "groupEnd",
  "count",
  "countReset",
  "time",
  "timeEnd",
  "timeLog",
] as const;

/** Routes the stdout console methods to stderr for the child's lifetime. Returns the restore function
 *  (tests run this in-process). */
function routeConsoleToStderr(): () => void {
  const target = console as unknown as Record<(typeof STDOUT_CONSOLE_METHODS)[number], unknown>;
  const saved = STDOUT_CONSOLE_METHODS.map((name) => [name, target[name]] as const);
  const toStderr = (...args: unknown[]): void => console.error(...args);
  for (const name of STDOUT_CONSOLE_METHODS) target[name] = toStderr;
  return () => {
    for (const [name, method] of saved) target[name] = method;
  };
}

// The protocol carries one message string, so the hint an error carries (its details.hint, e.g. the
// install command for a missing embedder) is appended to it: the parent sees it in its own error.
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const hint = (error as { details?: { hint?: unknown } }).details?.hint;
  return typeof hint === "string" ? `${error.message} (${hint})` : error.message;
}
