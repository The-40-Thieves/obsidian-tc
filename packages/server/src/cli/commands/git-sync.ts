import { bootGitSync } from "../../git-sync/boot";
import { loadGitSyncConfig } from "../../git-sync/env";
import type { Cmd } from "../shared";

export async function run_git_sync(cmd: Cmd<"git-sync">): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
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
