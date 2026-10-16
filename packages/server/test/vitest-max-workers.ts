export function resolveVitestMaxWorkers(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.VITEST_MAX_WORKERS?.trim();
  if (raw !== undefined && raw !== "") {
    const workers = Number(raw);
    if (!Number.isInteger(workers) || workers < 1)
      throw new Error(`VITEST_MAX_WORKERS must be a positive integer, got "${raw}"`);
    return workers;
  }
  return env.CI ? undefined : 2;
}
