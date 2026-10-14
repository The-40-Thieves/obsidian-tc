import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const ENTRY = join(ROOT, "scripts", "lib", "embedder-package-entry.mjs");
const SOURCE = join(ROOT, "packages", "embedder-local", "src", "index.ts");
const BASE_NAME = "@the-40-thieves/obsidian-tc-embedder-local";
const HOST_KEY = `${process.platform}-${process.arch}`;
const RUNTIME_NAME = `${BASE_NAME}-${HOST_KEY}`;
const tempDirs = [];

if (!existsSync(ENTRY)) await import(pathToFileURL(ENTRY).href);

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runtimeExportNames() {
  const source = readFileSync(SOURCE, "utf8");
  const names = new Set();
  for (const match of source.matchAll(
    /^export (?:async )?(?:function|const)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export \{([^}]+)\} from /gm)) {
    for (const part of match[1].split(","))
      names.add(
        part
          .trim()
          .split(/\s+as\s+/)
          .at(-1),
      );
  }
  return [...names].sort();
}

function stage({ runtime = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "obtc-package-entry-"));
  tempDirs.push(root);
  const scope = join(root, "node_modules", "@the-40-thieves");
  const base = join(scope, "obsidian-tc-embedder-local");
  mkdirSync(base, { recursive: true });
  cpSync(ENTRY, join(base, "index.mjs"));
  const names = runtimeExportNames();
  writeFileSync(
    join(base, "embedder.mjs"),
    `${names.map((name) => `export const ${name} = ${JSON.stringify(name)};`).join("\n")}\n`,
  );
  writeFileSync(
    join(base, "package.json"),
    JSON.stringify({ name: BASE_NAME, type: "module", exports: { ".": "./index.mjs" } }),
  );
  const runtimeDir = join(scope, `obsidian-tc-embedder-local-${HOST_KEY}`);
  if (runtime) {
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "package.json"), JSON.stringify({ name: RUNTIME_NAME }));
  }
  return { root, runtimeDir, names };
}

function run(root, source) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: root,
    encoding: "utf8",
  });
}

test("the installed host runtime is selected before the stub bundle loads and all exports pass through", () => {
  const { root, runtimeDir, names } = stage();
  const result = run(
    root,
    `const mod = await import(${JSON.stringify(BASE_NAME)}); console.log(JSON.stringify({dir: globalThis[Symbol.for("obsidian-tc.ort-dir")], exports: Object.keys(mod).sort()}));`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { dir: runtimeDir, exports: names });
});

test("a missing host runtime rejects with a stable code and names the package", () => {
  const { root } = stage({ runtime: false });
  const result = run(
    root,
    `try { await import(${JSON.stringify(BASE_NAME)}); } catch (error) { console.log(JSON.stringify({code: error.code, message: error.message})); }`,
  );
  assert.equal(result.status, 0, result.stderr);
  const failure = JSON.parse(result.stdout);
  assert.equal(failure.code, "OBTC_EMBEDDER_RUNTIME_MISSING");
  assert.match(failure.message, new RegExp(RUNTIME_NAME));
  assert.match(failure.message, /--omit=optional|--no-optional/);
  assert.match(failure.message, /no runtime is published|musl/i);
});

test("a preset runtime directory skips package resolution", () => {
  const { root, names } = stage({ runtime: false });
  const preset = join(root, "preset-runtime");
  const result = run(
    root,
    `globalThis[Symbol.for("obsidian-tc.ort-dir")] = ${JSON.stringify(preset)}; const mod = await import(${JSON.stringify(BASE_NAME)}); console.log(JSON.stringify({dir: globalThis[Symbol.for("obsidian-tc.ort-dir")], exports: Object.keys(mod).sort()}));`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { dir: preset, exports: names });
});

test("the package entry exports exactly the source module's runtime value surface", () => {
  const { root, names } = stage();
  const result = run(
    root,
    `const mod = await import(${JSON.stringify(BASE_NAME)}); console.log(JSON.stringify(Object.keys(mod).sort()));`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), names);
});
