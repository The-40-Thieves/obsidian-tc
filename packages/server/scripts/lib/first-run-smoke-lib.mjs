// Pure helpers for scripts/first-run-smoke.ts, split out so they are unit-testable without spawning
// a server (test/first-run-smoke.test.ts). No I/O in here.

/** The boot line cli.ts writes once stdio is up (server-runtime.ts):
 *  `obsidian-tc <ver> ready on stdio (vault <id>; native=<on|js-fallback> vec=<on|off>)`. */
const BANNER = /obsidian-tc (\S+) ready on stdio \(vault ([^;)]+); native=(\S+) vec=(on|off)\)/;

/** @returns {{version: string, vault: string, native: string, vec: "on" | "off"} | null} */
export function parseBanner(stderrText) {
  const m = BANNER.exec(stderrText);
  return m
    ? { version: m[1], vault: m[2], native: m[3], vec: /** @type {"on"|"off"} */ (m[4]) }
    : null;
}

/** Whether `version` (`v24.1.0` or `24.1.0`) satisfies a `>=X[.Y[.Z]]` range, the only form the
 *  MCPB manifest's `compatibility.runtimes.node` uses. Anything else throws rather than guessing. */
export function nodeSatisfies(version, range) {
  const r = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  if (!r) throw new Error(`unsupported node range "${range}" (only >=X[.Y[.Z]] is understood)`);
  const v = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!v) throw new Error(`unparseable node version "${version}"`);
  const want = [r[1], r[2] ?? "0", r[3] ?? "0"].map(Number);
  const have = [v[1], v[2], v[3]].map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return true;
}

/** Expand the `${__dirname}` / `${user_config.<key>}` placeholders of an MCPB `mcp_config` string
 *  the way a desktop host does. An unknown key expands to "" (an unset optional user_config). */
export function expandMcpbVars(text, { dirname, userConfig }) {
  return text.replace(/\$\{([^}]+)\}/g, (_, name) => {
    if (name === "__dirname") return dirname;
    if (name.startsWith("user_config.")) return userConfig[name.slice("user_config.".length)] ?? "";
    throw new Error(`unsupported mcpb placeholder \${${name}}`);
  });
}

/** One-line failure reason from a child's stderr: the last line that looks like an error, else the
 *  last non-empty line, else a fixed fallback. Trimmed and capped so it fits a table cell. */
export function failureLine(stderrText, fallback = "no stderr output") {
  const lines = stderrText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errLine = [...lines]
    .reverse()
    .find((l) => /error|cannot|failed|not found|unsupported/i.test(l));
  const pick = errLine ?? lines.at(-1) ?? fallback;
  return pick.length > 300 ? `${pick.slice(0, 297)}...` : pick;
}

/** Pull the tool's JSON payload out of an MCP callTool result: structuredContent when present,
 *  else the first text block parsed as JSON. Facade calls wrap the tool result, so unwrap one level
 *  of `{result: ...}` / `{data: ...}` envelopes. Returns undefined when nothing parses. */
export function toolPayload(result) {
  let payload = result?.structuredContent;
  if (payload === undefined) {
    const text = (result?.content ?? []).find((c) => c.type === "text")?.text;
    if (typeof text !== "string") return undefined;
    try {
      payload = JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  for (const key of ["result", "data"]) {
    if (payload && typeof payload === "object" && !("items" in payload) && key in payload) {
      payload = payload[key];
    }
  }
  return payload;
}

/**
 * Which retriever answered a search_semantic call, from the response itself.
 *  - `semantic`: the tool reports mode_used "semantic" and every hit carries the dense `embedding_model`
 *    stamp (a lexical hit has none), and the expected note ranks first.
 *  - `error`: the call failed (isError); `detail` is the first line of the error text.
 *  - `empty`: no hits at all.
 *  - `wrong-top`: dense hits came back but not the note a real embedder must rank first.
 *  - `not-dense`: hits came back without the dense stamp or with another mode_used: a lexical or
 *    otherwise degraded retriever answered.
 * @returns {{kind: "semantic" | "error" | "empty" | "wrong-top" | "not-dense", detail: string, model?: string}}
 */
export function classifySemantic(result, expectedTopPath) {
  if (result?.isError) {
    const text = (result.content ?? []).map((c) => c.text ?? "").join(" ");
    return { kind: "error", detail: failureLine(text, "search_semantic returned isError") };
  }
  const payload = toolPayload(result);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) return { kind: "empty", detail: "search_semantic returned no hits" };
  const models = [
    ...new Set(items.map((h) => h.embedding_model).filter((m) => typeof m === "string")),
  ];
  if (
    payload.mode_used !== "semantic" ||
    items.some((h) => typeof h.embedding_model !== "string")
  ) {
    return {
      kind: "not-dense",
      detail: `mode_used=${String(payload.mode_used)}, ${models.length}/${items.length} hits carry embedding_model`,
    };
  }
  const top = items[0].path;
  if (top !== expectedTopPath) {
    return {
      kind: "wrong-top",
      detail: `top hit was ${top}, expected ${expectedTopPath}`,
      model: models[0],
    };
  }
  return { kind: "semantic", detail: `top hit ${top} (model ${models[0]})`, model: models[0] };
}

/** @typedef {{stage: string, status: "pass" | "fail" | "skip" | "info", detail: string}} StageResult */

/** Fold stage results into the report the workflow summarises. `firstFailure` is the exact
 *  one-line reason of the first failed stage, which is what the 3x3 table records. */
export function buildReport({ path, platform, arch, node, stages }) {
  const failed = stages.find((s) => s.status === "fail");
  return {
    path,
    platform,
    arch,
    node,
    result: failed ? "fail" : "pass",
    firstFailure: failed ? `${failed.stage}: ${failed.detail}` : null,
    stages,
  };
}

/** The workflow's EXPECTED_FAILURES list: space-separated `<path>/<os>` cell ids. */
export function parseExpectedFailures(text) {
  return new Set(text.split(/\s+/).filter(Boolean));
}

/** One markdown cell per (path, os): PASS / FAIL with the exact first-failure line / NO REPORT,
 *  tagged `expected` or `UNEXPECTED` for a failure and `XPASS` for a pass the list still excuses. */
function cellText(report, expected) {
  if (!report) return expected ? "NO REPORT (expected)" : "NO REPORT";
  const esc = (t) => t.replaceAll("|", "\\|").replaceAll("`", "'");
  if (report.result === "pass")
    return expected ? "PASS (XPASS: drop from EXPECTED_FAILURES)" : "PASS";
  return `FAIL${expected ? " (expected)" : " (UNEXPECTED)"}: ${esc(report.firstFailure ?? "unknown")}`;
}

/** The 3x3 table the workflow writes to its step summary. `reports` maps `<path>/<os>` -> report. */
export function renderMatrix({ paths, oses, reports, expected }) {
  const rows = [`| path | ${oses.join(" | ")} |`, `|---|${oses.map(() => "---").join("|")}|`];
  for (const path of paths) {
    const cells = oses.map((os) =>
      cellText(reports.get(`${path}/${os}`), expected.has(`${path}/${os}`)),
    );
    rows.push(`| ${path} | ${cells.join(" | ")} |`);
  }
  return rows.join("\n");
}
