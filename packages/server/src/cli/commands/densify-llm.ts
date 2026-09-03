import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../db/open";
import { createGatewayClient, type GatewayClient } from "../../gateway";
import { compileEgressFilter } from "../../plane/egress-filter";
import { runLlmDensify } from "../../search/densify-runner";
import { type Cmd, resolveOrUsageExit } from "../shared";

export async function run_densify_llm(cmd: Cmd<"densify-llm">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  // retrieval.densify.llmEdges is the off-switch for the LLM edge layer — the one code path that sends
  // note CONTENT to a model. It is checked FIRST: before the cache db is opened, before a gateway
  // client is built. It used to be checked last, so the gateway-missing error fired ahead of it and an
  // operator on a host with no gateway was told the wrong thing entirely — never learning the feature
  // was simply disabled. A safety gate that only fires once the unsafe machinery is already set up is a
  // gate in name only.
  if (cfg.retrieval?.densify?.llmEdges !== true) {
    process.stderr.write(
      "densify-llm is disabled: set retrieval.densify.llmEdges = true in your config to enable it.\n" +
        "It sends note content to the configured model (local gateway by default), so it is opt-in.\n",
    );
    process.exit(2);
  }
  mkdirSync(cfg.cacheDir, { recursive: true });
  const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
  // THE-934 fix round 1: egress.excludePaths — an excluded note is dropped before it can be a
  // densify-llm batch member (search/densify-runner.ts), and the gateway constructed below is
  // guarded at the port either way.
  const egressFilter = compileEgressFilter(cfg.egress.excludePaths);
  let gwc: GatewayClient | null = null;
  try {
    gwc = createGatewayClient({ excludeFilter: egressFilter });
  } catch {
    gwc = null;
  }
  if (!gwc) {
    process.stderr.write(
      "densify-llm requires a configured inference gateway (extract role -> local model); none resolved.\n",
    );
    cacheDb.close?.();
    process.exit(2);
  }
  const floor = cfg.retrieval?.densify?.confidenceFloor;
  try {
    const vaultIds = cmd.vault ? [cmd.vault] : cfg.vaults.map((v) => v.id);
    for (const vid of vaultIds) {
      const res = await runLlmDensify(cacheDb, vid, gwc, {
        ...(floor !== undefined ? { confidenceFloor: floor } : {}),
        excludeFilter: egressFilter,
      });
      process.stdout.write(`densify-llm[${vid}]: notes=${res.notes} edges=${res.edges}\n`);
    }
  } finally {
    cacheDb.close?.();
  }
  return;
}
