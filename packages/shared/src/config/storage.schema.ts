// Experimental multi-device index sync: where a libSQL embedded replica pulls from and forwards its
// writes to. Leaf schema (imports Zod only). ABSENT is the default and means no sync, no network, and
// no behaviour change anywhere. The consumer is server/src/db/sync-config.ts; the root-level rule that
// a plain http:// host must be listed in `network.plainHttpHosts` lives in server.schema.ts, which
// is the only place that can see both blocks.
import { z } from "zod";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SYNC_SCHEMES = new Set(["libsql:", "https:", "http:"]);

/** Why `url` is not a usable sync endpoint, or undefined when it is. Exported for the root rule. */
export function syncUrlProblem(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "is not a valid URL";
  }
  if (!SYNC_SCHEMES.has(u.protocol)) {
    return `has scheme "${u.protocol}"; use libsql://, https:// or (private network only) http://`;
  }
  if (u.hostname === "") return "names no host";
  if (u.username !== "" || u.password !== "") {
    return "must not embed credentials; the token belongs in the environment variable named by authTokenEnv";
  }
  for (const key of u.searchParams.keys()) {
    if (/token|auth|key|secret/i.test(key)) {
      return `must not carry a credential in its query string ("${key}"); use authTokenEnv`;
    }
  }
  return undefined;
}

export const StorageSyncConfigSchema = z
  .strictObject({
    url: z
      .string()
      .min(1)
      .superRefine((v, ctx) => {
        const problem = syncUrlProblem(v);
        if (problem !== undefined) {
          ctx.addIssue({ code: "custom", message: `storage.sync.url ${problem}` });
        }
      })
      .describe(
        "Sync server: a Turso Cloud database (`libsql://<db>-<org>.turso.io`) or a self-hosted libSQL server, sqld (`https://…`, or `http://<host>` on a private network such as a tailnet or loopback; a non-loopback http:// host must also be listed in `network.plainHttpHosts`). Credentials are refused here: userinfo and token-like query parameters fail validation.",
      ),
    authTokenEnv: z
      .string()
      .regex(ENV_NAME_RE, "must be an environment variable NAME (letters, digits, underscore)")
      .optional()
      .describe(
        "Name of the environment variable holding the server's auth token (a Turso database token, or a sqld JWT). The token is never written in the config file: an inline `authToken` key is rejected as an unknown key. Omit for a server that needs none (loopback sqld).",
      ),
    syncIntervalMs: z
      .number()
      .int()
      .min(100)
      .optional()
      .describe(
        "Background pull period in milliseconds. Omitted means the replica pulls only when asked, so another machine's writes appear after the next explicit sync. Writes made by this machine are visible to it at once either way.",
      ),
  })
  .describe(
    "Embedded-replica sync of the derived index. EXPERIMENTAL. The whole index, including note text, chunk text and embeddings, is stored on this server; `egress.excludePaths` is NOT yet honoured by it. Off unless this block is present.",
  );
export type StorageSyncConfig = z.infer<typeof StorageSyncConfigSchema>;

export const StorageConfigSchema = z.strictObject({
  sync: StorageSyncConfigSchema.optional(),
});
export type StorageConfig = z.infer<typeof StorageConfigSchema>;
