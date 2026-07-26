import { USAGE } from "../args";
import type { Cmd } from "../shared";

export async function run_error(cmd: Cmd<"error">): Promise<void> {
  process.stderr.write(`${cmd.message}\n\n${USAGE}`);
  process.exit(2);
}
