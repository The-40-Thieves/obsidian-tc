#!/usr/bin/env node
// Report (and optionally gate on) open Aikido Security findings for this repository.
//
// WHY THIS EXISTS: obsidian-tc already runs five scanners — gitleaks and trufflehog for secrets,
// osv-scanner for advisories, opengrep for SAST, Socket for malicious-dependency behaviour. Aikido
// overlaps some of that but adds its own SAST/SCA/IaC surface and, more usefully, a single place
// where findings persist with triage state (ignored / snoozed) rather than being recomputed from
// scratch on every run. This script is the read side of that: it asks Aikido what is currently
// OPEN for this repo and prints it where CI can see it.
//
// THE FLOOR, AND WHY IT IS THE WHOLE POINT:
//
//   A findings API returns an empty array for two completely different reasons:
//     (a) the repo is onboarded and genuinely has no open issues  -> good news
//     (b) the repo was never connected, the token lacks a scope,
//         or the name does not match what Aikido knows            -> NO news
//
//   Those are indistinguishable downstream, and (b) silently reports "clean" forever. So this
//   script REFUSES to report a clean result it cannot justify: it first lists code repositories
//   and asserts this one is actually present. If it is not, that is exit 2 (misconfigured), NEVER
//   exit 0. This repo has been bitten by the general form of this often enough to have a rule
//   about it — a gate that scans zero things reports success.
//
// EXIT CODES, deliberately three-valued:
//   0  queried successfully, findings below the gate threshold (or no gate set)
//   1  findings AT OR ABOVE the gate threshold  -> a real security result
//   2  could not produce a trustworthy answer: missing credentials, auth failure, repo not found
//      in Aikido, unexpected API shape. Distinct from 1 so "broken" never reads as "clean", and
//      distinct from 0 so it can never be mistaken for a pass.
//
// CREDENTIALS: AIKIDO_CLIENT_ID / AIKIDO_CLIENT_SECRET. Never logged, never echoed, and the
// minted access token is never printed. On Cave they live in ~/.config/aikido/env (0600); in CI
// they are repo secrets.
//
// USAGE:
//   node scripts/aikido-findings.mjs                     # report only, always exit 0/2
//   node scripts/aikido-findings.mjs --gate high         # exit 1 if any critical|high is open
//   node scripts/aikido-findings.mjs --json              # machine-readable, for piping
//   node scripts/aikido-findings.mjs --repo other-name   # override repo-name matching
import { argv, env, exit } from "node:process";

const API = "https://app.aikido.dev";
const TOKEN_URL = `${API}/api/oauth/token?grant_type=client_credentials`;
const V1 = `${API}/api/public/v1`;

// Aikido severities, ascending. A gate of "high" means high AND critical both fail.
const SEVERITY_ORDER = ["low", "medium", "high", "critical"];

function arg(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}
const hasFlag = (name) => argv.includes(`--${name}`);

const asJson = hasFlag("json");
const gate = arg("gate");
const repoName = arg("repo", "obsidian-tc");

function die(msg) {
  process.stderr.write(`aikido-findings: ${msg}\n`);
  exit(2);
}

if (gate && !SEVERITY_ORDER.includes(gate))
  die(`--gate must be one of ${SEVERITY_ORDER.join("|")}, got "${gate}"`);

const clientId = env.AIKIDO_CLIENT_ID;
const clientSecret = env.AIKIDO_CLIENT_SECRET;
if (!clientId || !clientSecret)
  die(
    "AIKIDO_CLIENT_ID and AIKIDO_CLIENT_SECRET must both be set.\n" +
      "  Cave:  . ~/.config/aikido/env\n" +
      "  CI:    repo secrets of the same names",
  );

