import { redactConfig } from "../args";
import { type Cmd, resolveOrUsageExit } from "../shared";

export async function run_config_show(cmd: Cmd<"config-show" | "config-validate">): Promise<void> {
  const resolved = resolveOrUsageExit(cmd.configPath);
  process.stdout.write(
    cmd.kind === "config-show"
      ? `${JSON.stringify(redactConfig(resolved), null, 2)}\n`
      : "config valid\n",
  );
  return;
}
