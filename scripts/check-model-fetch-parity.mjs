#!/usr/bin/env node
/**
 * THE-1122 review — model-fetch parity gate between packages/embedder-local/src/model-fetch.ts
 * and packages/reranker-local/src/model-fetch.ts.
 *
 * embedder-local/src/model-fetch.ts is a DELIBERATE MIRROR of reranker-local's own file (see that
 * file's header comment for why it is a mirror and not an import: reranker-local is a pre-existing,
 * independently-published package this ticket does not otherwise touch, and neither optional
 * package may depend on the other or on packages/server). "Mirror, don't share" was the right call
 * for the download/verify PIPELINE, which legitimately differs — embedder-local is catalog-driven
 * (many models, `specFromModelInfo`), reranker-local pins exactly one. But a fixed subset of that
 * pipeline is pure infrastructure with NO model-specific logic at all: the checksum/locking/redirect
 * primitives. THOSE must never drift silently between the two copies — a redirect-host allowlist
 * widened in one file and not the other, or a lock-staleness constant changed in one but not the
 * other, is exactly the kind of split-brain a full source-scan review is unlikely to catch (a
 * reviewer comparing two large files by eye misses a one-line change in one copy).
 *
 * This gate does NOT diff the whole file (that would be constant false-positive noise against the
 * catalog-vs-single-model structural differences that are supposed to exist, and past experience
 * with exactly that shape of gate — see check-facade-parity.mjs's header — is that a noisy gate
 * gets silently ignored). Instead it extracts a fixed, named list of functions/consts
 * (PARITY_SYMBOLS below) from both files and requires each pair to match EXACTLY once comments and
 * whitespace are normalized away (comments are allowed to differ — each file's own "why" framing —
 * logic is not). A symbol that must legitimately diverge (e.g. a size/timeout tuned differently per
 * package) is named in DOCUMENTED_DELTAS with a reason, mirroring check-config-paths.mjs's ALLOWLIST
 * convention, rather than silently dropped from the gate.
 *
 * Floor, matching this repo's other source-scan gates (check-config-paths.mjs, check-boundaries.mjs):
 * a symbol this gate expects to find that is MISSING from either file is a hard failure (parser
 * regression / symbol renamed without updating this gate), never a silent skip.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const EMBEDDER_FILE = "packages/embedder-local/src/model-fetch.ts";
export const RERANKER_FILE = "packages/reranker-local/src/model-fetch.ts";

/** Pure infrastructure — checksum, locking, and the redirect-host allowlist — that carries no
 *  per-model logic and must stay byte-identical (modulo comments) between the two mirrors. */
export const PARITY_SYMBOLS = [
  "sha256File",
  "listRelativeEntries",
  "isIgnoredOsJunk",
  "IGNORED_OS_JUNK_BASENAMES",
  "lockDirFor",
  "readLockOwner",
  "lockAgeMs",
  "writeLockOwnerAtomic",
  "tryAcquireLock",
  "releaseLock",
  "LOCK_WAIT_DEADLINE_MULTIPLIER",
  "DEFAULT_LOCK_STALE_MS",
  "DEFAULT_LOCK_POLL_MS",
  "ALLOWED_DOWNLOAD_HOST_SUFFIXES",
  "isAllowedDownloadHost",
  "hostnameOf",
  "MAX_REDIRECT_HOPS",
  "fetchFollowingAllowedRedirects",
  "downloadFile",
  "sleep",
];

/** Symbols named in PARITY_SYMBOLS that are KNOWN and INTENTIONAL to differ, each with a reason.
 *  Still checked for PRESENCE in both files (a genuinely dropped symbol still fails), just not for
 *  body equality. Empty today — see this gate's own test file for the shape a future entry takes. */
export const DOCUMENTED_DELTAS = new Map([
  [
    "sha256File",
    "embedder-local streams the hash via createReadStream — its largest pinned file is " +
      "nomic-embed-text-v1.5's fp32 export (~547 MB), where readFile's whole-buffer read is real " +
      "extra peak RSS. reranker-local's pinned model is ~23 MB, where the difference is " +
      "immaterial; it was left on readFile rather than churned for no behavioral gain (THE-1122 " +
      "review does not otherwise touch reranker-local — see model-fetch.ts's own header comment).",
  ],
  [
    "downloadFile",
    "embedder-local honors Writable#write()'s backpressure signal (awaits 'drain' before reading " +
      "the next response chunk) — at ~547 MB a fast connection writing to a slow disk can " +
      "otherwise buffer the whole file in memory. Same reasoning and same scope boundary as " +
      "sha256File above: immaterial at reranker-local's ~23 MB, and this ticket does not " +
      "otherwise touch that package.",
  ],
]);

