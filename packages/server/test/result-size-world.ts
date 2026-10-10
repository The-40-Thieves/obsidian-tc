// A deliberately large, realistic generated vault for the default-page-size census
// (result-size-budget.test.ts): hundreds of notes in nested folders with tags, properties, links,
// tasks and multi-paragraph bodies, plus attachments, indexed through the real index_vault so every
// DB-backed list/search tool has something to page over.

import { createPagingDeps } from "../src/mcp/byte-page";
import { registerM1Tools } from "../src/tools/m1";
import { registerM3Tools } from "../src/tools/m3";
import { registerM4Tools } from "../src/tools/m4";
import { registerM7Tools } from "../src/tools/m7";
import { type M2Vault, makeM2Vault } from "./m2-helpers";

export const NOTE_COUNT = 600;
const FOLDERS = [
  "projects/alpha",
  "projects/beta",
  "projects/gamma",
  "research/papers",
  "research/notes",
  "daily/2026",
  "people",
  "meetings/weekly",
  "meetings/adhoc",
  "reference/snippets",
  "reference/glossary",
  "inbox",
];
const TAGS = ["project", "idea", "todo", "meeting", "research", "reading", "draft", "archive"];
const TOPICS = [
  "retrieval pipeline latency",
  "vault indexing strategy",
  "embedding provider migration",
  "weekly planning review",
  "reading notes on distributed systems",
  "release checklist",
  "customer interview synthesis",
  "garden maintenance schedule",
];

const sentence = (i: number, j: number): string =>
  `Paragraph ${j} of note ${i} discusses ${TOPICS[(i + j) % TOPICS.length]} and records the decision, the open question and the follow-up owner so the thread can be resumed later without rereading the whole history.`;

/** One realistic note: frontmatter (tags, status, area), a heading tree, links, tasks, prose. */
export function noteText(i: number): string {
  const tags = [TAGS[i % TAGS.length], TAGS[(i * 3 + 1) % TAGS.length]].join(", ");
  // Forward links, plus one back to the note that links forward to this one: short cycles exist.
  const links = [1, 2, 3, 4, 5, -1]
    .map((d) => `[[${notePath((i + d * 7 + NOTE_COUNT) % NOTE_COUNT)}]]`)
    .join(", ");
  const paras = [0, 1, 2, 3, 4, 5].map((j) => sentence(i, j)).join("\n\n");
  return [
    "---",
    `title: Note ${i} on ${TOPICS[i % TOPICS.length]}`,
    `tags: [${tags}]`,
    `status: ${["open", "done", "blocked"][i % 3]}`,
    `area: ${FOLDERS[i % FOLDERS.length]}`,
    "---",
    `# Note ${i} on ${TOPICS[i % TOPICS.length]}`,
    "",
    // [[hub]] gives the hub note NOTE_COUNT backlinks; the two missing targets give the dangling-link
    // scan NOTE_COUNT * 3 unresolved links to page over.
    `Related: ${links}, [[hub]], [[missing-target-${i % 40}]], [[missing-${i}-a]], [[missing-${i}-b]]`,
    "",
    "## Summary",
    "",
    paras,
    "",
    "## Actions",
    "",
    `- [ ] follow up on ${TOPICS[(i + 1) % TOPICS.length]} #todo`,
    `- [x] draft the summary for note ${i}`,
    "",
  ].join("\n");
}

export const notePath = (i: number): string =>
  `${FOLDERS[i % FOLDERS.length]}/note-${String(i).padStart(4, "0")}-${(TOPICS[i % TOPICS.length] ?? "").replaceAll(" ", "-")}.md`;

export interface SizeWorld {
  vault: M2Vault;
  notePaths: string[];
  cleanup(): void;
}

export async function makeSizeWorld(): Promise<SizeWorld> {
  const files: Record<string, string> = {};
  const notePaths: string[] = [];
  for (let i = 0; i < NOTE_COUNT; i++) {
    const p = notePath(i);
    notePaths.push(p);
    files[p] = noteText(i);
  }
  files["hub.md"] = "# Hub\n\nEvery note links here.\n";
  // Attachments: a few hundred images/PDFs. Bytes are irrelevant to listing.
  for (let i = 0; i < 300; i++) files[`assets/images/screenshot-2026-10-${i}.png`] = "png";
  for (let i = 0; i < 40; i++) files[`assets/docs/paper-${i}.pdf`] = "pdf";
  const vault = makeM2Vault({ files });
  await vault.call("index_vault", { vault: "test" });
  registerM1Tools(vault.registry, {
    vaultRegistry: vault.vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "ollama", model: "nomic-embed-text" },
    paging: createPagingDeps({
      secret: "test-secret",
      budgetBytes: () => vault.registry.maxResponseBytes,
    }),
  });
  registerM3Tools(vault.registry, { vaultRegistry: vault.vaultRegistry });
  // Bridge-less: list_tasks / tasks_filter read the vault files themselves.
  registerM4Tools(vault.registry, {
    reindex: () => {},
    vaultRegistry: vault.vaultRegistry,
    capabilities: (() => ({})) as never,
    bridgeFor: () => undefined,
    timeouts: (() => ({})) as never,
    commandPolicy: () => ({ enabled: false, allowlist: [] }),
    mode: () => "headless",
  });
  registerM7Tools(vault.registry, {
    vaultRegistry: vault.vaultRegistry,
    embeddingProvider: vault.provider,
    reranker: null,
    roles: null,
  });
  return { vault, notePaths, cleanup: () => vault.cleanup() };
}
