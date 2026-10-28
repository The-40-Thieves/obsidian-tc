// Tests for scripts/check-model-pins.mjs (GH #1161). The gate must be GREEN on the real repo and RED
// on each way the pinned embedder identity can drift: a bumped pin with a stale artifact, a
// hand-edited artifact, and a Python script that restates a pin as a literal.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPins,
  checkPins,
  findRestatedPins,
  MODEL_INFO_FILE,
  PINS_FILE,
  PY_DIR,
  PY_EMBEDDER_RE,
  pinsToWrite,
} from "./check-model-pins.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const info = await import(pathToFileURL(join(ROOT, MODEL_INFO_FILE)).href);
const committedJson = readFileSync(join(ROOT, PINS_FILE), "utf8");
const pyFiles = readdirSync(join(ROOT, PY_DIR))
  .filter((n) => PY_EMBEDDER_RE.test(n))
  .map((n) => ({ name: n, source: readFileSync(join(ROOT, PY_DIR, n), "utf8") }));

const run = (over = {}) =>
  checkPins({
    catalog: info.MODEL_CATALOG,
    pinnedFilesFor: info.pinnedFilesFor,
    dtypeFor: info.dtypeFor,
    committedJson,
    pyFiles,
    ...over,
  });

/** model-info's catalog with one field changed on the nomic entry, as a pin bump would. */
const driftedCatalog = (patch) =>
  info.MODEL_CATALOG.map((m) => (m.name === "nomic-embed-text-v1.5" ? patch(m) : m));

test("GREEN: the committed artifact equals model-info.ts and the real Python restates nothing", () => {
  assert.deepEqual(run().problems, []);
});

test("floor: the real run scanned a Python script and the nomic fp32 pins are in the artifact", () => {
  assert.ok(pyFiles.some((f) => f.name === "modal_embed_nomic.py"));
  const nomic = JSON.parse(committedJson).models["nomic-embed-text-v1.5"];
  assert.equal(nomic.dimensions, 768);
  assert.equal(nomic.variants.fp32.files.length, 4);
});

test("RED: a bumped revision in model-info.ts with a stale artifact", () => {
  const catalog = driftedCatalog((m) => ({ ...m, revision: "0".repeat(40) }));
  const { problems } = run({ catalog });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not match .*model-info\.ts.*--write/);
});

test("RED: a drifted sha256 in model-info.ts", () => {
  const catalog = driftedCatalog((m) => ({
    ...m,
    fp32: { ...m.fp32, onnxFile: { ...m.fp32.onnxFile, sha256: "f".repeat(64) } },
  }));
  assert.match(run({ catalog }).problems[0], /does not match/);
});

test("RED: a hand-edited artifact", () => {
  const edited = JSON.parse(committedJson);
  edited.models["nomic-embed-text-v1.5"].dimensions = 384;
  assert.match(run({ committedJson: JSON.stringify(edited) }).problems[0], /does not match/);
});

test("RED: an artifact that is not JSON", () => {
  assert.match(run({ committedJson: "{oops" }).problems[0], /not valid JSON/);
});

test("RED: the Python restating the repo id, the revision, or a checksum as a literal", () => {
  const nomic = info.modelInfoByName("nomic-embed-text-v1.5");
  const leaks = [
    `MODEL_ID = "${nomic.modelId}"`,
    `REVISION = "${nomic.revision}"`,
    `"onnx/model.onnx": "${nomic.fp32.onnxFile.sha256}",`,
    `PIN = "${"a".repeat(64)}"`,
  ];
  for (const source of leaks) {
    const { problems } = run({ pyFiles: [{ name: "modal_embed_x.py", source }] });
    assert.equal(problems.length > 0, true, source);
    assert.match(problems[0], /modal_embed_x\.py restates a pinned value/);
  }
});

test("RED: an empty catalog, and zero Python files scanned, are failures not silent passes", () => {
  assert.match(run({ catalog: [] }).problems[0], /empty catalog/);
  assert.match(run({ pyFiles: [] }).problems.join("\n"), /scanned nothing/);
});

const committed = JSON.parse(committedJson);
/** The committed artifact with one hand edit applied, as JSON text. */
const mutant = (patch) => {
  const c = structuredClone(committed);
  patch(c);
  return JSON.stringify(c);
};

