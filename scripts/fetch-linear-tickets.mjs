#!/usr/bin/env node
// Fetch every ticket for one Linear project as the JSON shape check-ticket-drift.mjs consumes:
//   [{"id":"THE-1","state":"Todo","title":"…"}]
//
// Exists because check-ticket-drift's second direction needs CLOSED tickets, and closed tickets are
// the bulk of the project — 415 ids are cited in this repo's code and at least 238 of them are done
// or cancelled. Any fetch that quietly returns the first page would under-report precisely the
// direction the check was added for, so this paginates to exhaustion and refuses to emit a partial
// list. `[[feedback-truncated-output-is-not-an-inventory]]`.
//
// Reads LINEAR_API_KEY from the environment. Writes JSON to stdout; diagnostics to stderr, so
// `node scripts/fetch-linear-tickets.mjs > tickets.json` is safe.
const KEY = process.env.LINEAR_API_KEY;
const PROJECT = process.argv[2] ?? "obsidian-tc";

if (!KEY) {
  console.error("fetch-linear-tickets: LINEAR_API_KEY is not set");
  process.exit(2);
}

const QUERY = `
  query ($project: String!, $after: String) {
    issues(
      first: 250
      after: $after
      filter: { project: { name: { eq: $project } } }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes { identifier title state { name } }
    }
  }
`;

const out = [];
let after = null;
// Bounded so a pageInfo bug cannot spin forever; 40 pages x 250 is far above any real project and
// tripping it is a loud failure rather than a silent truncation.
for (let page = 0; page < 40; page++) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: KEY },
    body: JSON.stringify({ query: QUERY, variables: { project: PROJECT, after } }),
  });
  if (!res.ok) {
    console.error(`fetch-linear-tickets: HTTP ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const body = await res.json();
  if (body.errors) {
    console.error(`fetch-linear-tickets: ${JSON.stringify(body.errors)}`);
    process.exit(1);
  }
  const { nodes, pageInfo } = body.data.issues;
  for (const n of nodes) {
    out.push({ id: n.identifier, state: n.state?.name ?? "?", title: n.title ?? "" });
  }
  if (!pageInfo.hasNextPage) {
    const closed = out.filter((t) =>
      ["done", "completed", "canceled", "cancelled", "duplicate", "merged"].includes(
        t.state.toLowerCase(),
      ),
    ).length;
    console.error(
      `fetch-linear-tickets: ${out.length} tickets for "${PROJECT}" (${out.length - closed} open, ${closed} closed) across ${page + 1} page(s).`,
    );
    if (out.length === 0) {
      console.error("fetch-linear-tickets: zero tickets — refusing to emit an empty list");
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(out, null, 2));
    process.exit(0);
  }
  after = pageInfo.endCursor;
}

console.error("fetch-linear-tickets: pagination did not terminate within 40 pages — refusing");
process.exit(1);
