import { lstatSync, mkdirSync, type Stats } from "node:fs";
import { dirname, join, normalize, parse, relative, sep } from "node:path";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { existsNoFollow } from "../auth/key-files";
import { folderRootForSink, vaultDetailPath } from "./folder-links";
import { assertCreatableName } from "./paths";

export interface WalkedDirectory {
  path: string;
  component: string;
  dev: number;
  ino: number;
}

interface WalkOptions {
  create: boolean;
  beforeCreate?: (component: string) => void;
  onSymlink: (component: string) => never;
  onNotDirectory: (component: string) => never;
}

const componentsBelow = (path: string, root: string): string[] =>
  path
    .slice(root.length)
    .split(sep)
    .filter((component) => component !== "");

/** Walk a directory path with lstat only. Reads and writes supply their own refusal codes. */
export function walkDirectoriesNoFollow(dir: string, options: WalkOptions): WalkedDirectory[] {
  const path = normalize(dir);
  const knownRoot = folderRootForSink(path);
  const root = knownRoot ?? parse(path).root;
  const walked: WalkedDirectory[] = [];
  let current = root;
  const components = componentsBelow(path, root);
  const entries = knownRoot === undefined ? components : ["", ...components];

  for (const component of entries) {
    if (component !== "") current = join(current, component);
    let stat: Stats | null;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.create) throw error;
      stat = null;
    }
    if (stat === null) {
      options.beforeCreate?.(component);
      try {
        mkdirSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink()) options.onSymlink(component);
    if (!stat.isDirectory()) options.onNotDirectory(component);
    walked.push({ path: current, component, dev: stat.dev, ino: stat.ino });
  }
  return walked;
}

/** Re-lstat the captured directories after open and refuse any replacement or type change. */
export function verifyWalkedDirectories(
  walked: readonly WalkedDirectory[],
  onChanged: (component: string) => never,
): void {
  for (const expected of walked) {
    let current: Stats;
    try {
      current = lstatSync(expected.path);
    } catch {
      onChanged(expected.component);
    }
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) {
      onChanged(expected.component);
    }
  }
}

/** The folders a write under a pinned folder would create below `pinned.dir`, each checked as
 *  `ensureDirNoFollow` checks a new folder (a Windows-hostile name is refused). The native write makes
 *  them; this check only refuses a name before it is attempted. */
export function assertPinnedFolderNames(
  path: string,
  pinned: { readonly dir: string },
  capable: boolean,
): void {
  if (!capable)
    throw err.aclDenied("this native module predates creating folders under a pinned folder", {
      path: vaultDetailPath(path),
    });
  let prefix = pinned.dir;
  for (const segment of relative(pinned.dir, dirname(path)).split(sep).filter(Boolean)) {
    prefix = join(prefix, segment);
    if (!existsNoFollow(prefix)) assertCreatableName(segment, segment);
  }
}
