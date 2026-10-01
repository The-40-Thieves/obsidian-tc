// `obsidian-tc provenance verify` argv parsing. Split out of args.ts for the same reason
// parse-auth.ts documents: args.ts sits at biome's file-length floor.
import { flagValue, positional } from "./flag-value";

export interface ProvenanceCommand {
  kind: "provenance";
  sub: "verify";
  configPath?: string;
  json?: boolean;
  /** Verify only this vault's chain. Absent: every vault that has one. */
  vault?: string;
  /** Accept records and heads written with no signature (chain-only deployments). */
  allowUnsigned?: boolean;
}

const VALUE_FLAGS = ["--config", "--vault"];

export function parseProvenance(
  rest: string[],
): ProvenanceCommand | { kind: "error"; message: string } {
  if (rest[0] !== "verify") {
    return { kind: "error", message: `unknown provenance subcommand: ${rest[0] ?? "(none)"}` };
  }
  const args = rest.slice(1);
  // A value-taking flag's VALUE is never mistaken for the config path.
  const scan = args.filter((a, i) => {
    if (a.startsWith("-")) return false;
    const prev = args[i - 1];
    return !(prev !== undefined && VALUE_FLAGS.includes(prev));
  });
  const configPath = flagValue(args, "--config") ?? positional(scan);
  const vault = flagValue(args, "--vault");
  return {
    kind: "provenance",
    sub: "verify",
    ...(configPath !== undefined ? { configPath } : {}),
    ...(vault !== undefined ? { vault } : {}),
    json: args.includes("--json"),
    allowUnsigned: args.includes("--allow-unsigned"),
  };
}
