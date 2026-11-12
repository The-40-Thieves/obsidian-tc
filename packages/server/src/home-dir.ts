import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { pickHomeDir } from "@the-40-thieves/reliquary-tc-shared";

/** The per-user folder (`config.json`, default cacheDir): `~/.reliquary-tc`, or `~/.obsidian-tc`
 *  on an install from before 2.0 that has only that folder. Nothing is moved. */
export function defaultHomeDir(): string {
  return pickHomeDir(homedir(), existsSync).dir;
}
