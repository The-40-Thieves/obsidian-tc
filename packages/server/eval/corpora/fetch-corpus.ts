// Fetch a public suite corpus at its pinned commit and refuse anything that is not byte-identical to
// what the golden set was mined from. Nothing here is redistributed in the repo (the corpora are
// large, and an attribution file plus a pin is the whole obligation under their licences): the
// registry (`corpora.json`) names the source, the commit and a content digest, and this script
// proves a download matches it.
//
// The digest is sha256 over the lines `<relPath>\0<sha256 of file bytes>\n`, sorted by path. It is
// taken over the extracted markdown, not the archive: GitHub does not promise a stable tarball for a
// commit, and the content is the thing that has to match.
//
//   bun eval/corpora/fetch-corpus.ts <name> --out <dir>           fetch + verify
//   bun eval/corpora/fetch-corpus.ts <name> --out <dir> --digest  print the digest of what was fetched
//   bun eval/corpora/fetch-corpus.ts <name> --verify <dir>        verify a directory already on disk
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CorpusDigest {
  files: number;
  bytes: number;
  sha256: string;
}

/** How the golden set is mined from a corpus (`gen-corpus-golden.ts` owns the meaning). */
export interface GoldenRecipeSpec {
  seed: number;
  idPrefix: string;
  template: "en" | "zh";
  caps: Record<string, number>;
}

export interface RemoteCorpus {
  kind: "github";
  shape: string;
  language: string;
  licence: string;
  attribution: string;
  /** `owner/repo`. */
  repo: string;
  /** Full 40-character commit sha; a branch or tag name is refused. */
  commit: string;
  /** Only files under this prefix are kept, and the prefix is stripped. Empty keeps the whole tree. */
  subtree: string;
  digest: CorpusDigest;
  golden?: GoldenRecipeSpec;
}

export interface GeneratedCorpus {
  kind: "generated";
  shape: string;
  language: string;
  licence: string;
  attribution: string;
  generator: string;
  seed: number;
  queries: number;
}

export type CorpusSpec = RemoteCorpus | GeneratedCorpus;

export interface CorporaRegistry {
  corpora: Record<string, CorpusSpec>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const REGISTRY_PATH = join(HERE, "corpora.json");

export function loadRegistry(path: string = REGISTRY_PATH): CorporaRegistry {
  return JSON.parse(readFileSync(path, "utf8")) as CorporaRegistry;
}

/** Markdown files under `root`, vault-relative with forward slashes, dot-directories skipped (the
 *  indexer skips them too, so the digest covers exactly what a run could see). */
export function listMarkdown(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(rel);
    }
  };
  walk(root, "");
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function digestDirectory(root: string): CorpusDigest {
  const files = listMarkdown(root);
  const h = createHash("sha256");
  let bytes = 0;
  for (const rel of files) {
    const buf = readFileSync(join(root, rel));
    bytes += buf.length;
    h.update(`${rel}\0${createHash("sha256").update(buf).digest("hex")}\n`);
  }
  return { files: files.length, bytes, sha256: h.digest("hex") };
}

/** Throws a message naming every mismatching field; a pin that drifts must fail loudly. */
export function verifyDirectory(root: string, expected: CorpusDigest): CorpusDigest {
  const got = digestDirectory(root);
  const bad = (["files", "bytes", "sha256"] as const).filter((k) => got[k] !== expected[k]);
  if (bad.length > 0) {
    throw new Error(
      `corpus at ${root} does not match its pin (${bad
        .map((k) => `${k}: expected ${expected[k]}, got ${got[k]}`)
        .join("; ")})`,
    );
  }
  return got;
}

export function archiveUrl(spec: RemoteCorpus): string {
  if (!/^[0-9a-f]{40}$/.test(spec.commit)) {
    throw new Error(`corpus pin must be a full commit sha, got "${spec.commit}"`);
  }
  return `https://codeload.github.com/${spec.repo}/tar.gz/${spec.commit}`;
}

/** Copy the kept markdown out of an extracted archive tree into `outDir`. */
export function selectFromTree(treeRoot: string, subtree: string, outDir: string): number {
  const base = subtree === "" ? treeRoot : join(treeRoot, subtree);
  if (!existsSync(base)) throw new Error(`subtree "${subtree}" is absent from the archive`);
  const files = listMarkdown(base);
  for (const rel of files) {
    const dest = join(outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(base, rel), dest);
  }
  return files.length;
}

export async function fetchCorpus(
  spec: RemoteCorpus,
  outDir: string,
  opts: { archive?: Uint8Array; skipVerify?: boolean } = {},
): Promise<CorpusDigest> {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(
      `${outDir} is not empty; refusing to overwrite a corpus (eval data is the record)`,
    );
  }
  let bytes = opts.archive;
  if (bytes === undefined) {
    const res = await fetch(archiveUrl(spec));
    if (!res.ok) throw new Error(`fetch ${archiveUrl(spec)}: HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  const tmp = mkdtempSync(join(tmpdir(), "corpus-"));
  try {
    const archive = join(tmp, "a.tgz");
    writeFileSync(archive, bytes);
    const tree = join(tmp, "tree");
    mkdirSync(tree);
    execFileSync(
      "tar",
      ["-xzf", archive, "-C", tree, "--strip-components=1", "--wildcards", "*.md"],
      {
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    mkdirSync(outDir, { recursive: true });
    selectFromTree(tree, spec.subtree, outDir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return opts.skipVerify ? digestDirectory(outDir) : verifyDirectory(outDir, spec.digest);
}

if ((import.meta as unknown as { main?: boolean }).main) {
  const argv = process.argv.slice(2);
  const name = argv.find((a) => !a.startsWith("--"));
  const flag = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const spec = name ? loadRegistry().corpora[name] : undefined;
  if (!name || !spec) {
    process.stderr.write(
      `usage: bun eval/corpora/fetch-corpus.ts <name> (--out <dir> [--digest] | --verify <dir>)\nnames: ${Object.keys(loadRegistry().corpora).join(", ")}\n`,
    );
    process.exit(2);
  }
  if (spec.kind !== "github") {
    process.stderr.write(
      `${name} is generated, not fetched: bun ${spec.generator} --seed ${spec.seed}\n`,
    );
    process.exit(2);
  }
  const verifyDir = flag("--verify");
  const outDir = flag("--out");
  if (verifyDir) {
    process.stdout.write(`${JSON.stringify(verifyDirectory(verifyDir, spec.digest))}\n`);
  } else if (outDir) {
    const got = await fetchCorpus(spec, outDir, { skipVerify: argv.includes("--digest") });
    process.stdout.write(`${JSON.stringify(got)}\n`);
  } else {
    process.exit(2);
  }
}
