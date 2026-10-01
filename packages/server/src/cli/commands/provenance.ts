// `obsidian-tc provenance verify [path] [--vault <id>] [--allow-unsigned] [--json]`: check the
// write-provenance chain in cache.db against the auth registry's public keys. Read-only: it opens
// both databases read-only, changes nothing and writes no audit row. Exits 1 when any chain fails.
//
// Refuses, naming the recovery, when the auth registry was initialised but auth.db is lost: with no
// keys every signature would read as `unknown_kid`, which says "tampered" when the truth is "cannot
// tell". Same boundary as `auth`: filesystem access to the cache directory is the credential.
import { inspectProvenance } from "../../provenance/inspect";
import { CliError } from "../cli-error";
import { type Cmd, resolveOrUsageExit } from "../shared";

export async function run_provenance(cmd: Cmd<"provenance">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.configPath);
  const r = await inspectProvenance(cfg, {
    ...(cmd.vault !== undefined ? { vault: cmd.vault } : {}),
    allowUnsigned: cmd.allowUnsigned === true,
  });
  if (r.registry.state === "lost") {
    throw new CliError(
      `cannot verify signatures: ${r.registry.detail ?? "the auth registry is lost"}`,
    );
  }
  if (cmd.json) {
    process.stdout.write(`${JSON.stringify({ ok: r.ok, vaults: r.vaults }, null, 2)}\n`);
  } else if (r.vaults.length === 0) {
    process.stdout.write(
      r.tablePresent
        ? "no provenance records\n"
        : "no provenance records (cache.db has none yet)\n",
    );
  } else {
    for (const v of r.vaults) {
      process.stdout.write(
        `vault ${v.vault}: ${v.records} record${v.records === 1 ? "" : "s"} (${v.signed} signed, ${v.unsigned} unsigned): ${v.ok ? "OK" : "FAILED"}\n`,
      );
      for (const p of v.problems) {
        process.stdout.write(
          `  ${p.seq === undefined ? "head" : `seq ${p.seq}`} ${p.code}: ${p.detail}\n`,
        );
      }
    }
  }
  if (!r.ok) process.exitCode = 1;
}
