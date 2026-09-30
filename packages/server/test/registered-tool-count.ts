// The single source for "which tools the registry holds" (and so how many).
//
// It was a hand-kept `REGISTERED_TOOL_COUNT = <digits>` literal, which every tool-adding PR edited
// on the same line: two such PRs either conflicted, or — worse — both wrote `168` and merged
// cleanly to a count that is wrong by one. The authority is now `registered-tools.txt`, one tool
// name per line, sorted: adding a tool adds ONE line at its alphabetical position, so two PRs only
// conflict when they add neighbouring names, and the count is derived rather than typed.
//
// It lives in its own module rather than being exported from a test because biome's
// `noExportsInTest` (correctly) forbids exporting from a `*.test.ts` file. The registry itself is
// compared against this list by tool-count.test.ts, which names every missing or unlisted tool.
//
// Originally two hand-kept literals (tool-count.test.ts and a "mirror" in
// tool-facade-domain-coverage.test.ts) — the THE-548 audit; THE-580 derived the docs side. The docs
// no longer state the count at all (see docgen facts-check), so nothing parses this file.
import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("./registered-tools.txt", import.meta.url), "utf8");

/** Every registered tool name, sorted, exactly as listed in registered-tools.txt. */
export const REGISTERED_TOOL_NAMES: readonly string[] = raw.split("\n").filter((l) => l !== "");

export const REGISTERED_TOOL_COUNT: number = REGISTERED_TOOL_NAMES.length;
