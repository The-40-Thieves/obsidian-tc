import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { version as VERSION } from "../../../package.json";
import { provisionExperientialDb } from "../../db/experiential";
import { openDatabase } from "../../db/open";
import { createEmbeddingProvider } from "../../embeddings";
import { inferCitations } from "../../experiential/citation";
import { createGatewayClient, type GatewayClient } from "../../gateway";
import { USAGE } from "../args";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "../shared";

export async function run_citation_infer(cmd: Cmd<"citation-infer">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  if (!cmd.transcript || (!cmd.session && cmd.since === undefined)) {
    process.stderr.write(
      `citation-infer requires --transcript <file> and --session <id> or --since <ms> [--until <ms>]\n\n${USAGE}`,
    );
    process.exit(2);
  }
  const transcript = readFileSync(cmd.transcript, "utf8");
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
  try {
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript,
      ...(cmd.session ? { sessionId: cmd.session } : {}),
      ...(cmd.since !== undefined
        ? { windowMs: [cmd.since, cmd.until ?? Date.now()] as [number, number] }
        : {}),
      embed: (texts) => provider.embed(texts, { input: "query" }),
      judge: gwc ? (r) => gwc.judge(r).then((x) => ({ text: x.text, model: x.model })) : null,
      ...(cmd.maxJudged !== undefined ? { maxJudged: cmd.maxJudged } : {}),
      // THE-621: assigned DIRECTLY rather than conditionally spread like the lines around them.
      // TypeScript applies excess-property checking to a fresh object literal but NOT to spread-in
      // properties, so a conditional spread whose key is misspelled — one letter dropped from
      // `judgeConcurrency` — typechecks clean and silently discards the option. Measured, not
      // assumed. As a plain property that same slip is a TS2561 compile error.
      // Passing `undefined` is equivalent to omitting: both knobs resolve via `?? <default>` in
      // citation.ts, and this project does not set exactOptionalPropertyTypes.
      judgeConcurrency: cmd.judgeConcurrency,
      minJudgedForKill: cmd.minJudgedForKill,
      ...(cmd.allowUncertain ? { allowUncertain: true } : {}),
      log: (s) => process.stderr.write(`${s}\n`),
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
