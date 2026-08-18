// THE-466 slice 1: the one-shot CLI handlers (run_version, run_doctor, run_forget, etc.) live in
// ./cli/commands/*, and shared dispatch plumbing (Cmd<K>, resolveOrUsageExit, experientialMigrations)
// in ./cli/shared.ts. This file grew 37% (1483 -> 2027) unnoticed before a probe measured it; slice 1
// left dispatch + run_serve at 1278 lines. biome.json's per-file `noExcessiveLinesPerFile` override
// (scoped to this path) is the floor gate so a future regrowth trips `bun run lint` instead.
//
// THE-466 slice 2: run_serve's observability wiring moved to ./runtime/observability.ts.
//
// WP5 (issues 15/16): everything else run_serve used to build inline — stores, governance,
// indexing/watcher, bridge clients, M1-M8 tool registration, plane jobs, the scheduler, the
// transports, and the ordered shutdown — now lives in ./runtime/*.ts, composed by
// `buildServerRuntime` (runtime/server-runtime.ts). `run_serve` below is what is left: resolve the
// config, build the runtime, install the shutdown signal handlers, start. cli.ts's job is argument
// dispatch and process exit — nothing else.

import { parseCliArgs } from "./cli/args";
import { run_activation_recompute } from "./cli/commands/activation-recompute";
import { run_citation_infer } from "./cli/commands/citation-infer";
import { run_cluster } from "./cli/commands/cluster";
import { run_config_explain } from "./cli/commands/config-explain";
import { run_config_show } from "./cli/commands/config-show";
import { run_context_export } from "./cli/commands/context-export";
import { run_context_import } from "./cli/commands/context-import";
import { run_contribution_report } from "./cli/commands/contribution-report";
import { run_densify_llm } from "./cli/commands/densify-llm";
import { run_doctor } from "./cli/commands/doctor";
import { run_elicit_mint } from "./cli/commands/elicit-mint";
import { run_error } from "./cli/commands/error";
import { run_forget } from "./cli/commands/forget";
import { run_gaps } from "./cli/commands/gaps";
import { run_help } from "./cli/commands/help";
import { run_index } from "./cli/commands/index";
import { run_metrics } from "./cli/commands/metrics";
import { run_note_quality } from "./cli/commands/note-quality";
import { run_plugin_install } from "./cli/commands/plugin-install";
import { run_prefetch } from "./cli/commands/prefetch";
import { run_reflect } from "./cli/commands/reflect";
import { run_rerun } from "./cli/commands/rerun";
import { run_token_mint } from "./cli/commands/token-mint";
import { run_version } from "./cli/commands/version";
import { type Cmd, resolveOrUsageExitWithProvenance } from "./cli/shared";
import { buildServerRuntime } from "./runtime/server-runtime";
import { installShutdownSignals } from "./runtime/shutdown";

async function run_serve(cmd: Cmd<"serve">): Promise<void> {
  // THE-825: planeEnabledExplicit gates the boot-time opt-in notice (server-runtime.ts's start()) —
  // whether the raw config file stated `plane.enabled` at all, not merely its resolved value.
  const { config, planeEnabledExplicit } = resolveOrUsageExitWithProvenance(cmd.input);
  const configPath = cmd.input ?? process.env.OBSIDIAN_TC_CONFIG;
  const runtime = await buildServerRuntime(config, configPath, undefined, planeEnabledExplicit);
  installShutdownSignals(runtime);
  await runtime.start();
}

// THE-605 audit classification of every one-shot CLI command dispatched below (verified against
// this exact switch, not re-derived from a grep): 7 are read-only/display (version, help, error,
// plugin-install, config-show/-validate, config-explain, doctor) — nothing to audit. ~9 recompute
// DERIVED state (cluster, activation-recompute, densify-llm, citation-infer, contribution-report,
// note-quality, gaps, metrics, reflect) — real writes, but of RECOMPUTABLE state: a re-run
// reproduces it, so an audit row would be noise (a rewritten cluster assignment is not a loss
// event). `prefetch` dispatches properly through `registry.dispatch` and gets an audit row for
// free. `forget`, `elicit` (THE-826) and `context-export`/`context-import` (THE-636) are the
// commands that write `audit_events` directly rather than through `runDispatch` — `forget` for
// true vault-destructive writes (cli/commands/forget.ts, `auditForgetEvent`), `elicit` because
// minting a HITL confirmation token is itself the security-relevant event worth a record,
// independent of whether the token is ever redeemed (cli/commands/elicit-mint.ts,
// `mintElicitAudited`), and `context-export`/`context-import` because they are the exfiltration
// and untrusted-input surfaces THE-636's design note names (cli/commands/context-export.ts /
// context-import.ts, `auditContextExportEvent` / `auditContextImportEvent`) — see those files for
// the writers and the "why not runDispatch" reasoning. This is a DECISION, not an oversight: do
// not add audit rows to the recompute commands above without re-litigating the "recomputable
// state is not a loss event" premise this classification rests on.
async function main(): Promise<void> {
  const cmd = parseCliArgs(process.argv.slice(2));
  switch (cmd.kind) {
    case "token-mint":
      return run_token_mint(cmd);
    case "elicit-mint":
      return run_elicit_mint(cmd);
    case "version":
      return run_version(cmd);
    case "help":
      return run_help(cmd);
    case "error":
      return run_error(cmd);
    case "plugin-install":
      return run_plugin_install(cmd);
    case "config-show":
    case "config-validate":
      return run_config_show(cmd);
    case "config-explain":
      return run_config_explain(cmd);
    case "doctor":
      return run_doctor(cmd);
    case "cluster":
      return run_cluster(cmd);
    case "activation-recompute":
      return run_activation_recompute(cmd);
    case "densify-llm":
      return run_densify_llm(cmd);
    case "citation-infer":
      return run_citation_infer(cmd);
    case "contribution-report":
      return run_contribution_report(cmd);
    case "note-quality":
      return run_note_quality(cmd);
    case "forget":
      return run_forget(cmd);
    case "context-export":
      return run_context_export(cmd);
    case "context-import":
      return run_context_import(cmd);
    case "gaps":
      return run_gaps(cmd);
    case "index":
      return run_index(cmd);
    case "metrics":
      return run_metrics(cmd);
    case "reflect":
      return run_reflect(cmd);
    case "prefetch":
      return run_prefetch(cmd);
    case "rerun":
      return run_rerun(cmd);
    default:
      return run_serve(cmd);
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
