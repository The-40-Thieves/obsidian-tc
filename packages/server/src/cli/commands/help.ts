import { USAGE } from "../args";
import type { Cmd } from "../shared";

export async function run_help(_cmd: Cmd<"help">): Promise<void> {
  process.stdout.write(USAGE);
  return;
}
