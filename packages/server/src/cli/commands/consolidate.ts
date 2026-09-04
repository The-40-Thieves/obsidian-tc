// THE-934 — `obsidian-tc consolidate --once [--dry-run]`. The CLI-only trigger Gate 1's revision
// and Gate 2's design settled on: an operator can evaluate what one ambient consolidation pass
// would do (`--dry-run`, ZERO gateway calls) or actually run it once (`--once` alone), without
// arming the recurring `plane.intervalMinutes` schedule just to find out. CLI-only, deliberately —
// an MCP tool exposing the same trigger would be the unattended, agent-callable behaviour this
// ticket exists to keep OFF the egress path (Gate 1 revision, point 3).
//
// Runs the SAME job functions the durable scheduler uses (runSynthesis / auditJob.run from
// plane/jobs/*), not a copy — a CLI-only reimplementation would drift from what the scheduler
// actually does the same way the pre-THE-717 citation CLI/job split did (see citation-index.ts's
// header for that history). `--dry-run` calls planSynthesis instead, which shares runSynthesis'
// gather/filter logic but stops before the one call that reaches the gateway.
import { mkdirSync } from "node:fs";
import { version as VERSION } from "../../../package.json";
import { provisionExperientialDb } from "../../db/experiential";
import { openConfiguredDatabase } from "../../db/open";
import { provisionCacheDb } from "../../db/provision";
import { countCitationCandidates } from "../../experiential/citation";
import { createGatewayClient } from "../../gateway";
import { compileEgressFilter } from "../../plane/egress-filter";
import { guardGatewayRoles } from "../../plane/egress-guard";
import type { GatewayRoles } from "../../plane/gateway";
import { auditJob } from "../../plane/jobs/audit";
import { planSynthesis, runSynthesis } from "../../plane/jobs/synthesis";
import type { JobContext } from "../../plane/plane";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "../shared";

/** Adapt a GatewayClient to the GatewayRoles seam the plane jobs consume — the same mapping
 *  runtime/tool-wiring.ts's rolesFrom does for the live server, duplicated here (not imported)
 *  because that one is module-private and this is the only CLI call site that needs it. */
function rolesFrom(gw: {
  extract: GatewayRoles["extract"];
  synthesize: GatewayRoles["synthesize"];
  judge: GatewayRoles["judge"];
}): GatewayRoles {
  return {
    extract: (r) => gw.extract(r).then((x) => ({ text: x.text, model: x.model })),
    synthesize: (r) => gw.synthesize(r).then((x) => ({ text: x.text, model: x.model })),
    judge: (r) => gw.judge(r).then((x) => ({ text: x.text, model: x.model })),
  };
}