/** Extracts the source text of a top-level `function NAME(...)`, `async function NAME(...)`, or
 *  `const NAME = ...` declaration, including its full body, by brace/bracket depth-matching from
 *  the first `{`/`[` after the declaration head to its match. Returns undefined if `name` is not
 *  declared at the top level of `source` in one of those three shapes — this gate's PARITY_SYMBOLS
 *  are all one of those three shapes today (verified by the fact every one of them extracts). */
export function extractSymbol(source, name) {
  const headRe = new RegExp(
    `(?:^|\\n)(?:export )?(?:async )?(?:function ${name}\\s*\\(|const ${name}\\s*=)`,
  );
  const head = headRe.exec(source);
  if (!head) return undefined;
  const declStart = head.index + (head[0].startsWith("\n") ? 1 : 0);
  let i = head.index + head[0].length;
  while (i < source.length && source[i] !== "{" && source[i] !== "[" && source[i] !== ";") i++;
  if (i >= source.length) return undefined;
  if (source[i] === ";") return source.slice(declStart, i + 1).trim();
  const open = source[i];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let j = i;
  for (; j < source.length; j++) {
    if (source[j] === open) depth++;
    else if (source[j] === close) {
      depth--;
      if (depth === 0) {
        j++;
        break;
      }
    }
  }
  if (depth !== 0) return undefined; // unbalanced -- treat as "could not extract", not a false match
  if (source[j] === ";") j++; // include a trailing `const NAME = [...];` semicolon when present
  return source.slice(declStart, j).trim();
}

/** Comments (both styles) and all whitespace runs stripped, so two logically-identical bodies with
 *  different comments/formatting normalize equal, but any token-level change does not. */
export function normalizeBody(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pure comparison over two already-read source strings — no filesystem access, so directly
 * unit-testable with fabricated fixtures (mirrors compareFacade's shape in check-facade-parity.mjs).
 */
export function compareModelFetchFiles({ embedderSource, rerankerSource }) {
  const results = [];
  for (const name of PARITY_SYMBOLS) {
    const embedderBody = extractSymbol(embedderSource, name);
    const rerankerBody = extractSymbol(rerankerSource, name);
    if (embedderBody === undefined || rerankerBody === undefined) {
      results.push({
        name,
        status: "missing",
        missingIn: [
          embedderBody === undefined ? EMBEDDER_FILE : null,
          rerankerBody === undefined ? RERANKER_FILE : null,
        ].filter(Boolean),
      });
      continue;
    }
    if (DOCUMENTED_DELTAS.has(name)) {
      results.push({ name, status: "documented-delta", reason: DOCUMENTED_DELTAS.get(name) });
      continue;
    }
    const match = normalizeBody(embedderBody) === normalizeBody(rerankerBody);
    results.push({ name, status: match ? "match" : "drift" });
  }
  return results;
}

function main() {
  const embedderSource = readFileSync(join(ROOT, EMBEDDER_FILE), "utf8");
  const rerankerSource = readFileSync(join(ROOT, RERANKER_FILE), "utf8");
  const results = compareModelFetchFiles({ embedderSource, rerankerSource });

  let failed = false;
  for (const result of results) {
    if (result.status === "match") {
      console.log(`model-fetch-parity: ${result.name} — matches.`);
    } else if (result.status === "documented-delta") {
      console.log(`model-fetch-parity: ${result.name} — documented delta (${result.reason}).`);
    } else if (result.status === "missing") {
      console.error(
        `model-fetch-parity: ${result.name} — expected in both files, missing from: ` +
          `${result.missingIn.join(", ")}. Either it was renamed/removed (update this gate's ` +
          "PARITY_SYMBOLS to match) or a real symbol was dropped.",
      );
      failed = true;
    } else {
      console.error(
        `model-fetch-parity: ${result.name} — DRIFTED between ${EMBEDDER_FILE} and ` +
          `${RERANKER_FILE}. This symbol is pure download/lock/checksum infrastructure with no ` +
          "model-specific logic, so the two copies are expected to match exactly (modulo comments). " +
          "If this divergence is intentional, add it to DOCUMENTED_DELTAS in " +
          "scripts/check-model-fetch-parity.mjs with a reason; otherwise apply the same fix to both files.",
      );
      failed = true;
    }
  }

  process.exit(failed ? 1 : 0);
}

// Importing this module (as its test file does) must have no side effects — no filesystem reads,
// no process.exit. Only run the gate when this file is the process entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
