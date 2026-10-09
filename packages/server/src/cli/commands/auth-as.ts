// `obsidian-tc auth as set-password`: claim the bundled authorization server from the host's shell,
// or change the operator's password (design v2 section 4.5). Shell access to the host and write
// access to `<cacheDir>` are the credential, exactly as for `auth rotate-key` and `token mint`: whoever
// can write oauth.db can already replace the password hash.
//
// The password is read from a terminal (asked twice, no echo) or, with --stdin, from the first line
// of standard input, and is never printed, logged or put in argv.
import { mkdirSync } from "node:fs";
import { enabledAs } from "../../auth/as-metadata";
import {
  claimOperator,
  findOperator,
  normalizeUsername,
  setOperatorPassword,
  soleOperator,
} from "../../auth/as-operator-store";
import {
  type Argon2Runtime,
  argon2Unsupported,
  hashPassword,
  passwordProblem,
} from "../../auth/as-password";
import { openOauthDb } from "../../auth/oauth-db";
import { CliError } from "../cli-error";
import { type Cmd, resolveOrUsageExit } from "../shared";

/** Seams for tests: where the password comes from, and what runtime it is hashed on. */
export interface AuthAsIo {
  readStdin?: () => Promise<string>;
  isTTY?: boolean;
  prompt?: (label: string) => Promise<string>;
  runtime?: Argon2Runtime;
}

const STDIN_MAX_BYTES = 4096;

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > STDIN_MAX_BYTES) throw new CliError("the password on stdin is too long");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The terminal ends of a hidden prompt; the real process streams unless a test injects its own. */
export interface PromptTerminal {
  stdin: Pick<NodeJS.ReadStream, "on" | "off" | "pause" | "resume" | "setEncoding" | "setRawMode">;
  write: (text: string) => unknown;
}

/** Ask for a line with no echo. Only used on a terminal. */
export function promptHidden(
  label: string,
  term: PromptTerminal = { stdin: process.stdin, write: (t) => process.stderr.write(t) },
): Promise<string> {
  const { stdin } = term;
  term.write(label);
  return new Promise((resolve, reject) => {
    let buf = "";
    const finish = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      term.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish();
          resolve(buf);
          return;
        }
        if (ch === "\u0003") {
          finish();
          reject(new CliError("aborted"));
          return;
        }
        buf = ch === "\u007f" || ch === "\b" ? buf.slice(0, -1) : buf + ch;
      }
    };
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export async function obtainPassword(stdin: boolean, io: AuthAsIo): Promise<string> {
  if (stdin) return (await (io.readStdin ?? readAllStdin)()).replace(/\r?\n$/, "");
  if (!(io.isTTY ?? process.stdin.isTTY)) {
    throw new CliError(
      "there is no terminal to ask on: pass the password on standard input with --stdin",
    );
  }
  const ask = io.prompt ?? promptHidden;
  const first = await ask("New operator password: ");
  const second = await ask("Repeat the password: ");
  if (first !== second) throw new CliError("the two passwords do not match");
  return first;
}

export async function runAuthAsSetPassword(cmd: Cmd<"auth">, io: AuthAsIo = {}): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.configPath);
  if (enabledAs(cfg.auth) === undefined) {
    throw new CliError(
      "auth.as is not enabled in this config: set auth.as.enabled and auth.as.issuer first (there is no authorization-server account to set a password for)",
    );
  }
  const unsupported = argon2Unsupported(io.runtime);
  if (unsupported !== undefined) throw new CliError(unsupported);
  const username = normalizeUsername(cmd.user ?? "operator");
  if (username === undefined) {
    throw new CliError("--user may use letters, digits and . _ @ - (up to 64 characters)");
  }
  const password = await obtainPassword(cmd.stdin === true, io);
  const problem = passwordProblem(password);
  if (problem !== undefined) throw new CliError(problem);
  const passwordHash = await hashPassword(password);

  mkdirSync(cfg.cacheDir, { recursive: true, mode: 0o700 });
  const store = await openOauthDb(cfg);
  let status: "claimed" | "updated";
  try {
    const existing = findOperator(store.db, username);
    if (existing !== undefined) {
      setOperatorPassword(store.db, existing.sub, passwordHash);
      status = "updated";
    } else {
      const claim = claimOperator(store.db, { username, passwordHash, now: Date.now() });
      if (!claim.ok) {
        const sole = soleOperator(store.db);
        throw new CliError(
          claim.reason === "already_claimed" && sole !== undefined
            ? `this authorization server already has an operator (${sole.username}): pass --user ${sole.username} to change its password. Adding more users is not supported yet`
            : `cannot create operator ${username}: ${claim.reason.replace("_", " ")}`,
        );
      }
      status = "claimed";
    }
  } finally {
    store.close();
  }
  process.stdout.write(
    cmd.json
      ? `${JSON.stringify({ user: username, status })}\n`
      : status === "claimed"
        ? `operator ${username} claimed the authorization server; it can sign in at /oauth/login\n`
        : `password of operator ${username} updated; its sessions were ended\n`,
  );
}