export async function run_consolidate(cmd: Cmd<"consolidate">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.configPath);
  // Gate 2/3: CLI-only, and `--once` is the only supported shape (no interval/loop mode here — the
  // recurring schedule stays `plane.intervalMinutes`, gated by `plane.enabled`). A bare
  // `consolidate` with no `--once` is a usage error rather than a silent no-op.
  if (!cmd.once) {
    process.stderr.write(
      "consolidate: --once is required (see: obsidian-tc consolidate --once [--dry-run])\n",
    );
    process.exit(2);
  }
  mkdirSync(cfg.cacheDir, { recursive: true });
  const cacheDb = await openConfiguredDatabase(cfg, "cache.db");
  provisionCacheDb(cacheDb, { version: VERSION });
  const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
    version: VERSION,
  });
  try {
    const excludeFilter = compileEgressFilter(cfg.egress.excludePaths);
    let gwc: {
      extract: GatewayRoles["extract"];
      synthesize: GatewayRoles["synthesize"];
      judge: GatewayRoles["judge"];
    } | null;
    try {
      // THE-934 fix round 2 (Minor): `excludeFilter` threaded here too -- round 1 left this call
      // bare, so the PORT itself (createGatewayClient's own guardGatewayClient wrap) never knew
      // about cfg.egress.excludePaths and the guardGatewayRoles wrap below was doing ALL of the
      // work alone, unlike every other production call site (runtime/plane-wiring.ts's `deps.roles`
      // etc.), which arm both layers. `guardGatewayRoles` stays -- runtime/plane-wiring.ts still
      // calls it directly on several seams, so it is not vestigial -- but this CLI path is now
      // genuinely defence-in-depth rather than single-layer.
      gwc = createGatewayClient({
        baseUrl: cfg.gateway?.baseUrl,
        token: cfg.gateway?.token,
        excludeFilter,
      });
    } catch {
      gwc = null;
    }
    // THE-934: guarded even here, in a one-shot CLI process — the defence-in-depth check has no
    // reason to be weaker outside the long-running server.
    const roles = gwc ? guardGatewayRoles(rolesFrom(gwc), excludeFilter) : null;
    const ctx: JobContext = {
      db: cacheDb,
      roles,
      now: Date.now,
      excludeFilter,
      ...(cfg.plane.maxPromptChars !== undefined
        ? { maxPromptChars: cfg.plane.maxPromptChars }
        : {}),
    };

    if (cmd.dryRun) {
      // ZERO gateway calls below, by construction: planSynthesis and countCitationCandidates are
      // both pure reads that never touch ctx.roles / gwc.
      const plans = planSynthesis(ctx);
      const citationCandidates = countCitationCandidates(edb, cacheDb, excludeFilter);
      const totalCalls = plans.reduce((n, p) => n + p.estimated_calls, 0);
      process.stdout.write("consolidate --once --dry-run: 0 gateway calls made\n");
      if (plans.length === 0) {
        process.stdout.write("  synthesis: no vault has indexed chunks — nothing to plan\n");
      }
      for (const p of plans) {
        process.stdout.write(
          `  synthesis[${p.vault_id}]: recent_chunks_candidate=${p.chunks_candidate} ` +
            `open_contradictions_candidate=${p.contradictions_candidate} estimated_calls=${p.estimated_calls}\n`,
        );
      }
      process.stdout.write(
        `  citation_candidates (global, unscoped backlog visibility, not run by --once)=${citationCandidates}\n`,
      );
      process.stdout.write(
        `  audit: 0 estimated calls (the audit pass never calls the gateway)\n` +
          `  estimated_gateway_calls_for_a_real_run=${totalCalls}\n`,
      );
      return;
    }

    // THE-934 fix round 1 (I4): `ok: false` covers TWO different situations that must not share
    // an exit code — a legitimate degrade ("no gateway roles configured", detail.skipped set) and
    // a genuine failure (a parse error, detail.error set, no `skipped` key). A scripted `--once`
    // invocation cannot tell them apart from stdout text alone, so the exit code is what has to
    // carry the distinction: `skipped` in detail keeps exit 0 (the intended degrade), anything
    // else that reports ok:false exits 1. A thrown exception still propagates through cli.ts's
    // top-level catch regardless.
    const isSkipped = (detail: Record<string, unknown> | undefined): boolean =>
      detail !== undefined && "skipped" in detail;
    const synthResult = await runSynthesis(ctx);
    const auditResult = await auditJob.run(ctx);
    process.stdout.write(`consolidate --once: synthesis ${synthResult.ok ? "ok" : "FAILED"}\n`);
    process.stdout.write(`${JSON.stringify(synthResult.detail ?? {})}\n`);
    process.stdout.write(`consolidate --once: audit ${auditResult.ok ? "ok" : "FAILED"}\n`);
    process.stdout.write(`${JSON.stringify(auditResult.detail ?? {})}\n`);
    const synthFailed = !synthResult.ok && !isSkipped(synthResult.detail);
    const auditFailed = !auditResult.ok && !isSkipped(auditResult.detail);
    if (synthFailed || auditFailed) process.exitCode = 1;
  } finally {
    cacheDb.close?.();
    edb.close?.();
  }
}
