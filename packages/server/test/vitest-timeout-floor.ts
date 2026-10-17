// Timeout floor for the macOS Intel CI legs. Unset or empty keeps today's values; a positive
// integer raises the non-Windows per-test, hook and spawn budgets to at least that many ms.
export function resolveVitestTimeoutFloorMs(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.VITEST_TIMEOUT_FLOOR_MS?.trim();
  if (raw !== undefined && raw !== "") {
    const floor = Number(raw);
    if (!Number.isInteger(floor) || floor < 1)
      throw new Error(`VITEST_TIMEOUT_FLOOR_MS must be a positive integer, got "${raw}"`);
    return floor;
  }
  return undefined;
}