/** Client-credentials grant. Returns the bearer token; it is never logged. */
async function mintToken() {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!res.ok)
    die(
      `token exchange failed: HTTP ${res.status} ${res.statusText}. ` +
        "Check the client id/secret pair and that the integration is still enabled.",
    );
  const body = await res.json().catch(() => null);
  if (!body?.access_token) die("token exchange returned no access_token (unexpected API shape)");
  return body.access_token;
}

async function get(token, path) {
  const res = await fetch(`${V1}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 403)
    die(
      `HTTP 403 on ${path} — the token is valid but lacks a required scope. ` +
        "This integration needs 'repositories:read' and 'issues:read'.",
    );
  if (!res.ok) die(`HTTP ${res.status} ${res.statusText} on ${path}`);
  return res.json();
}

/** THE FLOOR. Resolve the repo by exact name, paging until found or exhausted. */
async function resolveRepo(token) {
  const seen = [];
  for (let page = 0; page < 50; page++) {
    const rows = await get(token, `/repositories/code?page=${page}&per_page=100`);
    if (!Array.isArray(rows)) die("/repositories/code did not return an array (unexpected shape)");
    if (rows.length === 0) break;
    for (const r of rows) {
      seen.push(r.name);
      if (r.name === repoName) return r;
    }
  }
  die(
    `repo "${repoName}" is NOT present in this Aikido account, so a findings query would return ` +
      "an empty list that means NOTHING.\n" +
      `  ${seen.length} repo(s) visible to this token: ${seen.slice(0, 12).join(", ")}` +
      `${seen.length > 12 ? ", …" : ""}\n` +
      "  Connect the repository in Aikido, or pass --repo <exact-name>. Refusing to report clean.",
  );
}

const token = await mintToken();
const repo = await resolveRepo(token);

const issues = await get(
  token,
  `/issues/export?format=json&filter_status=open&filter_code_repo_id=${repo.id}`,
);
if (!Array.isArray(issues)) die("/issues/export did not return an array (unexpected shape)");

const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
let unknownSeverity = 0;
for (const i of issues) {
  const s = String(i.severity ?? "").toLowerCase();
  if (s in counts) counts[s]++;
  else unknownSeverity++;
}

if (asJson) {
  process.stdout.write(
    `${JSON.stringify({ repo: repo.name, repoId: repo.id, total: issues.length, counts, unknownSeverity }, null, 2)}\n`,
  );
} else {
  const summary = SEVERITY_ORDER.slice()
    .reverse()
    .map((s) => `${s}=${counts[s]}`)
    .join(" ");
  process.stdout.write(
    `aikido-findings: repo "${repo.name}" (id ${repo.id}) — ${issues.length} open issue(s): ${summary}` +
      `${unknownSeverity ? ` (+${unknownSeverity} with an unrecognised severity)` : ""}\n`,
  );
  // Surface the worst few by name so a CI reader does not have to open the dashboard to triage.
  const worst = issues
    .slice()
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(String(b.severity ?? "").toLowerCase()) -
        SEVERITY_ORDER.indexOf(String(a.severity ?? "").toLowerCase()),
    )
    .slice(0, 10);
  for (const i of worst)
    process.stdout.write(`  [${i.severity ?? "?"}] ${i.title ?? i.issue_id ?? "(untitled)"}\n`);
}

if (unknownSeverity)
  process.stderr.write(
    `aikido-findings: WARNING — ${unknownSeverity} issue(s) had a severity outside ` +
      `${SEVERITY_ORDER.join("|")}. They are counted in the total but CANNOT be gated on; ` +
      "the gate below may therefore be weaker than it looks.\n",
  );

if (gate) {
  const floor = SEVERITY_ORDER.indexOf(gate);
  const offending = SEVERITY_ORDER.slice(floor).reduce((n, s) => n + counts[s], 0);
  if (offending > 0) {
    process.stderr.write(
      `aikido-findings: ${offending} open issue(s) at or above "${gate}" — failing.\n`,
    );
    exit(1);
  }
  process.stdout.write(`aikido-findings: no open issues at or above "${gate}".\n`);
}
