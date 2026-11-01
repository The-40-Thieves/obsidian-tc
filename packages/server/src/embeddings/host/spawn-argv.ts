// GH #1433 rec 4, step 2: the argv that re-runs this program as the embedder child. A script re-runs
// under the same runtime; a compiled binary is its own entry, because Bun's virtual FS path cannot be
// executed (its Windows form is B:/~BUN/...).

export function selfSpawnArgv(
  entry: string | undefined = process.argv[1],
  execPath: string = process.execPath,
): string[] {
  if (!entry || entry.startsWith("/$bunfs/") || entry.startsWith("B:/~BUN")) {
    return [execPath];
  }
  return [execPath, entry];
}
