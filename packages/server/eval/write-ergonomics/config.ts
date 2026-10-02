// Scratch-config writer shared by the template build and the per-run setup. Everything lives in the
// scratch dir: the vault copy, the cacheDir and this config. Never ~/.obsidian-tc or /data/llm-stack.
import { writeFileSync } from "node:fs";
import { HARDENED_ACL } from "./tasks";

export type Arm = "main" | "hardened";

export function writeConfig(path: string, arm: Arm, vault: string, cacheDir: string): void {
  const cfg: Record<string, unknown> = {
    cacheDir,
    vaults: [{ id: "main", path: vault }],
    // The bundled local embedder is not built in a checkout, so semantic search degrades; the tasks
    // here need only text search and the write path. Same on every run, so it cannot skew a comparison.
    embeddings: { provider: "local", model: "bge-small-en-v1.5", dimensions: 384 },
    transports: { stdio: true, http: { enabled: false } },
  };
  if (arm === "hardened") {
    cfg.acl = HARDENED_ACL;
    cfg.writes = { requireCas: true };
    cfg.snapshots = { enabled: true, retention: 20 };
  }
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
}
