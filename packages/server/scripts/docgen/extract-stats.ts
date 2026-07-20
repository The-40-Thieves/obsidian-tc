// docgen — project stats extractor (THE-471/homepage). The volatile "at a glance" facts a homepage
// keeps getting wrong. Two kinds:
//   - DERIVED from code (can't be wrong): version (package.json), tool count, config-key count.
//   - CURATED (not in this public repo): golden-set size + headline enrichment gain come from the
//     private eval harness, so they live in docs/project-facts.json — the single source of truth.
//     Update that file, run docgen:render, and every page + the drift gate stays consistent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractConfig } from "./extract-config";
import { extractTools } from "./extract-tools";

export interface StatsDoc {
  version: string;
  tools: number;
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
  return {
    version: pkg.version ?? "0.0.0",
    tools: extractTools().length,
    configKeys: extractConfig().length,
    goldenSetSize: facts.goldenSetSize,
    enrichmentGain: facts.enrichmentNdcgGain,
  };
}