test("evalOnly: a malformed entry is refused, naming the field", () => {
  const cases = [
    [
      (c) => (c.evalOnly["embeddinggemma-2"].revision = "not-a-commit"),
      /evalOnly\.embeddinggemma-2\.revision must be a 40-hex/,
    ],
    [
      (c) => delete c.evalOnly["embeddinggemma-2"].files,
      /evalOnly\.embeddinggemma-2\.files must be a non-empty array/,
    ],
    [
      (c) => (c.evalOnly["embeddinggemma-2"].files[0].sha256 = "abc"),
      /files\[0\]\.sha256 must be 64-hex/,
    ],
    [
      (c) => (c.evalOnly["embeddinggemma-2"].format = "gguf"),
      /format must be "safetensors" or "onnx"/,
    ],
    [
      (c) => (c.evalOnly["embeddinggemma-2"].files[1].sizeBytes = 0),
      /files\[1\]\.sizeBytes must be a positive integer/,
    ],
    [
      (c) => (c.evalOnly["embeddinggemma-2"].files[0].note = "a hand-added key"),
      /evalOnly\.embeddinggemma-2\.files\[0\]\.note is not an allowed key/,
    ],
  ];
  for (const [patch, pattern] of cases) {
    assert.match(run({ committedJson: mutant(patch) }).problems.join("\n"), pattern);
  }
});

test("evalOnly: an unknown top-level key is a failure", () => {
  const problems = run({ committedJson: mutant((c) => (c.extra = {})) }).problems;
  assert.match(problems.join("\n"), /unknown top-level key "extra"/);
});

test("evalOnly: --write keeps the block verbatim, and the written artifact passes the gate", () => {
  const next = pinsToWrite({
    catalog: info.MODEL_CATALOG,
    pinnedFilesFor: info.pinnedFilesFor,
    dtypeFor: info.dtypeFor,
    committedJson,
  });
  assert.deepEqual(next.evalOnly, committed.evalOnly);
  assert.deepEqual(next.models, committed.models);
  assert.deepEqual(run({ committedJson: JSON.stringify(next) }).problems, []);
});

test("evalOnly: --write refuses to regenerate over a file whose evalOnly block it cannot read", () => {
  assert.throws(
    () =>
      pinsToWrite({
        catalog: info.MODEL_CATALOG,
        pinnedFilesFor: info.pinnedFilesFor,
        dtypeFor: info.dtypeFor,
        committedJson: "{oops",
      }),
    /evalOnly/,
  );
});

test("evalOnly: a Python file restating an eval-only repo id is refused", () => {
  const source = `MODEL = "${committed.evalOnly["embeddinggemma-2"].modelId}"`;
  const { problems } = run({ pyFiles: [{ name: "modal_embed_gemma2.py", source }] });
  assert.match(
    problems.join("\n"),
    /modal_embed_gemma2\.py restates a pinned value \(repo id "google\/embeddinggemma-2"\)/,
  );
});

test("findRestatedPins: a plain script with no pinned literal is clean", () => {
  assert.deepEqual(findRestatedPins('PINS = load_pins("pins.json")', info.MODEL_CATALOG), []);
});

test("buildPins: every catalog model carries both variants with their checksummed files", () => {
  const pins = buildPins(info.MODEL_CATALOG, info.pinnedFilesFor, info.dtypeFor);
  assert.deepEqual(Object.keys(pins.models), info.catalogModelNames());
  for (const m of Object.values(pins.models)) {
    assert.ok(m.variants.fp32.files.some((f) => f.path === "onnx/model.onnx"));
    assert.ok(m.variants.q8.files.some((f) => f.path === "onnx/model_quantized.onnx"));
  }
});

test("evalOnly: a zero or negative width is refused", () => {
  const problems = run({
    committedJson: mutant((c) => (c.evalOnly["embeddinggemma-2"].dimensions = 0)),
  }).problems;
  assert.match(
    problems.join("\n"),
    /evalOnly\.embeddinggemma-2\.dimensions must be a positive integer/,
  );
});

test("evalOnly: two files with the same path are refused, naming the second", () => {
  const problems = run({
    committedJson: mutant((c) => {
      const files = c.evalOnly["embeddinggemma-2"].files;
      files[1].path = files[0].path;
    }),
  }).problems;
  assert.match(problems.join("\n"), /files\[1\]\.path duplicates an earlier file's path/);
});

test("evalOnly: an unknown key on an entry is refused (a misspelt pin cannot ride along)", () => {
  const problems = run({
    committedJson: mutant((c) => (c.evalOnly["embeddinggemma-2"].commit = "0".repeat(40))),
  }).problems;
  assert.match(problems.join("\n"), /evalOnly\.embeddinggemma-2 has unknown key "commit"/);
});

test("evalOnly: an empty block is refused, not a pass with nothing pinned", () => {
  const problems = run({ committedJson: mutant((c) => (c.evalOnly = {})) }).problems;
  assert.match(problems.join("\n"), /evalOnly must name at least one eval model/);
});

test("evalOnly: --write refuses an unknown top-level key rather than dropping it", () => {
  const committedWithTypo = JSON.stringify({ ...committed, evalonly: committed.evalOnly });
  assert.throws(
    () =>
      pinsToWrite({
        catalog: info.MODEL_CATALOG,
        pinnedFilesFor: info.pinnedFilesFor,
        dtypeFor: info.dtypeFor,
        committedJson: committedWithTypo,
      }),
    /unknown top-level key "evalonly"/,
  );
});
