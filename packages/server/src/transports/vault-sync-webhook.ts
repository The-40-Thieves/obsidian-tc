import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import { gitSyncStateDir } from "../git-sync/state-dir";
import { isHostAllowed } from "./host-guard";

export const VAULT_SYNC_WEBHOOK_PATH = "/hooks/vault-sync";
const SECRET_VARIABLE = "OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET";
const MIN_SECRET_LENGTH = 32;
const MAX_BODY_BYTES = 1_048_576;
const HUB_SIGNATURE = /^sha256=[0-9a-f]{64}$/;

// Both sides of the GitLab comparison become fixed-length digests under one per-process key, so
// the secret's length never shows through an early length check.
const COMPARE_KEY = randomBytes(32);

export interface VaultSyncWebhookOptions {
  secret: string;
  triggerPath: string;
}

type RejectionReason = "missing" | "malformed" | "mismatch" | "too-large";

/** The route's inputs from the environment, or undefined when the route is not enabled. Throws
 *  (naming the variable, never its value) when the secret is too short to be worth accepting. */
export function vaultSyncWebhookFromEnv(
  env: Record<string, string | undefined>,
  cacheDir: string,
): VaultSyncWebhookOptions | undefined {
  const secret = env[SECRET_VARIABLE];
  if (!secret) return undefined;
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`${SECRET_VARIABLE} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return { secret, triggerPath: join(gitSyncStateDir(cacheDir), "trigger") };
}

/** Mounts `POST /hooks/vault-sync`, outside MCP auth. A valid call only touches the trigger file. */
export function mountVaultSyncWebhook(
  app: Hono,
  opts: VaultSyncWebhookOptions & {
    enableDnsRebindingProtection?: boolean;
    allowedHosts?: readonly string[];
  },
): void {
  app.post(VAULT_SYNC_WEBHOOK_PATH, async (c) => {
    c.header("Cache-Control", "no-store");
    if (
      opts.enableDnsRebindingProtection !== false &&
      !isHostAllowed(c.req.header("host") ?? "", opts.allowedHosts)
    )
      return c.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "host not allowed" }, id: null },
        403,
      );

    const body = await readCapped(c.req.raw);
    if (body === undefined) {
      logRejection("too-large");
      return c.body(null, 413);
    }
    const reason = authorize(
      c.req.header("x-hub-signature-256") || undefined,
      c.req.header("x-gitlab-token") || undefined,
      body,
      opts.secret,
    );
    if (reason !== undefined) {
      logRejection(reason);
      return c.body(null, 401);
    }

    try {
      await touchTrigger(opts.triggerPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      process.stderr.write(`vault-sync webhook: trigger touch failed (${code})\n`);
      return c.body(null, 503);
    }
    return c.body(null, 202);
  });
}

function logRejection(reason: RejectionReason): void {
  process.stderr.write(`vault-sync webhook: rejected reason=${reason}\n`);
}

/** Reads the raw body up to the cap. Returns undefined as soon as the cap is exceeded, cancelling
 *  the stream, so an oversized or unbounded body is never buffered in full. */
async function readCapped(request: Request): Promise<Uint8Array | undefined> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    await request.body?.cancel();
    return undefined;
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
}

/** Undefined when the call is authorised. A well-formed GitHub/Gitea/Forgejo signature or a
 *  matching GitLab token is enough; a present but malformed signature header is refused outright. */
function authorize(
  hubSignature: string | undefined,
  gitlabToken: string | undefined,
  body: Uint8Array,
  secret: string,
): RejectionReason | undefined {
  if (hubSignature === undefined && gitlabToken === undefined) return "missing";
  if (hubSignature !== undefined) {
    if (!HUB_SIGNATURE.test(hubSignature)) return "malformed";
    const expected = createHmac("sha256", secret).update(body).digest();
    if (timingSafeEqual(expected, Buffer.from(hubSignature.slice("sha256=".length), "hex"))) {
      return undefined;
    }
  }
  if (gitlabToken !== undefined && timingSafeEqual(keyedDigest(gitlabToken), keyedDigest(secret))) {
    return undefined;
  }
  return "mismatch";
}

function keyedDigest(value: string): Buffer {
  return createHmac("sha256", COMPARE_KEY).update(value).digest();
}

/** Creates the trigger 0600 (its directory 0700) when absent, else sets its mtime to now. Opening
 *  in append mode never writes, so the only change to an existing file is its timestamp. */
async function touchTrigger(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "a", 0o600);
  try {
    const now = new Date();
    await handle.utimes(now, now);
  } finally {
    await handle.close();
  }
}
