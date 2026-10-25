// Shared setup for the folder conventions tests: the SCHEMA.md layers they write, the vault they run
// against, and the checks they make on a write's result. A test file imports these instead of
// re-deriving them, so a change to the layer shape or the result shape is made once.
import { expect } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { makeTestVault, type TestVault, type TestVaultOptions } from "./m1-helpers";

/** A SCHEMA.md layer that requires `type` on every note it governs. */
export const REQUIRE_TYPE =
  "---\nconventions:\n  frontmatter:\n    required: [type]\n---\n# rules\n";
/** A legacy wiki SCHEMA.md: `types`/`properties` and no `conventions:` block. */
export const LEGACY =
  "---\ntypes:\n  concept:\n    required: [summary]\nproperties:\n  summary: {}\n---\n";
/** The vault options every conventions test takes: the central ACL root and the check sink. */
export const CHECKED = { centralAcl: true, conventions: true };

export type CallResult = Awaited<ReturnType<TestVault["call"]>>;

/** A SCHEMA.md layer that requires `type` and `status`, accepts only draft or current as status, and
 *  levels both at `severity`. */
export const STATUS_RULES = (severity: "block" | "warn"): string =>
  "---\nconventions:\n  frontmatter:\n    required: [type, status]\n    values: { status: [draft, current] }\n" +
  `    severity: { type: ${severity}, status: ${severity} }\n---\n# rules\n`;

/** The number of snapshot rows the vault holds for `path`. */
export async function snapshotTotal(v: TestVault, path: string): Promise<number> {
  const r = await v.call("list_snapshots", { vault: "test", path });
  return r.ok ? (r.data as { total: number }).total : -1;
}

/** Runs `body` on a fresh test vault and removes the vault afterwards, even when `body` throws. */
export async function withVault<T>(
  opts: TestVaultOptions,
  body: (v: TestVault) => Promise<T>,
): Promise<T> {
  const v = makeTestVault(opts);
  try {
    return await body(v);
  } finally {
    v.cleanup();
  }
}

/** Dispatches `name`; on `elicit_required` mints the confirmation token from the error and retries once. */
export async function confirmedCall(
  v: TestVault,
  name: string,
  input: Record<string, unknown>,
  over?: Parameters<TestVault["call"]>[2],
): Promise<CallResult> {
  const first = await v.call(name, input, over);
  if (first.ok || first.error.code !== "elicit_required") return first;
  const argsHash = (first.error.details as { args_hash?: string } | undefined)?.args_hash;
  if (!argsHash) throw new Error("elicit_required with no args_hash");
  const elicitToken = issueElicitToken(v.db, {
    vaultId: v.id,
    toolName: name,
    argsHash,
    caller: "test",
  });
  return v.call(name, input, { ...over, elicitToken });
}

/** The write succeeded and its result carries no `conventions` key: nothing was judged wrong. */
export function expectClean(r: CallResult): void {
  expect(r.ok).toBe(true);
  expect(r.ok && "conventions" in (r.data as object)).toBe(false);
}

/** The write succeeded and its first warning is `missing_required` for `note`, from the layer `source`. */
export function expectMissingRequired(r: CallResult, note: string, source: string): void {
  expect(r.ok).toBe(true);
  const warnings = (
    r.ok ? (r.data as { conventions?: { warnings?: unknown[] } }).conventions : undefined
  )?.warnings;
  expect(warnings?.[0]).toMatchObject({ code: "missing_required", path: note, source });
}
