// GH #1433 rec 4, step 2: the argv that re-runs this program as the embedder child. A script re-runs
// under the same runtime; a compiled binary is its own entry, because Bun's virtual FS path cannot be
// executed (its Windows form is B:/~BUN/...).

// The CLI entry (cli.ts main) marks itself before any host can spawn. selfSpawnArgv re-runs argv[1], so a
// program that is not the CLI (an eval script, one that embeds the package as a library) must never start
// a child: the child would be that program, free to embed again before it answers.
let cliEntry = false;

export function markCliEntry(): void {
  cliEntry = true;
}

export function isCliEntryMarked(): boolean {
  return cliEntry;
}

export function selfSpawnArgv(
  entry: string | undefined = process.argv[1],
  execPath: string = process.execPath,
): string[] {
  if (!entry || entry.startsWith("/$bunfs/") || entry.startsWith("B:/~BUN")) {
    return [execPath];
  }
  return [execPath, entry];
}
