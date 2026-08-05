import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { version as VERSION } from "../../../package.json";
import { provisionExperientialDb } from "../../db/experiential";
import { openDatabase } from "../../db/open";
import type { Database } from "../../db/types";
import { createEmbeddingProvider } from "../../embeddings";
import { type InferCitationsOptions, inferCitations } from "../../experiential/citation";
import { parseTranscriptIndex, planCitationPasses } from "../../experiential/transcript-source";
import { createGatewayClient, type GatewayClient } from "../../gateway";
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
  const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
  const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
    version: VERSION,
  });
  let gwc: GatewayClient | null = null;
  try {
    gwc = createGatewayClient({});
  } catch {
    gwc = null;
  }
  const provider = createEmbeddingProvider(cfg.embeddings);
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
  > = {
    embed: (texts) => provider.embed(texts, { input: "query" }),
    judge: gwc ? (r) => gwc.judge(r).then((x) => ({ text: x.text, model: x.model })) : null,
    ...(cmd.maxJudged !== undefined ? { maxJudged: cmd.maxJudged } : {}),
    judgeConcurrency: cmd.judgeConcurrency,
    minJudgedForKill: cmd.minJudgedForKill,
    ...(cmd.allowUncertain ? { allowUncertain: true } : {}),
    log: (s) => process.stderr.write(`${s}\n`),
  };
  try {
    if (cmd.transcriptIndex) {
      await runIndexedPasses(cmd.transcriptIndex, edb, cacheDb, common);
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
      `citation-infer: scoped=${stats.scoped} stage1Pass=${stats.stage1Pass} judged=${stats.judged} cited=${stats.cited} uncertain=${stats.uncertain} parseFailures=${stats.parseFailures}${stats.aborted ? " ABORTED(kill-switch)" : ""}\n`,
    );
  } finally {
    edb.close?.();
    cacheDb.close?.();
  }
  return;
}

/**
 * Run one citation pass per indexed retrieval (THE-717 step 3).
 *
 * ONE PASS PER ENTRY, not one pass over the union. `inferCitations` scores every chunk in scope
 * against a single transcript, which is only correct when the scope IS one retrieval. A window
 * spanning several queries has several answers, and their concatenation would let any chunk match
 * any answer — citations attributed across queries that never saw each other.
 *
 * Every skip is PRINTED. A run that silently plans nothing and exits 0 is indistinguishable from a
 * run that stamped everything, and this command's whole job is to stop producing that class of
 * unfalsifiable result. Each pass also writes its own row to `citation_runs` (THE-717 item 2), so
 * the outcome is auditable after the fact rather than only in this stdout.
 */
async function runIndexedPasses(
  indexPath: string,
  edb: Database,
  cacheDb: Database,
  common: Pick<
    InferCitationsOptions,
    | "embed"
    | "judge"
    | "maxJudged"
    | "judgeConcurrency"
    | "minJudgedForKill"
    | "allowUncertain"
    | "log"
  >,
): Promise<void> {
  const { entries, malformed } = parseTranscriptIndex(readFileSync(indexPath, "utf8"));
  const plan = planCitationPasses(entries);
  if (malformed.length > 0) {
    process.stderr.write(
      `citation-infer: ${malformed.length} malformed index line(s) at ${malformed.slice(0, 20).join(",")}\n`,
    );
  }
  for (const s of plan.skipped) {
    process.stderr.write(
      `citation-infer: SKIPPED ${s.reason} — ${s.entry.surface_type} @${s.entry.retrieved_at} ${JSON.stringify(s.entry.query.slice(0, 60))}\n`,
    );
  }

  let scoped = 0;
  let cited = 0;
  let aborted = 0;
  for (const p of plan.passes) {
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: p.entry.transcript,
      windowMs: p.window,
      ...common,
    });
    scoped += stats.scoped;
    cited += stats.cited;
    if (stats.aborted) aborted += 1;
  }
  process.stdout.write(
    `citation-infer: entries=${entries.length} passes=${plan.passes.length} skipped=${plan.skipped.length} malformed=${malformed.length} scoped=${scoped} cited=${cited}${aborted > 0 ? ` ABORTED(${aborted})` : ""}\n`,
  );
}
