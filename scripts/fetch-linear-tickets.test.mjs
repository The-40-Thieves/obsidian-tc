// Refs #1482. Remote text — the HTTP reason phrase, GraphQL error bodies, transport-error
// messages — must reach stderr with control characters neutralized, so a hostile or broken
// upstream cannot forge extra diagnostic lines or terminal control sequences. The integration
// cases run the real script as a child process against a local server via LINEAR_API_URL.
// The child must be spawned ASYNC: it calls back into this process's server, and a synchronous
// spawn would freeze the event loop that has to answer it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { escapeDiagnostic } from "./lib/diagnostic-text.mjs";

const SCRIPT = fileURLToPath(new URL("./fetch-linear-tickets.mjs", import.meta.url));

function runScript(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, LINEAR_API_KEY: "lin_api_test", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// Every diagnostic the script writes carries the `fetch-linear-tickets:` prefix, so a forged
// line — one created by a raw CR/LF inside remote text — is exactly a line without it.
function diagnosticLines(stderr) {
  return stderr.split("\n").filter((line) => line.length > 0);
}

function assertNoRawControls(stderr) {
  for (const line of diagnosticLines(stderr)) {
    for (const ch of line) {
      const code = ch.codePointAt(0);
      assert.ok(
        code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f),
        `raw control character U+${code.toString(16).padStart(4, "0")} in stderr line: ${JSON.stringify(line)}`,
      );
    }
  }
}

function assertAllLinesPrefixed(stderr) {
  for (const line of diagnosticLines(stderr)) {
    assert.ok(
      line.startsWith("fetch-linear-tickets:"),
      `forged or unprefixed diagnostic line: ${JSON.stringify(line)}`,
    );
  }
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}/graphql`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("escapeDiagnostic", () => {
  it("maps named C0 controls to visible escapes", () => {
    assert.equal(escapeDiagnostic("a\nb\rc\td\x1be"), "a\\nb\\rc\\td\\ee");
  });

  it("maps DEL and C1 controls to \\u00xx escapes", () => {
    assert.equal(escapeDiagnostic("\x7f\x85\x9b"), "\\u007f\\u0085\\u009b");
  });

  it("leaves printable text, including workflow-command-shaped text, untouched", () => {
    assert.equal(escapeDiagnostic("ok ::error:: é 🚀"), "ok ::error:: é 🚀");
  });

  it("stringifies non-string input", () => {
    assert.equal(escapeDiagnostic(42), "42");
  });
});

describe("fetch-linear-tickets stderr hardening", () => {
  it("escapes control characters in the HTTP reason phrase", async () => {
    await withServer(
      (_req, res) => {
        // A tab is the one C0 control an HTTP/1.1 reason phrase can legally carry.
        res.writeHead(429, "Slow down\t::error::forged");
        res.end("{}");
      },
      async (url) => {
        const r = await runScript({ LINEAR_API_URL: url });
        assert.equal(r.status, 1);
        assert.equal(r.stdout, "");
        assert.match(r.stderr, /HTTP 429/);
        assert.ok(r.stderr.includes("\\t"), "tab must be visibly escaped");
        assertNoRawControls(r.stderr);
        assertAllLinesPrefixed(r.stderr);
      },
    );
  });

  it("escapes CR/LF, ESC and C1 bytes inside GraphQL error bodies", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ errors: [{ message: "bad\r\n::error::forged\u001b[31m\u009bX" }] }),
        );
      },
      async (url) => {
        const r = await runScript({ LINEAR_API_URL: url });
        assert.equal(r.status, 1);
        assertNoRawControls(r.stderr);
        assertAllLinesPrefixed(r.stderr);
        assert.ok(!r.stderr.includes("\u009b"), "raw C1 control must not reach stderr");
      },
    );
  });

  it("keeps the transport-error diagnostic to one prefixed line", async () => {
    // A just-closed port gives ECONNREFUSED, exercising the request-failed branch.
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    const r = await runScript({ LINEAR_API_URL: `http://127.0.0.1:${port}/graphql` });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /request failed/);
    assertNoRawControls(r.stderr);
    assertAllLinesPrefixed(r.stderr);
  });

  it("keeps stdout valid machine-readable JSON on success", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ identifier: "ABC-1", title: "t", state: { name: "Todo" } }],
              },
            },
          }),
        );
      },
      async (url) => {
        const r = await runScript({ LINEAR_API_URL: url });
        assert.equal(r.status, 0);
        assert.deepEqual(JSON.parse(r.stdout), [{ id: "ABC-1", state: "Todo", title: "t" }]);
        assertNoRawControls(r.stderr);
        assertAllLinesPrefixed(r.stderr);
      },
    );
  });
});
