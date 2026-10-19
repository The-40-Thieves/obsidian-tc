// Git auto maintenance switched off through the environment, shared by the temp-dir guard
// (with-tmp-guard.mjs) and the server suite's vitest setup (packages/server/test).
//
// A commit or merge starts a detached `git maintenance run --auto`. That child can outlive the
// command or test that made the repo and write into a fixture directory after it was removed.
// `maintenance.auto=false` is passed as GIT_CONFIG_COUNT/KEY/VALUE, so git reads it with no
// config file, and any child that inherits the environment inherits it too.

/**
 * Returns a copy of `env` with git auto maintenance disabled. Existing GIT_CONFIG_COUNT entries are
 * kept; the new entry goes last, so it wins. Idempotent: when the last `maintenance.auto` entry is
 * already "false", the copy is returned unchanged, so applying it twice never stacks a second one.
 */
export function withGitMaintenanceOff(env) {
  const count = /^\d+$/.test(env.GIT_CONFIG_COUNT ?? "") ? Number(env.GIT_CONFIG_COUNT) : 0;
  let disabled = false;
  for (let i = 0; i < count; i++) {
    if (env[`GIT_CONFIG_KEY_${i}`] === "maintenance.auto") {
      disabled = env[`GIT_CONFIG_VALUE_${i}`] === "false";
    }
  }
  if (disabled) return { ...env };
  return {
    ...env,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: "maintenance.auto",
    [`GIT_CONFIG_VALUE_${count}`]: "false",
  };
}
