// docgen — project stats extractor (THE-471/homepage). The volatile "at a glance" facts a homepage
// keeps getting wrong. Two kinds:
//   - DERIVED from code (can't be wrong): version (package.json), tool count, config-key count.
//   - CURATED (not in this public repo): golden-set size + headline enrichment gain come from the
//     private eval harness, so they live in docs/project-facts.json — the single source of truth.
//     Update that file, run docgen:render, and every page + the drift gate stays consistent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NON_CORE_TOOL_NAMES } from "../../src/mcp/tool-profiles";
import { extractConfig } from "./extract-config";
import { extractTools } from "./extract-tools";

export interface StatsDoc {
  version: string;
  tools: number;
  /** THE-1131: how many of `tools` are visible/callable under the OPT-IN `toolFacade.profile:
   *  "core"` (the default is `"full"`, unchanged at `tools`). Derived from tool-profiles.ts's
   *  NON_CORE_TOOL_NAMES — the same single source of truth every other profile-aware gate reads
   *  — never a hand-kept second count. */
  coreTools: number;
  configKeys: number;
  goldenSetSize: number;
  enrichmentGain: string;
}

interface ProjectFacts {
  goldenSetSize: number;
  enrichmentNdcgGain: string;
}

export function extractStats(): StatsDoc {
  const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  const factsPath = fileURLToPath(new URL("../../../../docs/project-facts.json", import.meta.url));
  const facts = JSON.parse(readFileSync(factsPath, "utf8")) as ProjectFacts;
  const toolCount = extractTools().length;
  return {
    version: pkg.version ?? "0.0.0",
    tools: toolCount,
    coreTools: toolCount - NON_CORE_TOOL_NAMES.length,
    configKeys: extractConfig().length,
    goldenSetSize: facts.goldenSetSize,
    enrichmentGain: facts.enrichmentNdcgGain,
  };
}
