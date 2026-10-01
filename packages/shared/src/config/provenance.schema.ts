import { z } from "zod";

// Signed write provenance: one hash-chained, signed record per committed mutating tool call.
// Fully defaulted and defaulted ON: the record holds hashes and attribution only (never note
// content or prompts), and a server that records nothing cannot answer "who changed this".
export const ProvenanceConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Record one provenance row per committed mutating tool call: tool, vault, the paths it named with sha256 digests before and after (never content), timestamp, principal, session, client and claimed model/project/agent/machine, each field tagged verified or self_reported. Rows are hash-chained per vault and signed with the auth registry's EdDSA key when one is active. Verify with `obsidian-tc provenance verify`.",
      ),
    host: z
      .object({
        mode: z
          .enum(["hashed", "label"])
          .default("hashed")
          .describe(
            '"hashed" (default) records a stable digest of this machine\'s hostname, so rows correlate without naming the host. "label" records `label` verbatim.',
          ),
        label: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe('The host id recorded when mode is "label". Required in that mode.'),
      })
      .refine((h) => h.mode !== "label" || h.label !== undefined, {
        message: 'provenance.host.label is required when provenance.host.mode is "label"',
        path: ["label"],
      })
      .prefault({})
      .describe("How this server identifies itself on every provenance row."),
    retentionDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Days a provenance row is kept before the maintenance sweep prunes it. ABSENT (the default) keeps rows forever: this is an audit trail, and pruning it is an explicit decision. Pruning removes a contiguous prefix and moves a signed anchor up to the last row dropped, so the remaining chain still verifies.",
      ),
  })
  .prefault({});
