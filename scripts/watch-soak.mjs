#!/usr/bin/env node
// THE-657 — does a LONG-LIVED recursive fs.watch survive on Windows, the way a real server holds
// one, rather than the way vitest churns them?
//
// THE OPEN QUESTION, restated. On `build-test (windows-latest)`, two independent CI runs saw the
// vitest WORKER PROCESS die outright — no exception, no failing assertion — and the counts
// localised it to the 8 `event delivery` tests exactly. `registerVaultWatch` therefore returns a
// no-op on win32. But the test process creates and tears down many watchers in quick succession,
// while a server creates ONE per vault at boot and holds it for its lifetime. Those are different
// enough that the crash may not generalise, and nobody had checked.
//
// THE TICKET SAYS "CI CANNOT ANSWER IT". That is true of VITEST and not of the runner. A vitest
// worker dying takes the reporter with it, so there is nothing left to print a result. A standalone
// process has no such problem: if it dies, the step's exit code IS the report, and if it survives
// it prints its own counters. This file is that process.
//
// It also serves the ticket's OTHER branch. Step 3 says a Node bug report "needs a minimal repro,
// which the vitest failure is not" — this is that repro: no vitest, no test framework, one watcher,
// plain node.
//
// WATCHER OPTIONS ARE COPIED FROM THE REAL ONE, deliberately. `{ recursive: true, persistent: false }`
// matches vault/watcher.ts exactly. `persistent: false` is load-bearing there and must not become
// `unref()`: measured on Linux 6.17 / node 26, `watch(dir, {recursive:true})` + `w.unref()` NEVER
// lets the process exit, because Node backs a recursive watch with a tree of internal per-directory
// watchers and unref'ing the parent does not propagate. That shipped briefly and hung install-smoke
// for 20 minutes. A repro that changed the options would answer a different question.
//
// Usage:  node scripts/watch-soak.mjs [--files N] [--edits N] [--seconds N] [--dir PATH]
// Exit:   0 = survived (see the printed counters).  Anything else, or no output at all, is the
//         finding — a process that vanishes mid-run is exactly what this is looking for.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined ? fallback : v;
}

const FILES = Number(arg("files", 400));
const EDITS = Number(arg("edits", 2000));
const SECONDS = Number(arg("seconds", 60));
const DIR = arg("dir", "");
const REALPATH = process.argv.includes("--realpath");

// A realistic vault is nested, not flat: Node backs a recursive watch with a per-directory tree, so
// a flat directory would exercise one internal watcher and prove nothing about the tree that
// allegedly kills the process.
const FOLDERS = [
  "00-inbox",
  "02-projects",
  "05-creative/Aedras",
  "08-research/ai",
  "09-reference/decisions",
];

// THE-657 follow-up: --realpath resolves the root through realpathSync before watching.
//
// The Windows crash is an ASSERTION INSIDE LIBUV, not a Node-level error:
//   Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\\win\\fs-event.c, line 72
// libuv compares each event's filename against the watched directory string. On the GitHub runner
// os.tmpdir() resolves to `C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\...` — an 8.3 SHORT NAME — while
// events arrive carrying the long form, so the prefix compare fails and libuv aborts the process.
//
// That makes the path SHAPE a confound: a crash under tmpdir does not prove recursive watch is
// broken on Windows, only that this path shape is. --dir (a long, real path) and --realpath
// (short -> long) are the two knobs that separate those, and separating them is the difference
// between "keep the win32 gate forever" and "resolve the path and delete it".
const rawRoot = DIR || mkdtempSync(join(tmpdir(), "otc-watch-soak-"));
const root = REALPATH ? realpathSync.native(rawRoot) : rawRoot;
let created = 0;
for (const f of FOLDERS) mkdirSync(join(root, f), { recursive: true });
for (let i = 0; i < FILES; i++) {
  const folder = FOLDERS[i % FOLDERS.length];
  writeFileSync(join(root, folder, `note-${i}.md`), `# note ${i}\n\nseed body\n`);
  created++;
}

let events = 0;
let errors = 0;
let nullNames = 0;
const started = Date.now();

process.stdout.write(
  `watch-soak: node ${process.version} on ${process.platform}/${process.arch}\n` +
    `watch-soak: root=${root}${REALPATH ? ` (realpath from ${rawRoot})` : ""} files=${created} folders=${FOLDERS.length} edits=${EDITS} seconds=${SECONDS}\n`,
);

// ONE watcher, held for the whole run — the shape a server has.
const w = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
  if (filename === null) {
    nullNames++;
    return;
  }
  events++;
});
w.on("error", (e) => {
  errors++;
  process.stdout.write(`watch-soak: watcher error: ${e?.message ?? e}\n`);
});

process.stdout.write("watch-soak: watcher registered, generating edit traffic\n");

// Edit traffic spread across the run rather than in one burst: a burst measures coalescing, a
// spread measures whether the watcher stays alive under sustained churn, which is the question.
const intervalMs = Math.max(1, Math.floor((SECONDS * 1000) / EDITS));
let edits = 0;
// `persistent: false` means the watcher does NOT hold the loop open — so the timer is what keeps
// this process alive. That is the same reason the real server stays up on its own listeners rather
// than on the watcher, and it is why removing `persistent: false` there changes process lifetime.
const timer = setInterval(() => {
  try {
    const folder = FOLDERS[edits % FOLDERS.length];
    writeFileSync(
      join(root, folder, `note-${edits % FILES}.md`),
      `# note\n\nedit ${edits} @ ${Date.now()}\n`,
    );
    edits++;
  } catch (e) {
    errors++;
    process.stdout.write(`watch-soak: write error: ${e?.message ?? e}\n`);
  }
  if (edits >= EDITS || Date.now() - started >= SECONDS * 1000) {
    clearInterval(timer);
    finish();
  }
  // Heartbeat, so a process that dies mid-run leaves a partial trail showing HOW FAR it got. A
  // silent death with no output cannot be distinguished from a runner that never started.
  if (edits % 250 === 0) {
    process.stdout.write(
      `watch-soak: ...${edits} edits, ${events} events, ${Math.round((Date.now() - started) / 1000)}s\n`,
    );
  }
}, intervalMs);

function finish() {
  const elapsed = Math.round((Date.now() - started) / 1000);
  try {
    w.close();
  } catch (e) {
    errors++;
    process.stdout.write(`watch-soak: close error: ${e?.message ?? e}\n`);
  }
  process.stdout.write(
    `watch-soak: SURVIVED elapsed=${elapsed}s edits=${edits} events=${events} nullNames=${nullNames} errors=${errors}\n`,
  );
  // Cleanup is best-effort: on Windows a file can stay locked briefly after a write, and failing
  // the run over tmp cleanup would report a janitorial problem as a watcher finding.
  if (!DIR) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      process.stdout.write("watch-soak: temp cleanup skipped (locked); harmless\n");
    }
  }
  // A watcher that delivered NOTHING is not a pass. On a platform where the watch silently does not
  // work, the process survives trivially and would otherwise be reported as success — the
  // registered-is-not-emitting shape.
  if (events === 0) {
    process.stdout.write(
      "watch-soak: FAIL — zero events delivered; the watch is inert, not healthy\n",
    );
    process.exit(1);
  }
  process.exit(0);
}
