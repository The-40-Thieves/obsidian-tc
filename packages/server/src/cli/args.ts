import { CliError } from "./cli-error";
import { type ConsolidateCommand, parseConsolidate } from "./parse-consolidate";
import { type ImportAmbientCommand, parseImportAmbient } from "./parse-import-ambient";
import { type ImportHighlightsCommand, parseImportHighlights } from "./parse-import-highlights";

export type CliCommand =
  | { kind: "serve"; input?: string }
  | { kind: "config-show"; configPath?: string }
  | { kind: "config-validate"; configPath?: string }
  | { kind: "config-explain"; configPath?: string; json?: boolean; source?: string }
  | { kind: "doctor"; configPath?: string; json?: boolean; token?: string; probe?: boolean }
  | {
      kind: "token-mint";
      configPath?: string;
      sub?: string;
      aud?: string;
      vault?: string;
      scopes?: string;
      ttl?: number;
      json?: boolean;
    }
  /** THE-826: `elicit` mints a single-use HITL confirmation token bound to an args_hash an
   *  elicit_required error returned — see cli/commands/elicit-mint.ts for the full design. No
   *  `ttl` field, deliberately: the mint always uses the server's configured elicitTtlSeconds. */
  | {
      kind: "elicit-mint";
      configPath?: string;
      hash?: string;
      tool?: string;
      vault?: string;
      caller?: string;
      json?: boolean;
    }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "plugin-install"; vaultPath: string }
  | { kind: "cluster"; input?: string; k?: number }
  | { kind: "activation-recompute"; input?: string }
  /** THE-697: the derived-state job that had no CLI. `folder` scopes a partial reindex the same way
   *  the index_vault tool's `folder` input does. */
  | { kind: "index"; input?: string; vault?: string; folder?: string }
  | {
      kind: "citation-infer";
      input?: string;
      session?: string;
      since?: number;
      until?: number;
      transcript?: string;
      transcriptIndex?: string;
      maxJudged?: number;
      judgeConcurrency?: number;
      minJudgedForKill?: number;
      allowUncertain?: boolean;
    }
  | { kind: "contribution-report"; input?: string; since?: number; until?: number; json?: string }
  | {
      kind: "note-quality";
      input?: string;
      vault?: string;
      flags?: string[];
      limit?: number;
      suggest?: boolean;
    }
  | { kind: "prefetch"; input?: string; vault?: string; ttlHours?: number }
  | {
      kind: "rerun";
      input?: string;
      sessionId: string;
      vault?: string;
      sandbox?: boolean;
      json?: boolean;
    }
  | { kind: "densify-llm"; input?: string; vault?: string }
  | { kind: "reflect"; input?: string }
  | {
      kind: "metrics";
      input?: string;
      vault?: string;
      since?: number;
      until?: number;
      staleDays?: number;
      json?: string;
    }
  | {
      kind: "gaps";
      input?: string;
      vault?: string;
      queries?: string;
      threshold?: number;
      minResults?: number;
      json?: string;
      calibrate?: string;
    }
  | {
      kind: "forget";
      input?: string;
      vault?: string;
      episode?: string;
      note?: string;
      erase?: boolean;
      verify?: boolean;
    }
  // THE-636: vendor-neutral export/import of the derived plane (experiential.db), CLI-only —
  // see experiential/context-bundle.ts for why this is a CLI command and not an MCP tool.
  | { kind: "context-export"; input?: string; out?: string; vault?: string }
  | {
      kind: "context-import";
      input?: string;
      bundlePath?: string;
      vault?: string;
      dryRun?: boolean;
    }
  // THE-650: pull highlights from a configured read-later source (Readwise first) and stage them
  // in capture_queue (source: "import") for commit_capture review. Parser: ./parse-import-highlights.ts.
  | ImportHighlightsCommand
  | ImportAmbientCommand // THE-175: same shape, ambient screen observations. ./parse-import-ambient.ts.
  // THE-934: evaluate or run one ambient consolidation pass without arming the recurring schedule.
  // Parser: ./parse-consolidate.ts.
  | ConsolidateCommand
  | { kind: "error"; message: string };

