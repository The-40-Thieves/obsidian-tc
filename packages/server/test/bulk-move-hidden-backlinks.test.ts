// bulk_move_notes rewrites links in EVERY referencing note (the deliberate graph-integrity carve-out,
// "audit item 12"), including notes a rule-scope hides from the caller. Its REPORT must not: the
// backlink counts it returned included the hidden notes' links, so the difference between a caller's
// count and the visible graph disclosed that a hidden note links to the moved one. The vault-wide
// rewrite itself is unchanged; only what is reported is caller-visible.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { buildBulkTools } from "../src/tools/m6/bulk-tools";
import {
  BASE_SCOPES,
  type Harness,
  HIDDEN,
  MAIN,
  RULE_SCOPE,
  useHarness,
} from "./acl-parity-harness";

const make = useHarness();
const BULK = ["write:notes", "delete:notes", "bulk:notes"];

// open/c.md is linked from pub/a.md (visible) AND secret/b.md (hidden behind read:secret).
const MOVE = { vault: MAIN, moves: [{ from: "open/c.md", to: "open/c2.md" }] };

async function build() {
  return make({ main: RULE_SCOPE, verifyElicit: true }, (registry, parts) => {
    const deps = {
      vaultRegistry: parts.vaultRegistry,
      throttle: { maxConcurrentWritesPerVault: 4 },
    } as unknown as import("../src/tools/m6/shared").M6Deps;
    for (const t of buildBulkTools(deps)) registry.register(t);
  });
}

async function moveAs(h: Harness, scopes: string[], input: Record<string, unknown>) {
  const first = await h.call("bulk_move_notes", input, scopes);
  if (first.ok || first.error?.code !== "elicit_required") return first;
  const argsHash = (first.error as unknown as { details: { args_hash: string } }).details.args_hash;
  const elicitToken = issueElicitToken(h.parts.db, {
    vaultId: MAIN,
    toolName: "bulk_move_notes",
    argsHash,
    caller: "tester",
  });
  return h.call("bulk_move_notes", input, scopes, { elicitToken });
}

describe("bulk_move_notes reports only caller-visible backlinks", () => {
  it("dry_run: a caller without read:secret sees 1 link, not 2, and a hidden flag with no number", async () => {
    const h = await build();
    const r = await moveAs(h, [...BASE_SCOPES, ...BULK], MOVE);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.data.dry_run).toBe(true);
    // RED before the fix: 2 (pub/a.md + the hidden secret/b.md).
    expect(r.data.total_backlinks_updated).toBe(1);
    expect(r.data.results[0].backlinks_updated).toBe(1);
    expect(r.data.hidden_backlinks).toBe(true);
    // the flag is a boolean: neither the hidden path nor a count of hidden links is anywhere in it
    expect(JSON.stringify(r.data)).not.toContain(HIDDEN);
  });

  it("dry_run: a caller who CAN read the hidden note sees both links and no hidden flag", async () => {
    const h = await build();
    const r = await moveAs(h, [...BASE_SCOPES, "read:secret", ...BULK], MOVE);
    expect(r.ok).toBe(true);
    expect(r.data.total_backlinks_updated).toBe(2);
    expect(r.data.results[0].backlinks_updated).toBe(2);
    expect(r.data.hidden_backlinks).toBeUndefined();
  });

  it("real run: the response is caller-visible too, but the vault-wide rewrite still happens", async () => {
    const h = await build();
    const r = await moveAs(h, [...BASE_SCOPES, ...BULK], { ...MOVE, dry_run: false });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.data.dry_run).toBe(false);
    expect(r.data.total_backlinks_updated).toBe(1);
    expect(r.data.results[0].backlinks_updated).toBe(1);
    expect(r.data.hidden_backlinks).toBe(true);
    // graph integrity: the hidden note's link was still repointed
    const hidden = readFileSync(join(h.parts.roots[0] as string, HIDDEN), "utf8");
    expect(hidden).toContain("[[c2]]");
    expect(hidden).not.toContain("[[open/c]]");
  });

  it("update_backlinks:false reports zero and no hidden flag", async () => {
    const h = await build();
    const r = await moveAs(h, [...BASE_SCOPES, ...BULK], { ...MOVE, update_backlinks: false });
    expect(r.ok).toBe(true);
    expect(r.data.total_backlinks_updated).toBe(0);
    expect(r.data.hidden_backlinks).toBeUndefined();
  });
});
