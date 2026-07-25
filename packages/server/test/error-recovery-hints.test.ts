// THE-512: recovery hints on error responses. The hints are keyed on ErrorCode alone, which is
// what makes the ticket's two hard requirements checkable rather than promised:
//
//   "bounded"                  -> asserted here as a length ceiling.
//   "no path/query/caller leak" -> structural: recoveryFor(code) takes ONLY the code, so no
//                                  request data is in scope to leak. The test below proves the
//                                  consequence end-to-end — an error carrying a real vault path
//                                  in its message and details still yields a hint with none of it.
//
// Exhaustiveness is enforced by the compiler, not here: RECOVERY is Record<ErrorCode, string|null>,
// so a new code fails to typecheck until it declares a hint or an explicit null. Verified by
// deleting an entry and observing TS2741. A runtime test could not add anything to that.
import {
  type ErrorCode,
  err,
  ObsidianTcError,
  recoveryFor,
} from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";

/** Every code in the taxonomy. Kept literal so a rename here fails loudly rather than silently
 *  shrinking coverage — the same reason ErrorCode itself is marked "do not rename". */
const ALL_CODES: readonly ErrorCode[] = [
  "unauthorized",
  "forbidden",
  "validation_error",
  "not_found",
  "vault_not_found",
  "conflict",
  "idempotency_key_mismatch",
  "idempotency_in_flight",
  "elicit_required",
  "elicit_invalid",
  "overflow",
  "throttled",
  "read_only",
  "plugin_unavailable",
  "internal",
  "note_not_found",
  "path_invalid",
  "path_ambiguous",
  "acl_denied",
  "read_only_mode",
  "note_exists",
  "concurrent_modification",
  "invalid_input",
  "internal_error",
  "embedding_provider_error",
  "operation_timeout",
  "dql_error",
  "jsonlogic_error",
  "plugin_missing",
  "plugin_unreachable",
  "bases_syntax_error",
  "unsupported_base_filter",
  "execute_command_disabled",
  "command_not_allowlisted",
  "requires_live_obsidian",
  "compute_budget_exceeded",
  "plugin_incompatible",
  "indeterminate_outcome",
];

/** Hints ride on every error response, so they are a per-call token cost. Keep them one or two
 *  sentences: enough to name the next tool to call, never prose. */
const MAX_HINT_LENGTH = 260;

describe("THE-512 error recovery hints", () => {
  it("gives every error code in the taxonomy a hint", () => {
    const missing = ALL_CODES.filter((c) => recoveryFor(c) === undefined);
    expect(
      missing,
      `${missing.length} code(s) have no recovery hint: ${missing.join(", ")}. ` +
        "Add one to RECOVERY in shared/src/errors.ts, or set it to null if genuinely no hint helps.",
    ).toEqual([]);
  });

  it("keeps every hint bounded", () => {
    const tooLong = ALL_CODES.map((c) => [c, recoveryFor(c) ?? ""] as const)
      .filter(([, h]) => h.length > MAX_HINT_LENGTH)
      .map(([c, h]) => `${c} (${h.length})`);
    expect(tooLong, `hints over ${MAX_HINT_LENGTH} chars: ${tooLong.join(", ")}`).toEqual([]);
  });

  it("surfaces the hint through toJSON, alongside code/message/retryable", () => {
    const e = err.aclDenied();
    const json = e.toJSON();
    expect(json.code).toBe("acl_denied");
    expect(json.retryable).toBe(false);
    expect(json.recovery).toContain("inspect_acl");
  });

  // The security property, proven rather than asserted. A hint is selected by code, so request
  // data cannot reach it even when the surrounding error is saturated with it.
  it("leaks no caller, path, query or vault data into the hint", () => {
    const secrets = [
      "Private/Finance/salary-2026.md",
      "clients/acme/contract",
      "tester@example.com",
      "vault-alpha",
      "SELECT secret FROM notes",
    ];
    const e = new ObsidianTcError(
      "acl_denied",
      `path denied by folder ACL: ${secrets[0]} (query ${secrets[4]})`,
      { path: secrets[0], caller: secrets[2], vault: secrets[3], attempted: secrets[1] },
    );
    const hint = e.toJSON().recovery ?? "";
    expect(hint.length).toBeGreaterThan(0);
    for (const s of secrets) {
      expect(hint, `hint must not echo request data, but contained "${s}"`).not.toContain(s);
    }
    // And it is identical to the hint for a bare error of the same code — i.e. the surrounding
    // error's content had no influence on it whatsoever.
    expect(hint).toBe(recoveryFor("acl_denied"));
  });

  it("gives the same hint for the same code regardless of message or details", () => {
    const a = new ObsidianTcError("throttled", "one", { scope: "write" }).toJSON().recovery;
    const b = new ObsidianTcError("throttled", "totally different", undefined).toJSON().recovery;
    expect(a).toBe(b);
  });

  // THE-562 #13's whole point is that this code must NOT be blindly retried. The hint is the only
  // place a caller is told that in words, so pin it.
  it("warns against a blind retry on indeterminate_outcome", () => {
    const hint = recoveryFor("indeterminate_outcome") ?? "";
    expect(hint).toMatch(/do NOT blindly retry/i);
    expect(hint).toMatch(/new key/i);
    expect(new ObsidianTcError("indeterminate_outcome", "x").retryable).toBe(false);
  });

  // A hint that only restates the message is noise. These are the codes where the actionable next
  // step is a specific tool call, so name it.
  it("names the tool to call next where one exists", () => {
    const expectations: ReadonlyArray<readonly [ErrorCode, string]> = [
      ["acl_denied", "inspect_acl"],
      ["vault_not_found", "list_vaults"],
      ["dql_error", "validate_dql"],
      ["plugin_missing", "refresh_plugin_capabilities"],
      ["validation_error", "describe_capability"],
      ["command_not_allowlisted", "list_commands"],
    ];
    for (const [code, tool] of expectations) {
      expect(recoveryFor(code) ?? "", `${code} should point at ${tool}`).toContain(tool);
    }
  });
});
