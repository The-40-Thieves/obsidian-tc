// update_observation — correct or retire ONE memory observation by its `observation_id`.
//
// add_observation can only supersede by an explicit `key`, and observations created by
// create_entity (or by an add_observation with no key) have none, so before this tool a wrong fact
// could only be contradicted by appending another. Every observation already has an interval row
// (memory_observation_intervals) whose rowid never changes, so that rowid IS the address: no
// migration, nothing derived from text, stable across reads. This tool closes the addressed
// interval (valid_to = now) exactly as supersession/retirement does today — the text stays in the
// blob, hidden from default reads, still reachable with get_entity's `as_of` and rendered under
// the note's Superseded section. There is NO hard delete. A correction also opens a fresh
// interval carrying the old one's key, so key supersession keeps working across an edit.
import { err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { inWriteTransaction } from "../../db/txn";
import { enforceMemoryDefense } from "../../experiential/memory-defense";
import type { ToolDefinition } from "../../mcp/registry";
import {
  appendObservation,
  type EntityRow,
  getEntityById,
  insertObservationInterval,
  observationViews,
  obsHash,
  parseObservations,
  type RenderableObservation,
  setEntityVaultPath,
} from "../../memory/entities";
import {
  closeIntervalById,
  formatObservationId,
  parseObservationId,
} from "../../memory/observation-edit";
import { defineTool } from "../m1/define";
import {
  assertMemoryPathWritable,
  currentNotePath,
  getReadableEntity,
  materializeProjection,
} from "./memory-projection";
import { NormalizedObservationText } from "./memory-tools";
import type { M5Deps } from "./shared";
import { memoryDefenseFor } from "./shared";

const UpdateObservationOutput = z.object({
  entity_id: z.string(),
  action: z.enum(["corrected", "retired"]),
  // The observation that was closed (kept in history, hidden from default reads).
  closed_observation_id: z.string(),
  // The replacement's address; absent when the observation was only retired.
  observation_id: z.string().optional(),
  observation_count: z.number(),
  updated_at: z.number(),
  vault_path: z.string().nullable(),
  redactions: z.number().int().nonnegative().optional(),
});

export function buildMemoryObservationTools(deps: M5Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "update_observation",
      domain: "knowledge",
      vaultArg: "vault",
      description:
        "Correct or retire ONE existing memory observation, addressed by its `observation_id` (returned by create_entity, add_observation and get_entity; no key needed). Pass `observation` (the corrected single-line fact) to replace it, or `retire: true` to remove it without a replacement — exactly one of the two. Nothing is hard-deleted: the old text is closed (valid_to set; for a correction, superseded_by names the replacement), hidden from default reads, still visible with get_entity's `as_of` set before the edit and under the note's Superseded section. A correction keeps the old observation's key, so a later add_observation with that key still supersedes it. Use this instead of add_observation whenever a fact is WRONG or no longer true; only an open observation can be edited. Requires write access to the entity's note path. Domain: knowledge.",
      inputSchema: z
        .object({
          vault: VaultId,
          entity_id: z.string().min(1),
          observation_id: z
            .string()
            .regex(/^obs_[1-9][0-9]*$/, "observation_id looks like obs_42 (from get_entity)"),
          observation: NormalizedObservationText.optional(),
          retire: z.boolean().optional(),
        })
        .strict()
        .superRefine((data, ctx2) => {
          const replace = data.observation !== undefined;
          const retire = data.retire === true;
          if (replace === retire)
            ctx2.addIssue({
              code: "custom",
              message:
                "provide exactly one of `observation` (the corrected fact) or `retire: true` (remove it)",
            });
        }),
      outputSchema: UpdateObservationOutput,
      requiredScopes: ["write:memory"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const now = (ctx.now ?? Date.now)();
        const intervalId = parseObservationId(input.observation_id) as number;
        const mdConfig = memoryDefenseFor(deps, v.id);

        return inWriteTransaction(ctx.db, "memory_observation", () => {
          // Denied == missing: an entity the caller cannot read is "entity not found", then the
          // write ACL on its projection path (both materialize modes), as add_observation does.
          const existing = getReadableEntity(deps, ctx, v.id, input.entity_id);
          if (!existing) throw err.invalidInput("entity not found", { entity_id: input.entity_id });
          assertMemoryPathWritable(ctx, v.root, currentNotePath(deps, v.id, existing));

          const views = observationViews(ctx.db, existing);
          const idx = views.findIndex((o) => o.id === intervalId);
          // Another entity's id is just as unknown here as a made-up one.
          if (idx < 0)
            throw err.invalidInput("observation not found on this entity", {
              entity_id: existing.id,
              observation_id: input.observation_id,
            });
          const old = views[idx] as (typeof views)[number];
          if (old.validTo !== null)
            throw err.invalidInput(
              "observation is already closed (superseded or retired) — edit its open replacement, or add a new one",
              { entity_id: existing.id, observation_id: input.observation_id },
            );
          if (input.observation === old.text)
            throw err.invalidInput("observation text is unchanged", {
              observation_id: input.observation_id,
            });
          // A future-dated fact closes at its own start (zero-length), never before it.
          const closeAt = Math.max(now, old.validFrom);

          let text: string | undefined;
          let redactions = 0;
          if (input.observation !== undefined) {
            // Scan the JOINED text, as add_observation does: a secret split across an earlier
            // observation and this one reassembles on disk.
            const joinScan = enforceMemoryDefense(
              mdConfig,
              { observations: [...parseObservations(existing.observations), input.observation] },
              { metrics: deps.metrics },
            );
            const scanned = joinScan.fields.observations as string[];
            text = scanned[scanned.length - 1] as string;
            redactions = joinScan.redactions;
          }

          ctx.markEffectCommitted?.();

          const closedViews = views.map((o, i) => (i === idx ? { ...o, validTo: closeAt } : o));
          const newHash = text !== undefined ? obsHash(text) : null;
          const nextViews: RenderableObservation[] =
            text !== undefined
              ? [
                  ...closedViews.map((o, i) => (i === idx ? { ...o, supersededBy: newHash } : o)),
                  {
                    text,
                    key: old.key,
                    validFrom: closeAt,
                    validTo: null,
                    supersededBy: null,
                  },
                ]
              : closedViews;

          const vaultPath =
            existing.materialize === 1
              ? materializeProjection(deps, ctx, v, existing, nextViews)
              : existing.vault_path;

          // DB writes mirror the state just rendered. Close BEFORE inserting: the open-key unique
          // index allows one open row per (entity, key), and the replacement inherits the key.
          closeIntervalById(ctx.db, existing.id, intervalId, closeAt, newHash);
          let newId: number | undefined;
          if (text !== undefined) {
            const r = appendObservation(ctx.db, existing.id, text, now);
            if (!r) throw err.invalidInput("entity not found", { entity_id: input.entity_id });
            newId = insertObservationInterval(ctx.db, {
              entityId: existing.id,
              obsHash: newHash as string,
              key: old.key,
              validFrom: closeAt,
              validTo: null,
              now,
            });
          }
          setEntityVaultPath(ctx.db, existing.id, vaultPath, now);
          // Assert the text/interval lockstep, rolling the transaction back on a drift.
          observationViews(ctx.db, getEntityById(ctx.db, existing.id) as EntityRow);

          return {
            entity_id: existing.id,
            action: text !== undefined ? ("corrected" as const) : ("retired" as const),
            closed_observation_id: formatObservationId(intervalId),
            ...(newId !== undefined ? { observation_id: formatObservationId(newId) } : {}),
            observation_count: nextViews.length,
            updated_at: now,
            vault_path: vaultPath,
            ...(redactions > 0 ? { redactions } : {}),
          };
        });
      },
    }),
  ];
}
