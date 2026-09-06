// Stand-in for the `obsidian` module, which only exists inside the Obsidian runtime — the real
// package ships types plus a stub whose functions throw outside the app, so importing routes.ts
// under vitest without this fails at module load, before any assertion runs.
//
// Deliberately minimal: routes.ts imports six names and only `App` stays type-only, erased at
// compile time with no runtime counterpart needed. `TFile` (THE-964) IS a value here — fileByPath
// narrows with `instanceof TFile`, which needs a real class to check against — but stays a bare
// field bag with no vault-wiring behaviour. Adding more here would invent API surface the code
// under test does not use, and a mock that is richer than its subject hides the coupling it exists
// to reveal.

/** Obsidian's public API version, surfaced verbatim by GET /probe as `obsidian_version`. */
export const apiVersion = "1.13.1";

/**
 * Minimal stand-in for the real `TFile` class — just enough shape for `instanceof TFile` to
 * narrow `fileByPath`'s duck-typed vault lookups. Fixtures build one with `Object.assign(new
 * TFile(), {...})` rather than a plain object literal, since the route code under test now
 * checks `instanceof TFile`, not a shape/`extension` duck-check.
 */
export class TFile {
  path!: string;
  basename!: string;
  extension!: string;
}

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
