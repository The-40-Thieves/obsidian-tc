// Split out of args.ts (THE-636) so cli/resolve-config.ts can depend on CliError without
// importing args.ts back — the circular-import trap CLAUDE.md documents for a naive line-count
// split ("lift the shared deps and helpers into a third module rather than having the new file
// import from the old one"). args.ts re-exports this so every existing `import { CliError } from
// "../args"` keeps working unchanged.

/** A user-facing CLI error: its message is meant to be printed without a stack trace. */
export class CliError extends Error {
  readonly cli = true;
}
