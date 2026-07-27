/**
 * THE-525 — module boundary rules.
 *
 * Decomposition without enforcement decays: nothing stops the next PR from importing across a
 * boundary that was just established. These rules make the layering contract machine-checked so
 * THE-466's split can land incrementally instead of as one ~4.6k-line review.
 *
 * Two things to know before editing:
 *
 *   1. `severity: "error"` is what makes the `err` reporter exit non-zero. Severity DEFAULTS to
 *      "warn", and warn/info violations exit 0 — a rule without an explicit error severity is
 *      decorative. Every gating rule below states it.
 *   2. Legacy violations are baselined in .dependency-cruiser-known-violations.json and read via
 *      --ignore-known, which lowers each recorded violation to "ignore". That is what lets a new
 *      rule land green today and be paid down later. The baseline should only ever SHRINK.
 *      Matching is on the (from, to, rule) tuple, so moving a file re-surfaces its violation —
 *      that is expected, not a bug.
 *
 * THE-593: `not-to-dev-dep` below is currently INERT. dependency-cruiser 18.1.0 (latest at time
 * of writing; no newer release exists) has no TypeScript 7 API support — root package.json pins
 * `typescript@^7.0.2` — and prints so itself ("Support for typescript@>=7 will follow when its
 * API is published and stable"). It falls back to a degraded resolver that classifies every npm
 * import as `dependencyTypes: ['unknown']`, never `['npm-dev']`, so a rule keyed on
 * `dependencyTypes` matches nothing, ever: proven by planting a `src` file that imports `vitest`
 * and watching `check:boundaries` report 0 errors. Kept rather than deleted, so the intent stays
 * documented and the rule resumes firing automatically the moment dependency-cruiser (or a future
 * TypeScript downgrade for just this tool) regains TS-7 support — deliberately NOT decided here.
 * Until then, the actual enforcement for "shipped code must not import a devDependency" is
 * scripts/check-dev-dep-imports.mjs (`bun run check:dev-dep-imports`), a source-scan gate that
 * does not depend on dependency-cruiser's TypeScript support at all.
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "A cycle means neither module can be understood or tested alone, and it makes extraction " +
        "order undecidable — exactly what THE-466 needs to be able to reason about.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-tool-imports-transport",
      severity: "error",
      comment:
        "Tools must not reach the transport layer. A tool that knows whether it is being called " +
        "over stdio or HTTP cannot be unit-tested without one, and invites transport-specific " +
        "behaviour in code that dispatch treats as uniform.",
      from: { path: "^packages/server/src/tools/" },
      to: { path: "^packages/server/src/transports/" },
    },
    {
      name: "no-transport-imports-tool",
      severity: "error",
      comment:
        "The dependency runs transports -> registry -> tools. A transport reaching a concrete " +
        "tool bypasses dispatch, and dispatch is where scope checks, HITL floors, idempotency and " +
        "audit live. This rule is a security boundary, not a style preference. THE-600: extended " +
        "to packages/server/src/cli/commands/ — a CLI subcommand importing a tool module directly " +
        "is the same bypass a transport would be, and is exactly how `forget`'s CLI/tool audit " +
        "guarantees came to diverge (a subcommand reimplementing tool logic instead of dispatching " +
        "it never gets the pipeline's scope/ACL/audit stages). `prefetch.ts` is exempted below: it " +
        "builds its OWN ToolRegistry and calls registry.dispatch(...) (cli/commands/prefetch.ts), " +
        "so its import of tools/m7 is registration, not a bypass — the one case verified legitimate " +
        "when this rule was extended. Any OTHER cli/commands/ file this rule newly flags is a real " +
        "finding, not a candidate for .dependency-cruiser-known-violations.json: that file is a " +
        "baseline of PRE-EXISTING violations meant only to shrink, and adding a fresh one to it " +
        "would silently defeat the rule this comment just explained.",
      from: {
        path: "^packages/server/src/(transports|cli/commands)/",
        pathNot: ["^packages/server/src/cli/commands/prefetch\\.ts$"],
      },
      to: { path: "^packages/server/src/tools/" },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment:
        "Warn-only: an orphan is usually dead code left by a refactor, but type-only and entry " +
        "modules legitimately look orphaned, so this informs rather than gates.",
      from: {
        orphan: true,
        pathNot: ["\\.d\\.ts$", "(^|/)index\\.ts$", "^packages/[^/]+/src/index"],
      },
      to: {},
    },
    {
      name: "not-to-dev-dep",
      severity: "error",
      comment:
        "Shipped code must not import a devDependency — it resolves locally and fails for anyone " +
        "installing the published package. INERT under TypeScript 7 — see the THE-593 note at the " +
        "top of this file. scripts/check-dev-dep-imports.mjs enforces this today.",
      from: { path: "^packages/[^/]+/src/", pathNot: "\\.test\\.ts$" },
      to: { dependencyTypes: ["npm-dev"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: [
        "node_modules",
        "/dist/",
        // Tests legitimately reach across layers to assemble fixtures; gating them would force
        // indirection that makes the tests worse, not the source better.
        "\\.test\\.ts$",
        "^packages/server/test/",
        "^packages/server/bun-smoke/",
        "^packages/server/eval/",
        "^docs/",
      ],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "packages/server/tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".js", ".mjs", ".cjs"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
