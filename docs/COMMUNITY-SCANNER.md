# Obsidian community-directory scanner: how this monorepo is linted

The community directory's scorecard (`obsidianmd/obsidian-workflows`, `src/lint.ts`, pinned to
`eslint-plugin-obsidianmd` 0.4.1 and `typescript-eslint` 8.61) runs ESLint from the **repository
root**, over every file that is not in its ignore list (tests, `scripts/`, `docs/`, `*.mjs` and
`dist` at the root are skipped). The plugin is one package of this monorepo, so the scanner also
reads the Bun server, the shared package, the native loader and two optional model services.

## Why a root `tsconfig.json` exists

The scanner picks its config by one test: does `<repo root>/tsconfig.json` exist?

| root `tsconfig.json` | branch | result here |
|---|---|---|
| absent | untyped | crashes: `@typescript-eslint/await-thenable requires type information`, exit 2, no JSON, reported as `scanner-eslint-execution-failed` |
| present | typed (`projectService`) | findings per file |

The typed branch resolves each file's project by walking up from the file looking for a file named
exactly `tsconfig.json`. `tsconfig.eval.json` and `tsconfig.bun-smoke.json` are never discovered,
and no config at all reaches the native `*.js` loaders, so those files were fatal parse errors
(26 files before the root config: the eval harness and `packages/native/{fallback,index}.js`).

The root config is therefore **not a build or typecheck project**. It extends the eval project and
`include`s only the files no package config owns; package source keeps its own `tsconfig.json` as
nearest owner. `bun run typecheck` and the dependency-cruiser pin are untouched.
`scripts/scanner-tsconfig-coverage.test.mjs` replays the ownership rule over every tracked file the
scanner would lint and fails if one has no owner.

## Measured effect (scanner config run from the repo root)

| | no root tsconfig | root tsconfig only | this change |
|---|---|---|---|
| exit code | 2, no JSON | 1 (3 errors) | 0 |
| errors | n/a | 3 | 0 |
| warnings | n/a | 909 | 784 |

Warnings by package, root tsconfig only, then this change: server 483 → 362, shared 42 → 38,
embedder-local 163 → 163, reranker-local 145 → 145, native 76 → 76, plugin 0 → 0.

The three errors were real: `Workspace.revealLeaf` (Obsidian 1.7.2+) called by `POST /files/open`
while the manifest floor is 1.7.0 (now `setActiveLeaf`), and two `import(variable)` calls that now
carry the same described `eslint-disable-next-line` the repo already uses at its other dynamic
import sites.

## Warnings: fixed, and left on purpose

| rule | before → after | disposition |
|---|---|---|
| `no-unnecessary-type-assertion` | 121 → 7 | fixed (type-only edits); the 7 left are assertions that are redundant in one tsc project but required in another (`bun-smoke`, Bun's `fetch`), or in packages whose types do not resolve |
| `no-empty` | 30 → 19 | the 11 swallowed-error `catch {}` blocks outside three files now say why; the 19 in `runtime/vault-lock.ts`, `cli/setup/write.ts` and `cli/commands/doctor-probes.ts` (best-effort close, rollback and unlink) are left, because a comment in each pushes those files over the comment-style ratchet |
| `no-unused-vars` | 0 → 0 | the fixes above left unused type imports; removed |
| `no-deprecated` | 107 → 107 | out of scope: zod 4 renames (`.passthrough()`, `ZodIssueCode`, `z.string().url()`, `.merge()`) and the MCP SDK's low-level `Server`. Each is its own migration touching the published tool and config schemas |
| `prefer-window-timers`, `no-global-this`, `no-restricted-globals` (`fetch`), `hardcoded-config-path` | 73, 13, 13, 16 | out of scope: they assume Obsidian's renderer. The server runs under Bun/Node, where `window` does not exist, `fetch` is the transport, and the vault is read from disk without the Obsidian API (there is no `Vault#configDir` to call) |
| `no-unsafe-*` (member-access, call, assignment, return, argument), `no-explicit-any` | 471 → 471 | out of scope. 308 of all warnings sit in `embedder-local` and `reranker-local`, which are not workspace members: the root install never installs `@huggingface/transformers`, so the scanner sees unresolved types. The rest read untyped boundary values (SQLite rows, JSON, the native addon loader) |
| `unbound-method` | 33 | left: each site needs a judgement on `this`, not a mechanical edit |
| `no-irregular-whitespace`, `no-control-regex` | 6, 1 | left: the characters are the point (prompt-poisoning and stamp-sanitising checks) |
| `no-floating-promises`, `only-throw-error`, `prefer-promise-reject-errors` | 4, 2, 4 | left: each changes error behaviour |
| `no-require-imports` | 5 | left: `packages/native/index.js` is the napi-rs generated CommonJS loader |
| `no-redundant-type-constituents` | 6 | left: `Promise<unknown> \| unknown` documents "sync or async" |

No rule is disabled wholesale; the scanner's own configuration is not touched.

## If the scanner builds before it lints

`obsidian-workflows` runs the repo's `build` script before linting. Its ignore list names `dist`
only at the root, so any package-level `dist/` output (`packages/plugin/dist/main.js`) is linted
too and is a fatal parse error unless a tsconfig owns it. Nothing here changes that; it is
outside the tracked tree this change covers.
