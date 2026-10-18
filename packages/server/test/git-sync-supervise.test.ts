import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../src/cli/args";
import { startServer, superviseGitSync } from "../src/git-sync/supervise";
import { makeTempDir } from "./tmp";

// Real child processes (`node -e`), so exit codes and signals are the platform's own.
const READY = 'process.stdout.write("ready\\n");';
const KEEP_ALIVE = "setInterval(() => {}, 1000);";
const EXIT_ON_TERM = 'process.on("SIGTERM", () => process.exit(0));';
const IGNORE_TERM = 'process.on("SIGTERM", () => {});';

function nodeChild(script: string, stdout: "pipe" | "ignore" = "ignore"): ChildProcess {
  return spawn(process.execPath, ["-e", script], { stdio: ["ignore", stdout, "ignore"] });
}

// A boot that succeeds, and a loop that runs until it is aborted, as bootGitSync's run() does.
function fakeBoot(onStop: () => void = () => {}) {
  return async () => ({
    run: (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener(
          "abort",
          () => {
            onStop();
            resolve();
          },
          { once: true },
        );
      }),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}

describe("git-sync argument parsing", () => {
  it("parses --supervise and hands arguments after -- to the server", () => {
    expect(parseCliArgs(["git-sync", "--supervise", "--", "--config", "c.json"])).toEqual({
      kind: "git-sync",
      once: false,
      supervise: true,
      serverArgs: ["--config", "c.json"],
    });
  });

  it("keeps --once as a one-shot sync", () => {
    expect(parseCliArgs(["git-sync", "--once"])).toMatchObject({ kind: "git-sync", once: true });
  });

  it("refuses --once together with --supervise", () => {
    expect(parseCliArgs(["git-sync", "--once", "--supervise"])).toEqual({
      kind: "error",
      message: "git-sync --once and --supervise cannot be combined",
    });
  });

  it("refuses arguments after -- without --supervise", () => {
    expect(parseCliArgs(["git-sync", "--", "--config", "c.json"])).toEqual({
      kind: "error",
      message: "arguments after -- are passed to the server and need --supervise",
    });
  });

  it("still refuses an unknown git-sync option", () => {
    expect(parseCliArgs(["git-sync", "--bogus"])).toEqual({
      kind: "error",
      message: "unknown option to git-sync: --bogus",
    });
  });
});

describe.skipIf(process.platform === "win32")("git-sync --supervise", () => {
  it("spawns no child and rejects when boot fails", async () => {
    const spawnServer = vi.fn(() => nodeChild(KEEP_ALIVE));
    await expect(
      superviseGitSync({
        shutdown: neverAborted(),
        boot: async () => {
          throw new Error("clone refused");
        },
        spawnServer,
      }),
    ).rejects.toThrow("clone refused");
    expect(spawnServer).not.toHaveBeenCalled();
  });

  it("aborts the loop when the child exits, and exits with the child's code", async () => {
    let loopStopped = false;
    const status = await superviseGitSync({
      shutdown: neverAborted(),
      boot: fakeBoot(() => {
        loopStopped = true;
      }),
      spawnServer: () => nodeChild("process.exit(3)"),
    });
    expect({ status, loopStopped }).toEqual({ status: 3, loopStopped: true });
  });

  it("treats a child that exits 0 on its own as a failure", async () => {
    const status = await superviseGitSync({
      shutdown: neverAborted(),
      boot: fakeBoot(),
      spawnServer: () => nodeChild("process.exit(0)"),
    });
    expect(status).toBe(1);
  });

  it("terminates the child and exits non-zero when the loop throws", async () => {
    let child: ChildProcess | undefined;
    const status = await superviseGitSync({
      shutdown: neverAborted(),
      boot: async () => ({
        run: async () => {
          throw new Error("loop broke");
        },
      }),
      spawnServer: () => (child = nodeChild(KEEP_ALIVE)),
    });
    expect(status).toBe(1);
    expect(child?.signalCode).toBe("SIGTERM");
  });

  it("forwards shutdown to the child as SIGTERM and exits with the child's status", async () => {
    const controller = new AbortController();
    const spawned = deferred<ChildProcess>();
    let loopStopped = false;
    const status = superviseGitSync({
      shutdown: controller.signal,
      boot: fakeBoot(() => {
        loopStopped = true;
      }),
      spawnServer: () => {
        const child = nodeChild(EXIT_ON_TERM + READY + KEEP_ALIVE, "pipe");
        spawned.resolve(child);
        return child;
      },
    });
    const child = await spawned.promise;
    await once(child.stdout as NodeJS.ReadableStream, "data");
    controller.abort();
    expect({ status: await status, loopStopped, signal: child.signalCode }).toEqual({
      status: 0,
      loopStopped: true,
      signal: null,
    });
  });

  it("sends SIGKILL to a child that ignores SIGTERM after the grace period", async () => {
    const controller = new AbortController();
    const spawned = deferred<ChildProcess>();
    const status = superviseGitSync({
      shutdown: controller.signal,
      boot: fakeBoot(),
      graceMs: 200,
      spawnServer: () => {
        const child = nodeChild(IGNORE_TERM + READY + KEEP_ALIVE, "pipe");
        spawned.resolve(child);
        return child;
      },
    });
    const child = await spawned.promise;
    await once(child.stdout as NodeJS.ReadableStream, "data");
    controller.abort();
    expect({ status: await status, signal: child.signalCode }).toEqual({
      status: 137,
      signal: "SIGKILL",
    });
  });

  it("starts the server with the same runtime, the entry script and the server args", async () => {
    const dir = makeTempDir("obtc-supervise-");
    const entry = join(dir, "record-argv.mjs");
    writeFileSync(
      entry,
      'import { writeFileSync } from "node:fs";\n' +
        'import { join } from "node:path";\n' +
        'writeFileSync(join(import.meta.dirname, "argv.json"), JSON.stringify(process.argv.slice(2)));\n',
    );
    const child = startServer(["--config", "a b.json"], entry);
    await once(child, "exit");
    expect(JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"))).toEqual([
      "--config",
      "a b.json",
    ]);
  });
});