// Re-exported so every existing `import { CliError } from "../args"` keeps working unchanged —
// see cli-error.ts's header for why the class itself lives there now.
export { CliError } from "./cli-error";
// THE-636: USAGE moved to ./usage.ts (kept args.ts under biome's noExcessiveLinesPerFile floor —
// see that file's header). Re-exported here so every existing `import { USAGE } from "../args"`
// across cli/commands/* keeps working unchanged.
export { USAGE } from "./usage";

function positional(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

// A value-taking flag (e.g. `--config <path>`). Absent flag -> undefined (the caller falls
// back to a positional / env). Present but with no following token, or a token that is itself
// another flag, is a usage error: throw a CliError that parseCliArgs converts to an `error`
// command, so it can never silently fall through to a positional or to the env fallback.
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("-")) throw new CliError(`${name} requires a value`);
  return v;
}

/** Parse argv already sliced past the node binary + script path into a command. */
export function parseCliArgs(argv: string[]): CliCommand {
  try {
    const [first, ...rest] = argv;
    if (first === undefined) return { kind: "serve" };
    if (first === "version" || first === "--version" || first === "-v") return { kind: "version" };
    if (first === "help" || first === "--help" || first === "-h") return { kind: "help" };
    if (first === "serve") {
      return { kind: "serve", input: flagValue(rest, "--config") ?? positional(rest) };
    }
    // THE-658: `token mint`. Parsed like `config <sub>` — a two-word command with the config path
    // as a positional after the subcommand. Every value-taking flag is stripped before the
    // positional scan so a flag's VALUE can never be mistaken for the config path (the same trap
    // `doctor --token` documents above).
    if (first === "token") {
      const sub = rest[0];
      if (sub !== "mint") throw new CliError(`unknown token subcommand: ${sub ?? "(none)"}`);
      const args = rest.slice(1);
      const valueFlags = ["--sub", "--aud", "--vault", "--scopes", "--ttl", "--config"];
      const scan = args.filter((a, i) => {
        if (a === "--json" || valueFlags.includes(a)) return false;
        const prev = args[i - 1];
        return !(i > 0 && prev !== undefined && valueFlags.includes(prev));
      });
      const ttlRaw = flagValue(args, "--ttl");
      const ttl = ttlRaw === undefined ? undefined : Number(ttlRaw);
      if (ttl !== undefined && !Number.isFinite(ttl)) {
        throw new CliError(`--ttl must be a number of seconds, got: ${ttlRaw}`);
      }
      // Required, and enforced HERE so it exits 2 like every other usage error — `planMint` keeps
      // its own check because it is the unit under test and must refuse on its own terms.
      if (flagValue(args, "--sub") === undefined) {
        throw new CliError("token mint requires --sub (the caller identity)");
      }
      const configPath = flagValue(args, "--config") ?? positional(scan);
      return {
        kind: "token-mint",
        ...(configPath !== undefined ? { configPath } : {}),
        ...(flagValue(args, "--sub") !== undefined ? { sub: flagValue(args, "--sub") } : {}),
        ...(flagValue(args, "--aud") !== undefined ? { aud: flagValue(args, "--aud") } : {}),
        ...(flagValue(args, "--vault") !== undefined ? { vault: flagValue(args, "--vault") } : {}),
        // `--scopes ""` is meaningful (mint with none), so presence is tested, not truthiness.
        ...(args.includes("--scopes") ? { scopes: args[args.indexOf("--scopes") + 1] ?? "" } : {}),
        ...(ttl !== undefined ? { ttl } : {}),
        json: args.includes("--json"),
      };
    }
    // THE-826: `elicit` — mint a single-use HITL confirmation token bound to the args_hash an
    // elicit_required error returned. --hash and --tool are required and enforced HERE (not only
    // in planElicitMint) so a missing one exits 2 like every other usage error — the same
    // duplication `token mint`'s --sub check documents above. No --ttl flag exists at all: the
    // mint always uses the server's configured elicitTtlSeconds, so this parser can never even
    // OFFER a way to mint a longer-lived token than the live server would issue.
    if (first === "elicit") {
      const scan = [...rest];
      for (const f of ["--hash", "--tool", "--vault", "--caller", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const hash = flagValue(rest, "--hash");
      const tool = flagValue(rest, "--tool");
      const vault = flagValue(rest, "--vault");
      const caller = flagValue(rest, "--caller");
      if (hash === undefined) {
        throw new CliError(
          "elicit requires --hash (the args_hash the elicit_required error's details carried)",
        );
      }
      if (tool === undefined) {
        throw new CliError("elicit requires --tool (the tool name the confirmation is for)");
      }
      const configPath = flagValue(rest, "--config") ?? positional(scan);
      return {
        kind: "elicit-mint",
        hash,
        tool,
        ...(configPath !== undefined ? { configPath } : {}),
        ...(vault !== undefined ? { vault } : {}),
        ...(caller !== undefined ? { caller } : {}),
        json: rest.includes("--json"),
      };
    }
    if (first === "config") {
      const sub = rest[0];
      const configPath = flagValue(rest, "--config") ?? positional(rest.slice(1));
      if (sub === "show") return { kind: "config-show", configPath };
      if (sub === "validate") return { kind: "config-validate", configPath };
      // THE-518: `config explain` — the same resolved object as `config show`, but annotated with
      // where each value came from. --source filters to one origin, which is how you answer
      // "what is this deployment actually overriding" in one line.
      if (sub === "explain") {
        const scan = rest.slice(1);
        for (const f of ["--source", "--config"]) {
          const i = scan.indexOf(f);
          if (i >= 0) scan.splice(i, 2);
        }
        const source = flagValue(rest, "--source");
        const VALID = ["env", "file", "profile", "default", "derived"];
        if (source !== undefined && !VALID.includes(source)) {
          return { kind: "error", message: `--source must be one of ${VALID.join("|")}` };
        }
        return {
          kind: "config-explain",
          configPath: flagValue(rest, "--config") ?? positional(scan.filter((a) => a !== "--json")),
          json: rest.includes("--json"),
          ...(source !== undefined ? { source } : {}),
        };
      }
      return { kind: "error", message: `unknown config subcommand: ${sub ?? "(none)"}` };
    }
    if (first === "doctor") {
      // --json and --token are dropped before resolving the positional config path so neither is
      // mistaken for it. --token takes a raw JWT whose iat/exp are read (not verified) by auth.maxAge.
      const json = rest.includes("--json");
      const token = flagValue(rest, "--token");
      // THE-688: --probe is OPT-IN and off by default. Doctor is otherwise offline by construction,
      // and a diagnostic that reaches the network as a side effect of being run is a different tool
      // than the one people reach for when something is already broken.
      const probe = rest.includes("--probe");
      const scan = rest.filter((a, i) => {
        if (a === "--json") return false;
        if (a === "--probe") return false;
        if (a === "--token") return false;
        if (i > 0 && rest[i - 1] === "--token") return false;
        return true;
      });
      const configPath = flagValue(scan, "--config") ?? positional(scan);
      return {
        kind: "doctor",
        ...(configPath !== undefined ? { configPath } : {}),
        json,
        probe,
        ...(token !== undefined ? { token } : {}),
      };
    }
    if (first === "plugin") {
      const sub = rest[0];
      if (sub === "install") {
        const vaultPath = flagValue(rest, "--vault") ?? positional(rest.slice(1));
        if (!vaultPath)
          throw new CliError(
            "plugin install requires a vault: --vault <path> (or a positional path)",
          );
        return { kind: "plugin-install", vaultPath };
      }
      return { kind: "error", message: `unknown plugin subcommand: ${sub ?? "(none)"}` };
    }
    if (first === "cluster") {
      // Parse --k first and drop it (+ its value) so the config positional is unambiguous.
      let k: number | undefined;
      let scan = rest;
      const ki = rest.indexOf("--k");
      if (ki >= 0) {
        const kv = rest[ki + 1];
        if (kv === undefined || kv.startsWith("-")) throw new CliError("--k requires a value");
        k = Number.parseInt(kv, 10);
        if (!Number.isFinite(k) || k < 1)
          return { kind: "error", message: "--k must be a positive integer" };
        scan = rest.filter((_, idx) => idx !== ki && idx !== ki + 1);
      }
      return { kind: "cluster", input: flagValue(scan, "--config") ?? positional(scan), k };
    }
    if (first === "activation-recompute") {
      return {
        kind: "activation-recompute",
        input: flagValue(rest, "--config") ?? positional(rest),
      };
    }
    // THE-697: reindex from the command line. Before this, `obsidian-tc index` parsed as
    // `{ kind: "serve", input: "index" }` — the word was read as a config path, so the CLI's answer
    // to a reindex request was to try to boot a server against a file named `index`.
    if (first === "index") {
      // Strip value-carrying flags before positional(), or `--vault main` makes "main" the config
      // path. Same guard every multi-flag command here already needs.
      const scan = [...rest];
      for (const f of ["--vault", "--folder", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const input = flagValue(rest, "--config") ?? positional(scan);
      const vault = flagValue(rest, "--vault");
      const folder = flagValue(rest, "--folder");
      return {
        kind: "index",
        ...(input !== undefined ? { input } : {}),
        ...(vault !== undefined ? { vault } : {}),
        ...(folder !== undefined ? { folder } : {}),
      };
    }
    // Graph densification LLM Pass-3 batch runner.
    if (first === "densify-llm") {
      const scan = [...rest];
      for (const f of ["--vault", "--config", "--batch-size", "--confidence-floor"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const vault = flagValue(rest, "--vault");
      return {
        kind: "densify-llm",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(vault !== undefined ? { vault } : {}),
      };
    }
    // THE-170: on-demand citation inference over a session transcript.
    if (first === "citation-infer") {
      const num = (flag: string): number | undefined => {
        const v = flagValue(rest, flag);
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new CliError(`${flag} must be a number`);
        return n;
      };
      // Strip value-carrying flags so positional() cannot mistake a flag value for the config.
      const scan = [...rest];
      for (const f of [
        "--session",
        "--since",
        "--until",
        "--transcript",
        "--transcript-index",
        "--max-judged",
        "--judge-concurrency",
        "--min-judged-for-kill",
        "--config",
      ]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const session = flagValue(rest, "--session");
      const since = num("--since");
      const until = num("--until");
      const transcript = flagValue(rest, "--transcript");
      const transcriptIndex = flagValue(rest, "--transcript-index");
      // THE-617 item 3: caps how many stage-1 survivors reach the judge, against this command's
      // own MAX_JUDGED (see citation.ts's InferCitationsOptions). THE-747: `reflect` used to carry
      // an identically-shaped flag; THE-701 deleted the judge it capped, so this is now the only
      // --max-judged in the CLI and there is no second knob to keep it distinct from.
      const mv = flagValue(rest, "--max-judged");
      let maxJudged: number | undefined;
      if (mv !== undefined) {
        maxJudged = Number.parseInt(mv, 10);
        if (!Number.isFinite(maxJudged) || maxJudged < 0)
          return { kind: "error", message: "--max-judged must be a non-negative integer" };
      }
      // THE-621 items 1 and 2: the stage-2 fan-out cap and the kill-switch floor, same --flag shape
      // as --max-judged above.
      //
      // Both reject 0, where --max-judged accepts it. That is not an inconsistency: judging 0
      // survivors is a meaningful instruction, but a fan-out of 0 sends nothing and a kill floor of
      // 0 cannot be reached by `judged >= floor`. citation.ts clamps both with Math.max(1, ...), so
      // accepting 0 here would silently hand back a 1 the operator did not ask for — a typo should
      // be an error, not a quiet default.
      const posInt = (flag: string): number | undefined | { kind: "error"; message: string } => {
        const raw = flagValue(rest, flag);
        if (raw === undefined) return undefined;
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 1)
          return { kind: "error", message: `${flag} must be a positive integer` };
        return n;
      };
      const jc = posInt("--judge-concurrency");
      if (jc !== undefined && typeof jc === "object") return jc;
      const mjk = posInt("--min-judged-for-kill");
      if (mjk !== undefined && typeof mjk === "object") return mjk;
      // Boolean flag: deliberately NOT added to the value-carrying strip list above — it takes no
      // argument, so splicing two entries would eat the following positional.
      const allowUncertain = rest.includes("--allow-uncertain");
      return {
        kind: "citation-infer",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(session !== undefined ? { session } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(transcript !== undefined ? { transcript } : {}),
        ...(transcriptIndex !== undefined ? { transcriptIndex } : {}),
        ...(allowUncertain ? { allowUncertain } : {}),
        ...(maxJudged !== undefined ? { maxJudged } : {}),
        ...(jc !== undefined ? { judgeConcurrency: jc } : {}),
        ...(mjk !== undefined ? { minJudgedForKill: mjk } : {}),
      };
    }
    // THE-249: per-note output-contribution report over the experiential telemetry.
    if (first === "contribution-report") {
      const num = (flag: string): number | undefined => {
        const v = flagValue(rest, flag);
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new CliError(`${flag} must be a number`);
        return n;
      };
      const scan = [...rest];
      for (const f of ["--since", "--until", "--json", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const since = num("--since");
      const until = num("--until");
      const json = flagValue(rest, "--json");
      return {
        kind: "contribution-report",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(json !== undefined ? { json } : {}),
      };
    }
    // THE-537: recompute the note_quality rollup and print the flagged notes.
    // THE-643 item 2: --suggest additionally prints a remediation line per flag. A boolean flag
    // (no value token), so it is filtered out of `scan` by presence, not by the pair-splice loop
    // below (mirrors --erase/--verify on `forget`).
    if (first === "note-quality") {
      const scan = [...rest].filter((a) => a !== "--suggest");
      for (const f of ["--vault", "--flags", "--limit", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const limitRaw = flagValue(rest, "--limit");
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        throw new CliError("--limit must be a positive number");
      }
      const flagsRaw = flagValue(rest, "--flags");
      const flags = flagsRaw
        ?.split(",")
        .map((f) => f.trim())
        .filter(Boolean);
      const vault = flagValue(rest, "--vault");
      const suggest = rest.includes("--suggest");
      return {
        kind: "note-quality",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(vault !== undefined ? { vault } : {}),
        ...(flags && flags.length > 0 ? { flags } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(suggest ? { suggest } : {}),
      };
    }
    // THE-239: dependency-aware deletion — forget an episode or propagate a note deletion.
    if (first === "forget") {
      const scan = [...rest].filter((a) => a !== "--erase" && a !== "--verify");
      for (const f of ["--episode", "--note", "--vault", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const episode = flagValue(rest, "--episode");
      const note = flagValue(rest, "--note");
      const vault = flagValue(rest, "--vault");
      return {
        kind: "forget",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(episode !== undefined ? { episode } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(vault !== undefined ? { vault } : {}),
        ...(rest.includes("--erase") ? { erase: true } : {}),
        ...(rest.includes("--verify") ? { verify: true } : {}),
      };
    }
    // THE-636: export the derived plane (experiential.db's 9 tables) as a vendor-neutral bundle.
    if (first === "context-export") {
      const scan = [...rest];
      for (const f of ["--out", "--vault", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const out = flagValue(rest, "--out");
      const vault = flagValue(rest, "--vault");
      const input = flagValue(rest, "--config") ?? positional(scan);
      return {
        kind: "context-export",
        ...(input !== undefined ? { input } : {}),
        ...(out !== undefined ? { out } : {}),
        ...(vault !== undefined ? { vault } : {}),
      };
    }
    // THE-636: import a context-export bundle. Positional order is `<bundle-path> [config-path]`,
    // the same shape `rerun`'s `<session-id> [path]` already establishes for this CLI — the
    // bundle path is required and always comes first, so it is taken as the FIRST non-flag token
    // rather than via flagValue/positional's usual "config is the only positional" assumption.
    if (first === "context-import") {
      const scan = [...rest].filter((a) => a !== "--dry-run");
      for (const f of ["--vault", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const bundlePath = scan.find((a) => !a.startsWith("-"));
      if (bundlePath !== undefined) scan.splice(scan.indexOf(bundlePath), 1);
      const vault = flagValue(rest, "--vault");
      const input = flagValue(rest, "--config") ?? positional(scan);
      return {
        kind: "context-import",
        ...(bundlePath !== undefined ? { bundlePath } : {}),
        ...(input !== undefined ? { input } : {}),
        ...(vault !== undefined ? { vault } : {}),
        ...(rest.includes("--dry-run") ? { dryRun: true } : {}),
      };
    }
    // THE-650: import-highlights. Parse branch delegates to ./parse-import-highlights.ts —
    // see args.ts's top-of-file import comment for why it lives there rather than inline here.
    if (first === "import-highlights") return parseImportHighlights(rest);
    if (first === "import-ambient") return parseImportAmbient(rest);
    // THE-934: consolidate --once [--dry-run] [--config <path>].
    if (first === "consolidate") return parseConsolidate(rest);
    // THE-48: knowledge-gap detector over a batch of queries, or golden-set calibration.
    if (first === "gaps") {
      const num = (flag: string): number | undefined => {
        const v = flagValue(rest, flag);
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new CliError(`${flag} must be a number`);
        return n;
      };
      const scan = [...rest];
      for (const f of [
        "--vault",
        "--queries",
        "--threshold",
        "--min-results",
        "--json",
        "--calibrate",
        "--config",
      ]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const vault = flagValue(rest, "--vault");
      const queries = flagValue(rest, "--queries");
      const threshold = num("--threshold");
      const minResults = num("--min-results");
      const json = flagValue(rest, "--json");
      const calibrate = flagValue(rest, "--calibrate");
      return {
        kind: "gaps",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(vault !== undefined ? { vault } : {}),
        ...(queries !== undefined ? { queries } : {}),
        ...(threshold !== undefined ? { threshold } : {}),
        ...(minResults !== undefined ? { minResults } : {}),
        ...(json !== undefined ? { json } : {}),
        ...(calibrate !== undefined ? { calibrate } : {}),
      };
    }
    // THE-44/46: knowledge-health scorecard over the derive layer (chunk_access_stats).
    if (first === "metrics") {
      const num = (flag: string): number | undefined => {
        const v = flagValue(rest, flag);
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new CliError(`${flag} must be a number`);
        return n;
      };
      const scan = [...rest];
      for (const f of ["--vault", "--since", "--until", "--stale-days", "--json", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const vault = flagValue(rest, "--vault");
      const since = num("--since");
      const until = num("--until");
      const staleDays = num("--stale-days");
      const json = flagValue(rest, "--json");
      return {
        kind: "metrics",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(vault !== undefined ? { vault } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(staleDays !== undefined ? { staleDays } : {}),
        ...(json !== undefined ? { json } : {}),
      };
    }
    // THE-222: sleep-time reflect — episode-eligibility evaluator + preference-profile update.
    if (first === "reflect") {
      // THE-747/THE-701: `--max-judged` no longer applies to `reflect` — history in CHANGELOG.md.
      // citation-infer's --max-judged is a separate, live knob, unaffected by this.
      //
      // Rejected rather than silently ignored, for the reason the `token mint` branch documents:
      // the positional scan takes the first non-dash token, so dropping the flag would leave its
      // VALUE behind and `reflect --max-judged 5` would resolve the config path to "5".
      if (rest.includes("--max-judged"))
        return {
          kind: "error",
          message:
            "--max-judged is no longer supported on `reflect`: THE-701 removed the episode-eligibility judge it capped, and the pass is now purely deterministic. The citation-infer command's --max-judged is unaffected.",
        };
      const scan = [...rest];
      const i = scan.indexOf("--config");
      if (i >= 0) scan.splice(i, 2);
      return { kind: "reflect", input: flagValue(rest, "--config") ?? positional(scan) };
    }
    // THE-136: anticipatory prefetch — compose the bootstrap bundle and write the prewarm cache.
    if (first === "prefetch") {
      const scan = [...rest];
      for (const f of ["--vault", "--ttl-hours", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const vault = flagValue(rest, "--vault");
      const tv = flagValue(rest, "--ttl-hours");
      let ttlHours: number | undefined;
      if (tv !== undefined) {
        ttlHours = Number(tv);
        if (!Number.isFinite(ttlHours) || ttlHours <= 0)
          return { kind: "error", message: "--ttl-hours must be a positive number" };
      }
      return {
        kind: "prefetch",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(vault !== undefined ? { vault } : {}),
        ...(ttlHours !== undefined ? { ttlHours } : {}),
      };
    }
    // THE-645 item 3: re-issue a recorded session's captured arguments.
    if (first === "rerun") {
      const scan = [...rest];
      for (const f of ["--vault", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const sessionId = scan.find((a) => !a.startsWith("-"));
      if (sessionId === undefined) return { kind: "error", message: "rerun requires a session id" };
      // Drop the session id itself out of `scan` so the SECOND non-flag positional -- the config
      // path USAGE documents (`rerun <session-id> [path] ...`) -- can be found the same way every
      // sibling command finds its config path: `flagValue(rest, "--config") ?? positional(scan)`
      // (see `prefetch` just above). Without this, `scan.find` above never advances past the
      // session id, so a path positional silently falls through to OBSIDIAN_TC_CONFIG/the default.
      scan.splice(scan.indexOf(sessionId), 1);
      const vault = flagValue(rest, "--vault");
      const input = flagValue(rest, "--config") ?? positional(scan);
      return {
        kind: "rerun",
        sessionId,
        ...(input !== undefined ? { input } : {}),
        ...(vault !== undefined ? { vault } : {}),
        ...(rest.includes("--sandbox") ? { sandbox: true } : {}),
        ...(rest.includes("--json") ? { json: true } : {}),
      };
    }
    if (first.startsWith("-")) return { kind: "error", message: `unknown option: ${first}` };
    return { kind: "serve", input: first };
  } catch (e) {
    // Keep parseCliArgs total: a usage CliError (e.g. `--config` with no value) becomes an
    // `error` command so cli.ts prints the message + usage and exits 2, never `fatal:`/exit 1.
    if (e instanceof CliError) return { kind: "error", message: e.message };
    throw e;
  }
}

export { redactConfig } from "./redact-config";
// THE-636: config-target resolution (configFromVaultPath, ResolvedServeConfig,
// resolveServeConfigWithProvenance, resolveServeConfig) moved to ./resolve-config.ts, and
// redactConfig to ./redact-config.ts — both kept args.ts under biome's noExcessiveLinesPerFile
// floor. Re-exported so every existing `import { ... } from "../args"` keeps working unchanged.
export {
  configFromVaultPath,
  type ResolvedServeConfig,
  resolveServeConfig,
  resolveServeConfigWithProvenance,
} from "./resolve-config";
