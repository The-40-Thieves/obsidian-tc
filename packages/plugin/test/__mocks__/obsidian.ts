// Stand-in for the `obsidian` module, which only exists inside the Obsidian runtime — the real
// package ships types plus a stub whose functions throw outside the app, so importing routes.ts
// under vitest without this fails at module load, before any assertion runs.
//
// Deliberately minimal: routes.ts imports five names and only THREE are values. `App` and `TFile`
// are types, erased at compile time, so they need no runtime counterpart. Adding more here would
// invent API surface the code under test does not use, and a mock that is richer than its subject
// hides the coupling it exists to reveal.

/** Obsidian's public API version, surfaced verbatim by GET /probe as `obsidian_version`. */
export const apiVersion = "1.13.1";

/**
 * Real `normalizePath` collapses duplicate slashes, strips a leading slash, and normalises
 * unicode. The behaviour that matters to the tests is that it is APPLIED — a path reaching
 * `vault.getAbstractFileByPath` unnormalised is the bug this function exists to prevent — so this
 * reproduces the observable parts rather than stubbing it to identity, which would let a caller
 * that forgot to normalise still pass.
 */
export function normalizePath(path: string): string {
  return path
    .replace(/([\\/])+/g, "/")
    .replace(/(^\/+|\/+$)/g, "")
    .normalize("NFC");
}

/** Obsidian bundles moment. Only the formatting call shape is needed here. */
export function moment(input?: unknown): {
  format: (fmt?: string) => string;
  toISOString: () => string;
} {
  const d = input instanceof Date ? input : new Date(0);
  return {
    format: () => d.toISOString().slice(0, 10),
    toISOString: () => d.toISOString(),
  };
}
