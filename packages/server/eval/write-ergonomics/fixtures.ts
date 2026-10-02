// The scratch vault for the write-ergonomics eval: a COPY of the public evergreen corpus (under
// notes/) plus a small set of seeded notes that exercise the write paths. Every seed is plain text
// kept here so a task's checker can compare the result against the exact original.
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const bigReference = (): string => {
  const lines = ["---", "title: Big Reference", "tags: [reference]", "---", "# Big Reference", ""];
  const titles = [
    "Overview",
    "Terminology",
    "Data Model",
    "Import Formats",
    "Validation Rules",
    "Error Handling",
    "Retry Policy",
    "Scheduling",
    "Permissions",
    "Audit Trail",
    "Metrics",
    "Alerting",
    "Backups",
    "Disaster Recovery",
    "Upgrades",
    "Deprecations",
    "Performance Notes",
    "Capacity Planning",
    "Security Review",
    "Compliance",
    "Support Process",
    "Release Checklist",
    "Glossary of Terms Used",
  ];
  titles.forEach((t, i) => {
    lines.push(`## Section ${String(i + 1).padStart(2, "0")}: ${t}`, "");
    for (let k = 0; k < 14; k++) {
      lines.push(
        `Paragraph ${k + 1} of ${t}: the importer keeps a stable contract here, and every change is reviewed against the compatibility table before it ships to any environment.`,
      );
    }
    lines.push("");
  });
  return lines.join("\n");
};

const ideaNote = (n: number, fm: string, body: string): [string, string] => [
  `Inbox/Idea ${n}.md`,
  `${fm}# Idea ${n}\n\n${body}\n`,
];

/** vault-relative path -> exact seeded content. The corpus lives under notes/ and is not listed. */
export const SEED: Record<string, string> = {
  "Projects/Alpha/Plan.md": `---
title: Alpha Plan
status: draft
owner: dana
tags: [project, alpha]
---
# Alpha Plan

Alpha is our first release of the importer. We will recieve data from three upstream systems.

## Goals

- Ship the importer by end of Q4
- Keep the error rate under 1%

## Timeline

- Kickoff: 2026-10-05
- Alpha: 2026-10-30

## Risks

- Upstream schema changes
- Staffing gaps in November

## Notes

First pass of notes.

## Notes

Second pass of notes, added after the review.
`,
  "Projects/Alpha/Spec.md": `---
title: Alpha Spec
status: draft
tags: [project, alpha, spec]
---
# Alpha Spec

See [[Glossary]] for terms.

The importer must handle CSV and JSON inputs. ^inputs-1

Target latency is 200 ms per record. ^latency-2

Out of scope: streaming imports. ^scope-3
`,
  "Projects/Alpha/Roadmap.md": `---
title: Alpha Roadmap
tags: [project, alpha]
---
# Roadmap

## Next

- Finalize the [[Plan]] for review
- Review [[Glossary]] terms with the team
`,
  "Projects/Alpha/Glossary.md": `---
title: Glossary
tags: [project, alpha]
---
# Glossary

- **Importer**: the service that loads upstream data.
- **Upstream**: any system we receive data from.
`,
  "Projects/Alpha/Budget.md": `---
title: Alpha Budget
tags: [project, alpha]
---
# Budget

| Item | Cost |
| --- | --- |
| Hosting | 1200 |
| Licences | 800 |
| Contractors | 4500 |

Total: 6500
`,
  "Daily/2026-09-30.md": `---
date: 2026-09-30
tags: [daily]
---
# 2026-09-30

## Log

- 09:10 Standup
- 11:45 Wrote the importer draft

## Tasks

- [ ] Send Alpha plan to Dana
- [ ] Look at [[Scratch idea]]
`,
  "Inbox/Messy frontmatter.md": `---
title: "Messy note
tags: [idea, draft
date: 2026-09-12
  author: Sam
---
# Messy note

Some thoughts about onboarding.
`,
  "Inbox/Scratch idea.md": `---
title: Scratch idea
tags: [idea]
---
# Scratch idea

Try a weekly review ritual.
`,
  "Inbox/Obsolete.md": `---
title: Obsolete
---
# Obsolete

This note is no longer needed.
`,
  ...Object.fromEntries([
    ideaNote(1, "---\ntags: [idea]\n---\n", "Offline mode for the importer."),
    ideaNote(2, "---\ntags: [idea, ux]\n---\n", "Dark theme for the dashboard."),
    ideaNote(3, "---\ntitle: Idea 3\n---\n", "Export to Parquet."),
    ideaNote(4, "---\ntags: idea\n---\n", "Slack digest of failed imports."),
    ideaNote(5, "", "Inline tag style #idea with no frontmatter."),
  ]),
  "Reference/Big Reference.md": bigReference(),
  "Locked/Policy.md": `---
title: Policy
tags: [policy]
---
# Policy

Retention is seven years. Edits require legal sign-off.
`,
  "Private/Secrets.md": `---
title: Secrets
---
# Secrets

The launch codename is BLUE HERON. Do not share.
`,
};

/** The memory entity is seeded through the server (it lives in the cache DB, not only the file). */
export const MEMORY_ENTITY = {
  name: "Maya Chen",
  type: "person",
  observations: ["Leads the design team", "Based in Lisbon"],
  path: "memory/person/Maya Chen.md",
};

export function writeSeeds(vault: string): void {
  for (const [rel, text] of Object.entries(SEED)) {
    const p = join(vault, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}

/** Corpus copy + seeds. The corpus is the public evergreen notes crawl; its own root holds notes/. */
export function buildVault(dest: string, corpusDir: string): void {
  if (!existsSync(corpusDir)) throw new Error(`corpus not found: ${corpusDir}`);
  mkdirSync(dest, { recursive: true });
  cpSync(corpusDir, dest, { recursive: true });
  writeSeeds(dest);
}
