// The one place the `obsidian-tc elicit` mint command is rendered. Both channels a model can read
// an `elicit_required` refusal from (the text block, error-rendering.ts, and the structured
// `recovery`, elicit-form.ts) build it here, so they cannot drift apart.

/** A bare token safe to interpolate into a shell command with no quoting at all. Deliberately
 *  narrow (alnum + a few path/id-shaped punctuation marks) — anything else, including a space,
 *  gets single-quoted below rather than risk missing a metacharacter. */
const SAFE_BARE_ARG = /^[A-Za-z0-9_.:@/-]+$/;

/** THE-1082 fix round 2 (Codex cross-vendor review): shell-quote a value before it goes into the
 *  rendered command line. Neither `tool` nor `vault` is guaranteed shell-safe text: `ctx.vaultId`
 *  (`CallerContext`, `mcp/registry/types.ts`) is a plain `string`, sourced from the vault's
 *  CONFIGURED `id` (`VaultConfigSchema.id`, `packages/shared/src/config/vault.schema.ts` —
 *  `z.string().min(1)`, no character restriction) — NOT the stricter `VaultId` regex primitive
 *  (`^[a-z0-9_-]+$`, `schemas/primitives.ts`) that constrains a TOOL's own `vault` ARGUMENT. A
 *  configured id can legally contain a space, a quote, or a `$(...)` substring. `tool` is an
 *  internal registered-tool name today, never caller-controlled, but is quoted for the same
 *  reason and because nothing here can prove that stays true at every call site forever. Bare only
 *  when the whole value is already shell-safe (`SAFE_BARE_ARG`); otherwise single-quoted, with any
 *  embedded `'` closed-escaped-reopened (`'\''`) — the one escape a single-quoted POSIX/zsh/bash
 *  string needs, since nothing else is special inside one. */
export function shellQuote(value: string): string {
  return SAFE_BARE_ARG.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/** THE-1082 fix round 3 (second cross-vendor review round): render one `--flag value` pair,
 *  choosing the `--flag=value` form whenever `value` starts with `-`. A configured vault id MAY
 *  start with `-` (`VaultConfigSchema.id` allows it, and `SAFE_BARE_ARG` above happily treats `-`
 *  as bare-safe), so e.g. a vault named `-prod` rendered as `--vault -prod` passes a real shell
 *  through untouched — shell quoting cannot help here, since the shell already stripped it before
 *  `obsidian-tc` ever sees argv — but `cli/args.ts`'s `flagValue` then reads the NEXT token
 *  (`-prod`) as itself another flag and refuses with "requires a value". The `=` form sidesteps
 *  that: `flagValue` now recognises `--flag=value` as one token, so `-prod` never has to look like
 *  a free-standing argv element. Used unconditionally for every rendered flag (not just `--vault`)
 *  since nothing here can promise `tool`/`args_hash` will never start with `-` either. */
function renderFlag(flag: string, value: string): string {
  const quoted = shellQuote(value);
  return value.startsWith("-") ? `${flag}=${quoted}` : `${flag} ${quoted}`;
}

/** The concrete `obsidian-tc elicit` invocation for one refused call: hash and tool always, vault,
 *  caller and state fingerprint when the error carried them. `--caller` matters: the CLI defaults
 *  it to `stdio`, and redemption refuses a token minted for a different caller than the one that
 *  made the call. `--state-fp` binds the minted token to the state THIS request was raised against:
 *  a blocked call repeated after its target changed records a newer fingerprint under the same
 *  (vault, args_hash, caller), and without the flag an earlier command would approve that newer
 *  state instead of drifting. */
export function renderElicitMintCommand(parts: {
  hash: string;
  tool: string;
  vault?: string;
  caller?: string;
  stateFp?: string;
}): string {
  return (
    `obsidian-tc elicit ${renderFlag("--hash", parts.hash)} ${renderFlag("--tool", parts.tool)}` +
    (parts.vault !== undefined ? ` ${renderFlag("--vault", parts.vault)}` : "") +
    (parts.caller !== undefined ? ` ${renderFlag("--caller", parts.caller)}` : "") +
    (parts.stateFp !== undefined ? ` ${renderFlag("--state-fp", parts.stateFp)}` : "")
  );
}

/** `renderElicitMintCommand` over an `elicit_required` error's `details` (`args_hash`, `tool`,
 *  and the optional `vault`/`caller`/`state_fp`), or undefined when either required part is missing. */
export function mintCommandFromDetails(
  details: Record<string, unknown> | undefined,
): string | undefined {
  const { args_hash: hash, tool, vault, caller, state_fp: stateFp } = details ?? {};
  if (typeof hash !== "string" || typeof tool !== "string") return undefined;
  return renderElicitMintCommand({
    hash,
    tool,
    ...(typeof vault === "string" ? { vault } : {}),
    ...(typeof caller === "string" ? { caller } : {}),
    ...(typeof stateFp === "string" ? { stateFp } : {}),
  });
}
