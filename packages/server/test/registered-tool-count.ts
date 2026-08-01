// The single source for "how many tools the registry holds".
//
// This used to be TWO hand-kept literals — one in tool-count.test.ts, one "mirroring" it in
// tool-facade-domain-coverage.test.ts — synchronised by remembering. That is the same drift class
// THE-580 removed from check-version-coherence.mjs, and it was worse here, because that gate parses
// only tool-count.test.ts and never saw the second copy at all. Found by the THE-548 audit.
//
// It lives in its own module rather than being exported from a test because biome's
// `noExportsInTest` (correctly) forbids exporting from a `*.test.ts` file.
//
// THIS DECLARATION IS PARSED. Keep it a plain `export const REGISTERED_TOOL_COUNT = <digits>;` on
// one line: scripts/check-version-coherence.mjs reads it with a regex to derive the tool count it
// holds the docs to. That gate hard-fails if it cannot find the declaration, so a rename or a
// computed value breaks it loudly rather than silently reverting to an unchecked default.
export const REGISTERED_TOOL_COUNT = 152;
