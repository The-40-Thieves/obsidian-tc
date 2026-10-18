import { bootGitSync } from "../../git-sync/boot";
import { loadGitSyncConfig } from "../../git-sync/env";
import { startServer, superviseGitSync } from "../../git-sync/supervise";
import type { Cmd } from "../shared";

export async function run_git_sync(
  cmd: Cmd<"git-sync">,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "win32") {
    throw new Error("git-sync supports Linux and macOS only (it runs in the -git container image)");
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (cmd.supervise) {
      const status = await superviseGitSync({
        shutdown: controller.signal,
        boot: () => bootGitSync(loadGitSyncConfig()),
        spawnServer: () => startServer(cmd.serverArgs ?? [], process.argv[1] ?? ""),
      });
      if (status !== 0) process.exitCode = status;
      return;
    }
    try {
      const sync = await bootGitSync(loadGitSyncConfig());
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
