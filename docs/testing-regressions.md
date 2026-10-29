# Regression testing and the indexing rollout

`bun run test:regression` runs lint, typechecking, dependency boundaries, model-mirror parity, and the automated regression surface across all six packages, the repository scripts, Bun SQLite smoke checks, both tested Python services, the Python evaluation harness, and the documentation build/tool-page checks. Independent suites continue after a failure; failed builds block their dependent suites. A failed, missing, cancelled, or blocked stage makes the command exit nonzero.

```sh
bun run test:regression --report .cache/regression/report.json
bun run test:e2e --report .cache/regression/indexing-e2e.json
node scripts/run-regressions.mjs --list
node scripts/run-regressions.mjs --suite plugin,shared
```

The report is checkpointed after each stage and remains unsuccessful until the selected run completes. Each stage has a 60-minute timeout; `--timeout-ms` changes that bound. Interrupting the runner terminates its current child process tree and records unstarted stages as cancelled. No tests are automatically skipped because a toolchain is missing.

## Prerequisites and interpretation

Install the repository's pinned Node/Bun toolchain and workspace dependencies. The independently published `packages/embedder-local` and `packages/reranker-local` packages and the `docs` site each need their own frozen-lockfile dependency installation. The Rust suite needs the toolchain in `packages/native/rust-toolchain.toml`. Python service dependencies follow `.github/workflows/ci-model-service.yml`; the BGE test surface uses its lightweight hashed lock rather than model weights. `REGRESSION_PYTHON` can select an already prepared Python executable. The runner does not install or update dependencies.

Git and OpenSSH (`ssh` and `ssh-keygen`) must be on `PATH` for their local parsing and key-fixture tests. Run POSIX permission tests as an unprivileged user: root bypasses the file-mode refusals those assertions exercise. Leave `BUN_RUNTIME_TRANSPILER_CACHE_PATH` unset or point it to an absolute writable path. Preserve the Python services' separately pinned environments; use separate `--suite` invocations with the corresponding `REGRESSION_PYTHON`, or an executable wrapper that selects the environment by working directory.

Selected server tests build shared/server prerequisites first. The full run also builds the local model packages, preventing existing distribution files from masking current source changes. Server Vitest runs under Node; the Bun SQLite adapter has its own stage. The plugin stage preserves its coverage thresholds. The Python evaluation tests need the NumPy version pinned by `.github/workflows/ci-server.yml`; they use stubs and do not launch GPU jobs.

Use a short writable temporary directory on Windows by setting `TEMP`, `TMP`, and `TMPDIR` for the process. Deep checkout paths plus nested fixtures can exceed Windows path limits. Some fixtures require symlink privileges or Unix shell behavior. Record those failures and run the relevant Linux CI jobs; do not weaken their assertions or count an unexecuted platform as passed.

The runner clears `OBSIDIAN_TC_LIVE` in child environments. A running Obsidian application, companion plugins, live model inference, other operating systems, and packaged-distribution installation tests remain separate acceptance surfaces. The existing CI workflows cover those supported matrices independently; this local command does not certify every distribution or a production deployment.

## First strangler boundary: single-note preparation

The `indexNote` facade selects one preparation implementation before any embedding call:

```json
{
  "indexing": {
    "writePreparation": "legacy"
  }
}
```

`legacy` is the default. `modular` opts into the extracted `prepareNote` module, whose object input supplies the database, provider, note, and indexing policy. Both paths retain the configured chunk size and embedding limits. They share the same atomic persistence, ACL identity, write fences, and generation updates. Boot and scheduled reconciliation receive the same configured chunk size.

To evaluate the extracted path, set `writePreparation` to `modular` in a scratch or canary deployment and restart. To roll back, select `legacy` and restart. This selector changes no database format and requires no index rebuild. A failure propagates to the normal error handling; it never invokes the other implementation, so rollback support cannot duplicate provider calls or writes. The two implementations are compared using isolated fixtures rather than shadowing live mutations.

The automated gates are:

- `index-write-policy.test.ts`: both modes match whole-vault chunks and embeddings, with contextual enrichment on/off and configured request limits.
- `index-preparation-rollout.test.ts`: default/explicit selection, one preparation and commit, failures without partial persistence or fallback, and egress exclusion.
- `vault-lifecycle-e2e.test.ts`: real authenticated MCP HTTP transport, note creation and automatic indexing, retrieval, confirmed overwrite/move/delete, restart persistence, external watcher edits, semantic removal, and audit events in both modes.
- Existing transaction rollback, write-fence, ACL, and egress regressions remain applicable to the shared persistence path.

Promotion requires both-mode workflow and failure tests to pass on the supported platforms, followed by canary evidence for index failures, queue behavior, retrieval, and restart consistency. Remove the legacy implementation only after that evidence and an agreed rollback window. The existing facades elsewhere in the repository remain the boundaries for later migrations; they do not require recreating deleted implementations.
