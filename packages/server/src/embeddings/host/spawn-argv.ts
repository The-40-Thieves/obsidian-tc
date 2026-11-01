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

// The parent's runtime flags (process.execArgv, e.g. --smol) go ahead of the entry, so the child runs
// under the same runtime options as the parent. The debugger and watch-mode flags do not: a child given
// the parent's --inspect port clashes with it, --inspect-brk makes the child wait for a debugger, and
// --watch / --hot would restart the child under the parent.
const DEBUGGER_OR_WATCH_FLAG = /^--(inspect(-brk|-wait)?|watch|hot)(=|$)/;

export function selfSpawnArgv(
  entry: string | undefined = process.argv[1],
  execPath: string = process.execPath,
  execArgv: readonly string[] = process.execArgv,
): string[] {
  const runtimeFlags = execArgv.filter((flag) => !DEBUGGER_OR_WATCH_FLAG.test(flag));
  if (!entry || entry.startsWith("/$bunfs/") || entry.startsWith("B:/~BUN")) {
    return [execPath, ...runtimeFlags];
  }
  return [execPath, ...runtimeFlags, entry];
}
