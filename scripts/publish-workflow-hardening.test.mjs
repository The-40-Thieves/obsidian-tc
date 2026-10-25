import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const WORKFLOWS = resolve(import.meta.dirname, "../.github/workflows");
const read = (name) => readFileSync(resolve(WORKFLOWS, name), "utf8");

/** Splits a workflow into `{ name, body }` per top-level job (two-space indented key under `jobs:`). */
function jobsOf(workflow) {
  const jobs = [];
  const re =
    /^ {2}([a-zA-Z][a-zA-Z0-9_-]*):\n([\s\S]*?)(?=^ {2}[a-zA-Z][a-zA-Z0-9_-]*:\n|(?![\s\S]))/gm;
  for (const m of workflow.matchAll(re)) jobs.push({ name: m[1], body: m[2] });
  return jobs;
}

const isComment = (line) => line.trim().startsWith("#");

// ---- item 1: syft is a pinned, sha256-verified tarball -----------------------------------------

const PUBLISH = read("publish.yml");
const SYFT_STEP = PUBLISH.match(/- name: syft — SBOM[\s\S]*?(?=\n {6}- name: )/)?.[0] ?? "";
const SYFT_SHA256 = "7aa2f03ee92739cf643279ba3990548b9925d4e22cae13f46831ee62821147fe";

test("syft: the SBOM step is found in publish.yml", () => {
  assert.ok(SYFT_STEP.length > 0, "the syft step is missing");
});

test("syft: no remote install script is piped to sh", () => {
  assert.doesNotMatch(SYFT_STEP, /install\.sh/);
  assert.doesNotMatch(SYFT_STEP, /\|\s*sh\b/);
});

test("syft: downloads the pinned v1.49.0 linux amd64 tarball over https only", () => {
  assert.match(
    SYFT_STEP,
    /curl --proto '=https' --tlsv1\.2 -sSfL -o "\$RUNNER_TEMP\/syft\.tar\.gz" \\?\n?\s*https:\/\/github\.com\/anchore\/syft\/releases\/download\/v1\.49\.0\/syft_1\.49\.0_linux_amd64\.tar\.gz/,
  );
});

test("syft: verifies the tarball against the pinned sha256 before extracting it", () => {
  assert.match(
    SYFT_STEP,
    new RegExp(`echo "${SYFT_SHA256}  \\$RUNNER_TEMP/syft\\.tar\\.gz" \\| sha256sum -c -`),
  );
  const verify = SYFT_STEP.indexOf("sha256sum -c");
  const extract = SYFT_STEP.indexOf("tar -xzf");
  assert.ok(verify >= 0 && extract > verify, "extraction must come after the checksum");
  assert.match(
    SYFT_STEP,
    /tar -xzf "\$RUNNER_TEMP\/syft\.tar\.gz" -C "\$RUNNER_TEMP\/syft-bin" syft/,
  );
});

test("syft: keeps continue-on-error and the ::warning:: fallback", () => {
  assert.match(SYFT_STEP, /continue-on-error: true/);
  assert.match(SYFT_STEP, /::warning::image SBOM generation failed/);
});

// ---- item 2: --ignore-scripts on every install in a job that holds id-token: write -------------

test("ignore-scripts: every bun install in a job with id-token: write passes --ignore-scripts", () => {
  const checked = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"))) {
    for (const job of jobsOf(read(file))) {
      if (!/^\s*id-token: write\b/m.test(job.body)) continue;
      const installs = job.body
        .split("\n")
        .filter((line) => !isComment(line) && /\bbun install\b/.test(line));
      for (const line of installs) {
        checked.push(`${file}:${job.name}`);
        assert.match(line, /--ignore-scripts/, `${file} job ${job.name}: ${line.trim()}`);
      }
    }
  }
  assert.ok(
    checked.length >= 4,
    `expected the publish installs to be checked, saw ${checked.length}`,
  );
});
