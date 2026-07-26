import { version as VERSION } from "../../../package.json";
import type { Cmd } from "../shared";

export async function run_version(_cmd: Cmd<"version">): Promise<void> {
  process.stdout.write(`${VERSION}\n`);
  return;
}
