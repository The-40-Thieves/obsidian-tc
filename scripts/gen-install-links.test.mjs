// Tests for scripts/gen-install-links.mjs.
//
// The deep links are an encoding of the server's launch config, so they are checked by DECODING
// them and comparing with the config derived from server.json, never by comparing one encoded
// string to another. Hand-encoded base64 and percent-encoded payloads rot; these tests are why
// they cannot.
//
// Formats (vendor docs, fetched 2026-10-10):
//   VS Code:  vscode:mcp/install?{url-encoded JSON}   (code.visualstudio.com/api/extension-guides/ai/mcp)
//   Cursor:   cursor://anysphere.cursor-deeplink/mcp/install?name=<name>&config=<base64 JSON>
//             (cursor.com/docs/context/mcp/install-links)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BEGIN_MARKER,
  checkTargets,
  END_MARKER,
  INSTALL_TARGETS,
  installLinks,
  renderRegion,
  replaceRegion,
} from "./gen-install-links.mjs";
import { launchConfig } from "./lib/launch-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const launch = launchConfig();
const links = installLinks();

// What an MCP client config entry for this server looks like.
const expectedServer = {
  command: launch.command,
  args: launch.args,
  env: { [launch.configEnv]: launch.configPlaceholder },
};

test("launch config comes from server.json: npx -y <npm identifier>, required config env var", () => {
  const server = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8"));
  const pkg = server.packages.find((p) => p.registryType === "npm");
  assert.equal(launch.args.at(-1), pkg.identifier);
  const required = pkg.environmentVariables.filter((e) => e.isRequired).map((e) => e.name);
  assert.deepEqual(required, [launch.configEnv]);
  assert.equal(launch.command, "npx");
});

test("vscode link: scheme, handler path, and the decoded payload is the launch config", () => {
  for (const [key, scheme] of [
    ["vscode", "vscode:"],
    ["vscodeInsiders", "vscode-insiders:"],
  ]) {
    const url = links[key];
    assert.ok(url.startsWith(`${scheme}mcp/install?`), url);
    const payload = JSON.parse(decodeURIComponent(url.slice(url.indexOf("?") + 1)));
    assert.deepEqual(payload, { name: "obsidian-tc", type: "stdio", ...expectedServer });
  }
});

test("cursor link: name param plus a base64 config that decodes to the launch config", () => {
  const url = new URL(links.cursor);
  assert.equal(url.protocol, "cursor:");
  assert.equal(url.host, "anysphere.cursor-deeplink");
  assert.equal(url.pathname, "/mcp/install");
  assert.equal(url.searchParams.get("name"), "obsidian-tc");
  const b64 = url.searchParams.get("config");
  assert.match(b64, /^[A-Za-z0-9+/]+={0,2}$/);
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  assert.deepEqual(payload, expectedServer, "config is the server object WITHOUT a name key");
  assert.equal(Buffer.from(JSON.stringify(payload)).toString("base64"), b64, "canonical encoding");
});

test("every link payload is the same object a user would paste by hand", () => {
  const byHand = JSON.parse(
    '{"command":"npx","args":["-y","obsidian-tc"],"env":{"OBSIDIAN_TC_CONFIG":"/ABSOLUTE/PATH/TO/obsidian-tc.config.json"}}',
  );
  assert.deepEqual(expectedServer, byHand);
});

test("region helpers: render is bracketed by the markers and replaceRegion is idempotent", () => {
  const region = renderRegion(links);
  assert.ok(region.startsWith(BEGIN_MARKER) && region.endsWith(END_MARKER));
  const doc = `before\n${BEGIN_MARKER}\nstale\n${END_MARKER}\nafter\n`;
  const once = replaceRegion(doc, region);
  assert.equal(once, `before\n${region}\nafter\n`);
  assert.equal(replaceRegion(once, region), once);
});

test("replaceRegion refuses a document without exactly one marker pair", () => {
  assert.throws(() => replaceRegion("no markers\n", "x"), /marker/);
  const twice = `${BEGIN_MARKER}\n${END_MARKER}\n${BEGIN_MARKER}\n${END_MARKER}\n`;
  assert.throws(() => replaceRegion(twice, "x"), /marker/);
});

test("committed README and install page carry exactly the generated region (and each decodes)", () => {
  assert.deepEqual(INSTALL_TARGETS, [
    "README.md",
    "docs/src/content/docs/getting-started/install.md",
  ]);
  const problems = checkTargets(ROOT);
  assert.deepEqual(problems, []);
  for (const f of INSTALL_TARGETS) {
    const text = readFileSync(join(ROOT, f), "utf8");
    assert.ok(text.includes(links.cursor), `${f} has the cursor link`);
    assert.ok(text.includes(links.vscode), `${f} has the vscode link`);
  }
});

test("checkTargets reports a stale region instead of passing", () => {
  const problems = checkTargets(ROOT, (f) =>
    readFileSync(join(ROOT, f), "utf8").replace("obsidian-tc.config.json", "other.config.json"),
  );
  assert.ok(problems.length >= 1);
  assert.match(problems[0], /out of date/);
});
