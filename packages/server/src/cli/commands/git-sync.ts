import type { ChildProcess } from "node:child_process";
import { bootGitSync } from "../../git-sync/boot";
import { loadGitSyncConfig } from "../../git-sync/env";
import { startServer, superviseGitSync } from "../../git-sync/supervise";
import type { Cmd } from "../shared";

/** Collaborators the command runs with; the defaults are the real boot, supervisor and server. */
export interface GitSyncCommandDeps {
  boot?: typeof bootGitSync;
  supervise?: typeof superviseGitSync;
  spawnServer?: () => ChildProcess;
}

export async function run_git_sync(
  cmd: Cmd<"git-sync">,
  platform: NodeJS.Platform = process.platform,
  deps: GitSyncCommandDeps = {},
): Promise<void> {
  if (platform === "win32") {
    throw new Error("git-sync supports Linux and macOS only (it runs in the -git container image)");
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  // `on`, not `once`: abort is idempotent, and a second signal must not fall through to the default
  // handler (which would kill this launcher before the child is reaped).
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const boot = deps.boot ?? bootGitSync;
  try {
    if (cmd.supervise) {
      const status = await (deps.supervise ?? superviseGitSync)({
        shutdown: controller.signal,
        boot: () => boot(loadGitSyncConfig(), { signal: controller.signal }),
        spawnServer:
          deps.spawnServer ?? (() => startServer(cmd.serverArgs ?? [], process.argv[1] ?? "")),
      });
      if (status !== 0) process.exitCode = status;
      return;
    }
    try {
      const sync = await boot(loadGitSyncConfig(), { signal: controller.signal });
      if (cmd.once || controller.signal.aborted) return;
      await sync.run(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
