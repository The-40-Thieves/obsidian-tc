// Split out of args.ts (THE-1082 fix round 3, GH #945) to stay under biome's
// noExcessiveLinesPerFile floor — the same shape as cli-error.ts's own extraction. `positional`
// and `flagValue` are pure argv-scanning helpers with no coupling to CliCommand or any specific
// subcommand, so lifting them here adds no circular import back into args.ts.
import { CliError } from "./cli-error";

/** The first token that is not itself a flag (does not start with `-`). */
export function positional(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

// A value-taking flag (e.g. `--config <path>`). Absent flag -> undefined (the caller falls
// back to a positional / env). Present but with no following token, or a token that is itself
// another flag, is a usage error: throw a CliError that parseCliArgs converts to an `error`
// command, so it can never silently fall through to a positional or to the env fallback.
//
// THE-1082 fix round 3 (GH #945): also accepts `--flag=value`, generically, for every flag routed
// through here — the ONLY way to pass a value starting with `-` (a configured vault id may;
// VaultConfigSchema.id has no character restriction), since the space form below must refuse a
// following token starting with `-` (it would otherwise swallow the NEXT flag). error-rendering.ts's
// `renderFlag` emits this form exactly when a value starts with `-`.
export function flagValue(args: string[], name: string): string | undefined {
  const eqPrefix = `${name}=`;
  const eqToken = args.find((a) => a.startsWith(eqPrefix));
  if (eqToken !== undefined) return eqToken.slice(eqPrefix.length);
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("-")) throw new CliError(`${name} requires a value`);
  return v;
}
