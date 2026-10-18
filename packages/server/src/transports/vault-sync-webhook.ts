import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context, Hono } from "hono";
import { gitSyncStateDir } from "../git-sync/state-dir";
import { assertWebhookSecret, WEBHOOK_SECRET_VARIABLE } from "../git-sync/webhook-secret";
import { isHostAllowed } from "./host-guard";

export const VAULT_SYNC_WEBHOOK_PATH = "/hooks/vault-sync";
const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_BODY_DEADLINE_MS = 10_000;
const HUB_SIGNATURE = /^sha256=[0-9a-f]{64}$/;

// Both sides of the GitLab comparison become fixed-length digests under one per-process key, so
// the secret's length never shows through an early length check.
const COMPARE_KEY = randomBytes(32);

export interface VaultSyncWebhookOptions {
  secret: string;
  triggerPath: string;
  /** Absolute time allowed for reading a body. Only tests shorten it. */
  bodyDeadlineMs?: number;
}

type RejectionReason = "missing" | "malformed" | "mismatch" | "too-large" | "timeout" | "aborted";

/** The route's inputs from the environment, or undefined when the route is not enabled. Throws
 *  (naming the variable, never its value) when the secret is too short to be worth accepting. */
export function vaultSyncWebhookFromEnv(
  env: Record<string, string | undefined>,
  cacheDir: string,
): VaultSyncWebhookOptions | undefined {
  const secret = env[WEBHOOK_SECRET_VARIABLE];
  if (!secret) return undefined;
  assertWebhookSecret(secret);
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
    // Closed by default, so no path can miss it: a response that leaves the request body unread
    // would otherwise hold the socket for the server's idle timeout (120 s under Bun). Only a body
    // that was read in full and verified keeps the connection alive, in `accept`.
    c.header("Connection", "close");
    if (
      opts.enableDnsRebindingProtection !== false &&
      !isHostAllowed(c.req.header("host") ?? "", opts.allowedHosts)
    )
      return c.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "host not allowed" }, id: null },
        403,
      );

    // Credentials are checked before any body is read, so an unauthenticated caller cannot hold
    // a connection open. A matching GitLab token needs no body at all, but it is still capped by
    // the declared length, so an oversized call is refused the same way a signed one is.
    const gitlab = c.req.header("x-gitlab-token") || undefined;
    const hub = c.req.header("x-hub-signature-256") || undefined;
    if (gitlab === undefined && hub === undefined) return refuse(c, "missing");
    if (gitlab !== undefined && tokenMatches(gitlab, opts.secret)) {
      if (declaredTooLarge(c)) return refuse(c, "too-large");
      return accept(c, opts.triggerPath, { bodyRead: false });
    }
    if (hub === undefined) return refuse(c, "mismatch");
    if (!HUB_SIGNATURE.test(hub)) return refuse(c, "malformed");
    if (declaredTooLarge(c)) return refuse(c, "too-large");

    const read = await readCapped(c.req.raw, opts.bodyDeadlineMs ?? DEFAULT_BODY_DEADLINE_MS);
    if (!read.ok) {
      if (read.reason === "too-large") return refuse(c, "too-large");
      if (read.reason === "timeout") {
        logRejection("timeout");
        return c.body(null, 408);
      }
      return refuse(c, "aborted");
    }
    if (!hubMatches(hub, read.body, opts.secret)) return refuse(c, "mismatch");
    return accept(c, opts.triggerPath, { bodyRead: true });
  });
}

function declaredTooLarge(c: Context): boolean {
  const declared = c.req.header("content-length");
  return declared !== undefined && Number(declared) > MAX_BODY_BYTES;
}

function logRejection(reason: RejectionReason): void {
  process.stderr.write(`vault-sync webhook: rejected reason=${reason}\n`);
}

function refuse(c: Context, reason: RejectionReason) {
  logRejection(reason);
  if (reason === "too-large") return c.body(null, 413);
  if (reason === "aborted") return c.body(null, 400);
  return c.body(null, 401);
}

async function accept(c: Context, triggerPath: string, { bodyRead }: { bodyRead: boolean }) {
  try {
    await touchTrigger(triggerPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    process.stderr.write(`vault-sync webhook: trigger touch failed (${code})\n`);
    return c.body(null, 503);
  }
  // Only a fully read, verified body may keep the connection; the GitLab 202 leaves its body unread.
  if (bodyRead) c.header("Connection", undefined);
  return c.body(null, 202);
}

function tokenMatches(token: string, secret: string): boolean {
  return timingSafeEqual(keyedDigest(token), keyedDigest(secret));
}

function hubMatches(signature: string, body: Uint8Array, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice("sha256=".length), "hex"));
}

function keyedDigest(value: string): Buffer {
  return createHmac("sha256", COMPARE_KEY).update(value).digest();
}

type BodyRead =
  | { ok: true; body: Uint8Array }
  | { ok: false; reason: "too-large" | "timeout" | "aborted" };

/** Reads the raw body up to the cap and an absolute deadline. A stream that stalls is cancelled
 *  when the deadline passes, so no read waits on a silent client indefinitely. */
async function readCapped(request: Request, deadlineMs: number): Promise<BodyRead> {
  if (!request.body) return { ok: true, body: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel();
  }, deadlineMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (expired) return { ok: false, reason: "timeout" };
      if (done) return { ok: true, body: Buffer.concat(chunks) };
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: expired ? "timeout" : "aborted" };
  } finally {
    clearTimeout(timer);
  }
}

/** Creates the state directory 0700 when absent, and tightens an existing one to 0700. Refuses a
 *  symlink or a non-directory, so a link cannot redirect the write outside the state directory. */
async function prepareStateDir(dir: string): Promise<void> {
  const before = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (before === undefined) await mkdir(dir, { recursive: true, mode: 0o700 });
  else if (before.isSymbolicLink())
    throw Object.assign(new Error("state path is a symlink"), { code: "ELOOP" });
  else if (!before.isDirectory())
    throw Object.assign(new Error("state path is not a directory"), { code: "ENOTDIR" });
  await chmod(dir, 0o700);
}

/** Creates the trigger 0600 when absent, else sets its mtime to now. The open refuses a symlink
 *  (O_NOFOLLOW) and a non-regular file, and the timestamp is set through the open descriptor. */
async function touchTrigger(path: string): Promise<void> {
  await prepareStateDir(dirname(path));
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, flags, 0o600);
  try {
    if (!(await handle.stat()).isFile()) {
      throw Object.assign(new Error("trigger is not a regular file"), { code: "ENOTFILE" });
    }
    const now = new Date();
    await handle.utimes(now, now);
  } finally {
    await handle.close();
  }
}
