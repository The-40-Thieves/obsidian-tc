// Shared Zod primitives for the tool surface (G2.1 "Standard primitives").
// Reused across every vault-touching tool so path-safety and pagination are
// uniform. The traversal guard here is defense-in-depth; the filesystem
// resolver (packages/server/src/vault/paths.ts) re-checks real-path containment.
import { z } from "zod";

/** Vault registry id: lowercase slug. */
export const VaultId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/, "vault id must be a lowercase slug");

/**
 * Vault-relative path. Rejects absolute paths (POSIX and Windows drive paths)
 * and any ".." segment. Backslashes are tolerated on input and normalized by
 * the resolver; the byte-level guard stays conservative per G2.1.
 */
export const VaultPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !/(^|\/|\\)\.\.($|\/|\\)/.test(p), "path traversal rejected")
  .refine(
    (p) => !p.startsWith("/") && !p.startsWith("\\") && !/^[A-Za-z]:[\\/]/.test(p),
    "absolute paths rejected",
  );

/** 32-char hex HITL elicit token (matches issueElicitToken: randomBytes(16).hex). */
export const ElicitToken = z.string().regex(/^[a-f0-9]{32}$/, "malformed elicit token");

/** Cursor pagination inputs (G2.1 convention). */
export const Pagination = z.object({
  limit: z.number().int().positive().max(1000).optional(),
  cursor: z.string().optional(),
});
/** Shared write options. `idempotency_key` is accepted as a forward-compat
 *  surface in M1 (replay lands with the Policy layer in a later milestone). */
export const WriteOptions = z.object({
  idempotency_key: z.string().min(1).max(128).optional(),
  create_dirs: z.boolean().default(true),
});
