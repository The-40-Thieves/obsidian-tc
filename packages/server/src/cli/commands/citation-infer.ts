import { mkdirSync, readFileSync } from "node:fs";
import { version as VERSION } from "../../../package.json";
import { provisionExperientialDb } from "../../db/experiential";
import { openConfiguredDatabase } from "../../db/open";
import { createEmbeddingProvider } from "../../embeddings";
import { type InferCitationsOptions, inferCitations } from "../../experiential/citation";
import { runCitationIndexPasses } from "../../experiential/citation-index";
import { createGatewayClient, type GatewayClient } from "../../gateway";
import { compileEgressFilter } from "../../plane/egress-filter";
import { USAGE } from "../args";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "../shared";

export async function run_citation_infer(cmd: Cmd<"citation-infer">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  // THE-717 step 3: two input shapes. `--transcript` is the original — one operator-supplied blob
  // over one scope. `--transcript-index` is the automatable one: JSONL, one entry per retrieval,
  // run as one pass each. They are mutually exclusive because they scope differently, and silently
  // preferring one would make the other's flags look accepted while being discarded.
  if (cmd.transcript && cmd.transcriptIndex) {
    process.stderr.write("citation-infer: --transcript and --transcript-index are exclusive\n");
    process.exit(2);
  }
  if (!cmd.transcript && !cmd.transcriptIndex) {
    process.stderr.write(
      `citation-infer requires --transcript <file> and --session <id> or --since <ms> [--until <ms>], or --transcript-index <file.jsonl>\n\n${USAGE}`,
    );
    process.exit(2);
  }
  if (cmd.transcript && !cmd.session && cmd.since === undefined) {
    process.stderr.write(
      `citation-infer requires --session <id> or --since <ms> [--until <ms>] with --transcript\n\n${USAGE}`,
    );
    process.exit(2);
  }
  const transcript = cmd.transcript ? readFileSync(cmd.transcript, "utf8") : "";
  mkdirSync(cfg.cacheDir, { recursive: true });
  const cacheDb = await openConfiguredDatabase(cfg, "cache.db");
  const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
    version: VERSION,
  });
  // THE-934 fix round 1 (Blocking-2): egress.excludePaths — obsidian-tc citation-infer runs the
  // SAME pass runtime/plane-wiring.ts's citation job schedules, which round 0 guarded; this CLI
  // entry point had not been. `excludeFilter` below both filters candidates (citation.ts's own
  // chokepoint, already wired to accept it) and guards the gateway/embedding ports.
  const egressFilter = compileEgressFilter(cfg.egress.excludePaths);
  let gwc: GatewayClient | null = null;
  try {
    gwc = createGatewayClient({ excludeFilter: egressFilter });
  } catch {
    gwc = null;
  }
  const provider = createEmbeddingProvider(cfg.embeddings, { excludeFilter: egressFilter });
  // EXPLICITLY TYPED, and that annotation is load-bearing. THE-621 put `judgeConcurrency` and
  // `minJudgedForKill` as direct properties of the literal passed to inferCitations precisely
  // because TypeScript excess-property-checks a fresh literal but NOT spread-in properties — a
  // one-letter typo in a conditional spread typechecks clean and silently discards the option.
  // Hoisting them into a shared object would have thrown that away; annotating the object with
  // Pick<> puts the check back, at the point the object is built rather than where it is spread.
  const common: Pick<
    InferCitationsOptions,
    | "embed"
    | "judge"
    | "maxJudged"
    | "judgeConcurrency"
    | "minJudgedForKill"
    | "allowUncertain"
    | "log"
    | "excludeFilter"
  > = {
    embed: (texts) => provider.embed(texts, { input: "query" }),
    judge: gwc ? (r) => gwc.judge(r).then((x) => ({ text: x.text, model: x.model })) : null,
    ...(cmd.maxJudged !== undefined ? { maxJudged: cmd.maxJudged } : {}),
    judgeConcurrency: cmd.judgeConcurrency,
    minJudgedForKill: cmd.minJudgedForKill,
    ...(cmd.allowUncertain ? { allowUncertain: true } : {}),
    log: (s) => process.stderr.write(`${s}\n`),
    excludeFilter: egressFilter,
  };
  try {
    if (cmd.transcriptIndex) {
      const r = await runCitationIndexPasses(cmd.transcriptIndex, edb, cacheDb, common);
      if (r.malformed.length > 0) {
        process.stderr.write(
          `citation-infer: ${r.malformed.length} malformed index line(s) at ${r.malformed.slice(0, 20).join(",")}\n`,
        );
      }
      for (const sk of r.skipped) {
        process.stderr.write(
          `citation-infer: SKIPPED ${sk.reason} — ${sk.surface_type} @${sk.retrieved_at} ${JSON.stringify(sk.query.slice(0, 60))}\n`,
        );
      }
      process.stdout.write(
        `citation-infer: entries=${r.entries} passes=${r.passes} skipped=${r.skipped.length} malformed=${r.malformed.length} scoped=${r.scoped} cited=${r.cited}${r.abortedPasses > 0 ? ` ABORTED(${r.abortedPasses})` : ""}\n`,
      );
      return;
    }
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript,
      ...(cmd.session ? { sessionId: cmd.session } : {}),
      ...(cmd.since !== undefined
        ? { windowMs: [cmd.since, cmd.until ?? Date.now()] as [number, number] }
        : {}),
      ...common,
    });
    process.stdout.write(
      // judgeErrors is printed UNCONDITIONALLY alongside parseFailures, not folded into it and not
      // omitted when zero. Leaving it out meant a transport failure below the kill-switch ratio was
      // invisible everywhere except the database: stdout said `parseFailures=0` and nothing else
      // ever mentioned it, which is the same silence this whole change exists to remove.
      `citation-infer: scoped=${stats.scoped} stage1Pass=${stats.stage1Pass} judged=${stats.judged} cited=${stats.cited} uncertain=${stats.uncertain} parseFailures=${stats.parseFailures} judgeErrors=${stats.judgeErrors}${stats.aborted ? " ABORTED(kill-switch)" : ""}\n`,
    );
  } finally {
    edb.close?.();
    cacheDb.close?.();
  }
  return;
}
