// docgen — project stats extractor (THE-471/homepage). The volatile "at a glance" facts a homepage
// keeps getting wrong: version (from package.json), tool count, config-key count. All derived, so the
// generated block on the wiki Home page never goes stale again.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractConfig } from "./extract-config";
import { extractTools } from "./extract-tools";

export interface StatsDoc {
  version: string;
  tools: number;
  configKeys: number;
}

export function extractStats(): StatsDoc {
  const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  return {
    version: pkg.version ?? "0.0.0",
    tools: extractTools().length,
    configKeys: extractConfig().length,
  };
}
