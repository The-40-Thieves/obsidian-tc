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
        "audit live. This rule is a security boundary, not a style preference.",
      from: { path: "^packages/server/src/transports/" },
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
        "installing the published package.",
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
