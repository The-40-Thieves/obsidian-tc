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
    stamp: z
      .object({
        gitTrailers: z
          .boolean()
          .default(false)
          .describe(
            "Append `Obsidian-TC-*` trailers to a commit made through the git_commit tool, summarising the recorded writes whose current bytes are in that commit: session, principal (the verified principal, else `unverified`), model (always tagged `(self-reported)`) and the provenance seq range. A commit that includes no recorded write gets none. Any `Obsidian-TC-*` trailer the caller wrote itself is removed first, so a trailer in the log is always the server's. Needs `provenance.enabled`.",
          ),
        frontmatter: z
          .boolean()
          .default(false)
          .describe(
            "Write a compact provenance object under `frontmatterKey` into notes an agent CREATES (write_note creating, commit_capture, execute_template). Never touches an existing note, and never any other frontmatter key. The object holds session, principal (verified, else `unverified`), model_self_reported and seq; never the host id. Needs `provenance.enabled`.",
          ),
        frontmatterKey: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/)
          .default("obsidian_tc_provenance")
          .describe(
            "The frontmatter key the stamp is written under when `frontmatter` is on. A caller-supplied value under this key in a note being created is replaced by the real stamp.",
          ),
      })
      .prefault({})
      .describe(
        "Optional, OFF by default: stamp provenance into commit trailers and newly created notes. The signed record in cache.db stays the source of truth; a stamp is a convenience copy.",
      ),
  })
  .refine((p) => p.enabled || !(p.stamp.gitTrailers || p.stamp.frontmatter), {
    message: "provenance.stamp needs provenance.enabled",
    path: ["stamp"],
  })
  .prefault({});
