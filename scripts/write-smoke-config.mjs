// Writes a minimal obsidian-tc config for the install smoke test (ci-install-smoke.yml):
// one vault rooted at <vaultDir>, cache at <cacheDir>. Creates both dirs. Node serializes
// the JSON so OS-native paths (including Windows backslashes) are escaped correctly across
// the linux/macos/windows runners — no shell-specific path munging needed.
import { mkdirSync, writeFileSync } from "node:fs";

const [vaultDir, cacheDir, outFile] = process.argv.slice(2);
if (!vaultDir || !cacheDir || !outFile) {
  console.error("usage: node scripts/write-smoke-config.mjs <vaultDir> <cacheDir> <outFile>");
  process.exit(2);
}

mkdirSync(vaultDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
writeFileSync(
  outFile,
  `${JSON.stringify({ vaults: [{ id: "smoke", path: vaultDir }], cacheDir }, null, 2)}\n`,
);
console.log(`wrote ${outFile}`);
