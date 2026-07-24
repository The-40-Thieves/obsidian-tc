# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual
label strings used in this repo's issue tracker (Linear, team **The 13th Letter** — see
[`issue-tracker.md`](./issue-tracker.md)).

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label
string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

> **Not yet created.** None of these five labels exist on the The 13th Letter team — the team
> currently uses topic labels (`kms-*`, `music-*`, `aedras-*`) plus `Bug` / `Feature` /
> `Improvement`. Create the five above before the first `/triage` run, or edit the right-hand
> column to point at labels that already exist.

> **Applying a label replaces the whole set.** Linear's `save_issue` takes `labels` as a full
> replacement, not a delta. Read the issue's current labels first and pass them back alongside the
> triage label, or you will strip its `kms-*` topic label as a side effect.
