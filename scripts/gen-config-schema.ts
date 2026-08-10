#!/usr/bin/env bun
// Emit a JSON Schema for obsidian-tc.config.json from the Zod schema that already validates it.
//
// WHY THIS IS WORTH DOING AND WHY IT IS CHEAP. The config surface is the customization layer for
// anyone who does not want to write code — toolVisibility, auth.mode, acl, retrieval, embeddings —
// and it is currently undiscoverable: you have to read TypeScript to find out a key exists. The
// descriptions are ALREADY written (187 `.describe()` calls across config.schema.ts); they were
// just never emitted anywhere an editor could read them. Publishing the JSON Schema turns them
// into inline docs and autocomplete in VS Code and every other editor that speaks `$schema`.
//
// Generated, never hand-maintained: the Zod schema stays the single source of truth, so a new key
// with a `.describe()` shows up in the editor automatically. --check makes drift a CI failure
// rather than something discovered when the published schema is already stale.
//
// usage:
//   bun scripts/gen-config-schema.ts            # write docs/obsidian-tc.config.schema.json
//   bun scripts/gen-config-schema.ts --check    # fail if the committed file is stale
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "obsidian-tc.config.schema.json");

// WP1.1: a pinned baseline of the complete emitted bytes (including the trailing newline). The
// staleness check below (comparing regenerated output to the committed file) catches the schema
// going STALE, but regenerating both together would silently hide an unintended CHANGE — this
// hash is the second, independent witness. A deliberate schema change updates this constant in
// its own behavioral PR, not as a side effect of an unrelated refactor.
// THE-678: rebaselined deliberately. The only emitted change is the description text on
// embeddings.modelTier.dense.revision and .full.revision, which now state they are provenance-only
// and point at the top-level embeddings.revision. No key, type, default or constraint moved.
// THE-683: rebaselined deliberately. The only emitted change is embeddings.pooling's description,
// which no longer says the key "does not affect the index" — it now does. No key, type, default or
// constraint moved.
// THE-709: rebaselined deliberately. Adds ONE key, plane.gatewayTimeoutMs (int, positive, default
// 300000), and rewords plane.gatewayMaxAttempts' description to point at it. Attempts alone could
// not fix a scheduled pass that was merely slow — measured 370.4s twice, 45 minutes apart and 12ms
// from each other, which is 6 x 60s expiring on schedule, not a cold start varying. No existing
// key, type, default or constraint moved.
// THE-726 follow-up: rebaselined deliberately, DESCRIPTION TEXT ONLY. `sessions.windowSeconds` said
// "how long a server-opened session stays open", which overstates the precision. Closing is done by
// the maintenance sweep on its own cadence, so the window is a FLOOR: a session lives between
// windowSeconds and windowSeconds + maintenance.intervalMinutes. Measured in production on the
// 1.19.0 rollout — a session created at 12:34 was still correlating at 13:21 because the sweep had
// last run at 12:27. No key, type, default or constraint changed; only the `description` string.
// THE-726: rebaselined deliberately. Adds ONE block, `sessions`, with two keys — `autoOpen`
// (boolean, default FALSE) and `windowSeconds` (int, positive, default 1800). The default is the
// privacy posture, not a convenience: server-opened sessions correlate a principal's retrievals,
// which changes what this server retains about who read what, so a config that says nothing gets
// the non-correlating behaviour. No existing key, type, default or constraint moved.
// THE-717: rebaselined deliberately. Adds ONE block, `experiential.citationInfer`, with three keys
// — `enabled` (boolean, default FALSE), `transcriptIndex` (string, OPTIONAL, no default) and
// `intervalHours` (number, default 6). Off by default because the pass cannot run without
// `transcriptIndex`, and nothing in this package can produce one: it needs the ASSISTANT'S answer,
// which no MCP surface hands to a server. A default-on flag pointing at a file that does not exist
// would dead-letter a job on every tick. No existing key, type, default or constraint moved.
// THE-736: rebaselined deliberately for ONE NEW KEY — `sessions.traceContent` (boolean, default
// FALSE). It gates capturing each dispatch's raw parsed arguments onto the session trace, so a
// recorded session can be replayed; the trace previously stored only `args_hash`, which is not
// invertible, so replay was impossible at any effort level. Default off because capturing
// arguments is a capture-posture decision — the same call `experiential.captureContent` is off
// for, and deliberately the same vocabulary rather than a second one. That decision is unowned
// rather than blocked; the poisoning defence it was once deferred to shipped on 2026-07-11.
// No existing key, type, default or constraint moved.
// THE-657: rebaselined deliberately, DESCRIPTION TEXT ONLY. The Windows watcher is enabled, so
// three descriptions that said it is "not active on Windows" are now false. No key, type, default
// or constraint moved; `watch.enabled` and `reconcileIntervalMinutes` are byte-identical apart
// from their prose. The crash was an 8.3 short path reaching libuv, not recursive fs.watch —
// measured on windows-latest, which died under os.tmpdir() and survived twice under a realpath.
// THE-718: rebaselined deliberately, DESCRIPTION TEXT ONLY. `maintenance.retrievalsRetentionDays`
// explained itself by naming the four aggregates a prune rewrites, one of which was
// `outcome_balance` — a chunk_access_stats column that no longer exists after 20260806_001
// replaced it with `observed`. The description named a column, so retiring the column made the
// prose false. No key, type, default or constraint moved.
// THE-644 item 3: rebaselined for a NEW KEY, `experiential.activationDecay` — the first time the
// ACT-R decay exponent is reachable from configuration. Every layer beneath already accepted a
// decay (`recomputeActivation(edb, now, { decay })`, `registerActivationRecompute`'s `deps.decay`)
// and nothing ever supplied one, so the knob existed with no handle and the only way to change it
// was an eval-harness script. Additive, defaulted to the existing 0.5, and threaded to its
// consumer in the same change — this repo has deleted four declared-but-unwired keys.
// THE-540 direction 2: rebaselined deliberately. TWO DEFAULTS MOVED — this is a behavioural change,
// not a prose pass, and it is the whole point of the change rather than a side effect of one.
//
// `experiential.captureContent` and `sessions.traceContent` both went false -> TRUE under the
// trusted-local posture. Both had been off "until the THE-238 poisoning defence lands"; that
// defence landed 2026-07-11, and THE-238 never contained the red-team the comments named, so the
// gate was an event no ticket has ever owned. The controls that DO exist all shipped: layer-1
// poison scan on every capture, secret redaction, size caps, and traces held in cacheDir rather
// than the vault. What was missing was a decision, and it has now been taken.
//
// The cost of leaving them off was concrete: `args_json` NULL on every episode, and `obsidian-tc
// rerun` — 16 commits and 99 tests — exiting 2 on every production record because nothing had
// arguments to re-issue.
//
// `securityProfile: "hardened"` pins both back to false. Content capture is the opposite of
// least-privilege and that profile must not inherit a permissive default.
// THE-424 Part A: rebaselined deliberately, DESCRIPTION TEXT ONLY — but the prose moved because the
// BEHAVIOUR did, which is the opposite of the usual description-only entry above. No key, type,
// default or constraint moved: `experiential.activationRerank` is still a boolean still defaulting
// to false. What changed is that the flag now does what it says. It used to build the
// cached-activation-score lookup and thread it to every M7 graphSearch call while changing no
// ranking, because the bubble pass needs `opts.bubbleSafe.enabled` and nothing under src/ set it —
// the defect THE-535 raised and answered by making the DESCRIPTION honest ("not yet wired"). Part A
// answers it the other way, in the M7 options builder, so the hedge had to go.
// Deliberately NOT a default change: the A/B that would move it off false is THE-424 Part B.
// THE-424: rebaselined for ONE NEW KEY — `indexing.chunkTokens` (int, default 512, bounded
// [64, 8192]). The chunker's `ChunkOptions.maxTokens` has always existed and `chunkNote(body)` was
// always called with no options, so the budget was pinned at an inline 512 and the only way to
// change it was to edit chunk.ts. Same shape as `experiential.activationDecay` before THE-644
// item 3 — a knob with no handle — and fixed the same way: additive, defaulted to the value already
// in force, and threaded to its consumer in the same change rather than declared and left dark.
// No existing key, type, default or constraint moved, and every existing index keeps its exact
// chunk boundaries because the default IS the old hardcoded value.
//
// It also joins the representation fingerprint, which the other capture-posture rebaselines above
// did not have to think about: chunk size is the first axis that changes what a chunk IS rather
// than what its vector MEANS, so two indexes at different budgets must not compare equal.
// THE-806: rebaselined for ONE NEW BLOCK — `retrieval.gatedRerankHardness` (mode `cosine` |
// `zMargin`, hardTop1 0.55, hardZ 1.0, pool 20). This IS the behavioral PR for the change, which is
// what the refusal message above asks for; it is not a hash bumped alongside an unrelated refactor.
//
// The block is additive and its defaults reproduce the shipped gate EXACTLY. `hardZ`/`hardTop1`
// already existed as GraphSearchOptions fields with no config surface at all, and the only non-test
// code that set either was eval/run.ts — so production always took the `top1 < 0.55` branch while
// the harness always took the z-margin one, and the two arms measured different gates. Giving them
// a surface is what makes the arms comparable; flipping `mode` is a ranking change that owes the
// n=250 paired permutation gate and THE-400's unmet acceptance.
//
// Same shape as the THE-424 rebaseline above: a knob with no handle, made additive, defaulted to
// the value already in force, and threaded to its consumer in the same change rather than declared
// and left dark. No existing key, type, default or constraint moved — `retrieval.gatedRerank` stays
// a plain boolean, so no existing config file changes meaning.
const CONFIG_SCHEMA_BASELINE_SHA256 =
  "24330dc14093267a4dd99f3e7c23b994ef7240ca7fc07a586ce0c0eaf0d78fa4";

