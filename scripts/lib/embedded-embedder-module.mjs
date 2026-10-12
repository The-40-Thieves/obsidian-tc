import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/** Compress and checksum the runtime files that a standalone binary embeds as Bun file assets. */
export function prepareEmbeddedRuntimeFiles(runtimeFiles, workDir) {
  return runtimeFiles.map(({ name, path }) => {
    const bytes = readFileSync(path);
    const gz = join(workDir, `${name}.gz`);
    writeFileSync(gz, gzipSync(bytes, { level: 9 }));
    return { name, gz, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

/** Build the module that replaces the standalone binary's source-control placeholder. */
export function generateEmbeddedEmbedderModule(files, embedderPackage) {
  return `${files.map((file, i) => `import asset${i} from ${JSON.stringify(file.gz)} with { type: "file" };`).join("\n")}
const files = [
${files.map((file, i) => `  { name: ${JSON.stringify(file.name)}, asset: asset${i}, sha256: ${JSON.stringify(file.sha256)} },`).join("\n")}
];
export const embeddedEmbedder = {
  files,
  load: () => import(${JSON.stringify(embedderPackage)}),
};
export const localEmbedderAbsentFromBinary = false;
`;
}
