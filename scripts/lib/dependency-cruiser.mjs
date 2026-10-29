import { accessSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Explicit files stay in memory, avoiding shell shims and operating-system argv limits. */
export async function cruiseSourceFiles(
  files,
  {
    configFile = ".dependency-cruiser.cjs",
    ignoreKnown = false,
    knownViolationsFile = ".dependency-cruiser-known-violations.json",
  } = {},
) {
  if (files.length === 0) throw new Error("dependency-cruiser: no source files");
  for (const file of files) accessSync(file);
  const [{ cruise }, { default: extractOptions }, { default: extractTSConfig }] = await Promise.all(
    [
      import("dependency-cruiser"),
      import("dependency-cruiser/config-utl/extract-depcruise-options"),
      import("dependency-cruiser/config-utl/extract-ts-config"),
    ],
  );
  const options = await extractOptions(resolve(configFile));
  const tsConfig = options.tsConfig
    ? extractTSConfig(options.tsConfig.fileName ?? "tsconfig.json")
    : {};
  const known = ignoreKnown
    ? { knownViolations: JSON.parse(readFileSync(knownViolationsFile, "utf8")) }
    : {};
  const result = await cruise(
    files,
    { ...options, ...known, ignoreKnown, outputType: "json" },
    {},
    { tsConfig },
  );
  return JSON.parse(result.output);
}