// The CONVERSION lives in packages/shared (configJsonSchema), not here. A script under scripts/
// resolves its imports from its own directory upward, so importing `zod` here only works when the
// workspace happens to hoist it to the root — true locally, false on the CI runner. Importing the
// shared module by absolute path works either way, and it is the module that owns the schema.
const { configJsonSchema } = await import(
  join(ROOT, "packages", "shared", "src", "config.schema.ts")
);

const schema = configJsonSchema();
schema.$schema = "https://json-schema.org/draft/2020-12/schema";
schema.title = "obsidian-tc server config";
schema.description =
  'Configuration for obsidian-tc. Generated from packages/shared/src/config.schema.ts — do not edit by hand. Add `"$schema": "./obsidian-tc.config.schema.json"` to your config for editor autocomplete.';

const json = `${JSON.stringify(schema, null, 2)}\n`;

// A schema that documented nothing would still be valid JSON and would still pass a naive
// "file exists" check, so assert the descriptions actually survived the conversion. This is the
// only property that makes the artifact worth publishing at all.
const described = (JSON.stringify(schema).match(/"description":/g) ?? []).length;
if (described < 100)
  throw new Error(
    `only ${described} descriptions survived into the JSON Schema; config.schema.ts carries ~187 .describe() calls, so the conversion dropped them and the artifact would be useless`,
  );

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    console.error(`config schema missing: ${OUT}\nRun: bun scripts/gen-config-schema.ts`);
    process.exit(1);
  }
  // Two independent checks, reported separately, because regenerating both files together would
  // hide a change that trips ONLY the hash: staleness (committed file vs regenerated output) says
  // nothing about whether that output still matches the pinned baseline.
  const staleFile = current !== json;
  const actualSha256 = createHash("sha256").update(json).digest("hex");
  const staleHash = actualSha256 !== CONFIG_SCHEMA_BASELINE_SHA256;
  if (staleFile || staleHash) {
    if (staleFile) {
      console.error(
        `config schema is STALE: ${OUT}\nThe Zod schema changed without regenerating.\nRun: bun scripts/gen-config-schema.ts`,
      );
    }
    if (staleHash) {
      console.error(
        `config schema HASH MISMATCH: expected ${CONFIG_SCHEMA_BASELINE_SHA256}, got ${actualSha256}\n` +
          "The emitted JSON Schema bytes no longer match the pinned baseline. If this schema change " +
          "is deliberate, update CONFIG_SCHEMA_BASELINE_SHA256 in scripts/gen-config-schema.ts in its " +
          "own behavioral PR — do not update it as a side effect of an unrelated refactor.",
      );
    }
    process.exit(1);
  }
  console.log(`config schema OK (${described} descriptions, up to date, hash ${actualSha256})`);
} else {
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT} (${described} descriptions)`);
}
