---
title: Vault Conventions
description: Set folder rules in SCHEMA.md, choose which violations block a write, and find the notes that already break them.
---

A folder can declare rules for the frontmatter of the notes in it: which properties are required, which
values and tags are allowed, and how serious each violation is. The rules live in a `SCHEMA.md` file.
A rule set marked `block` refuses a write that would add a violation. Every other violation is reported
as a warning on the write's result.

:::note
Severity is an integrity aid for a well-behaved vault. It is not a security boundary: any caller who can
write a `SCHEMA.md` can change or remove its rules. To rely on blocking, deny writes to `SCHEMA.md` with the
folder ACLs, as described in [Folder ACLs](/security/acls/).
:::

## Where the rules live

A `SCHEMA.md` carries a `conventions:` block in its frontmatter. A note's rules come from the `SCHEMA.md`
files on its folder chain: the vault root, then each folder down to the note's own folder. Each layer is
merged over the one above it, and the nearest layer wins for each leaf key. A layer with `inherit: false`
cuts off the layers above it.

Every layer should set `version: 1`. A missing version reads as 1. A layer written for a newer version of
the server is ignored, and the server says so.

`get_conventions(path)` lists the rules that apply to a note or folder, with the layer each rule came from.
Call it before you write to a folder.

## The rule keys

All rules sit under `conventions.frontmatter`:

| Key | What it does |
| --- | --- |
| `required` | Properties every note in the folder must have. |
| `values` | A map from property to the allowed values. A note's value must be one of them. |
| `types` | Per-type rules, keyed by the note's type. Each type can set its own `required`, `values` and `severity`. |
| `severity` | The level (`warn` or `block`) of a violation, per property. `"*"` is the default for every property. |
| `type_key` | The frontmatter property that names a note's type. Defaults to `type`. |

Tags are matched, not compared as text. In `values.tags` (or `values.tag`):

- `x` matches the tag `x` exactly.
- `x/*` matches any tag nested under `x`, such as `x/y`, but not `x` itself.
- Matching ignores case. A leading `#` and a trailing `/` are dropped from both the rule and the tag.

Severity values are `warn` and `block`, trimmed and lower-cased. Any other value is dropped, and the layer
reports the mistake. `null` removes a severity inherited from a parent layer.

### Worked example: a child folder relaxes its parent

The vault root `SCHEMA.md` sets the rules for the whole vault:

```yaml
---
conventions:
  version: 1
  frontmatter:
    required: [type, status]
    values:
      status: [draft, current, archived]
      tags: [project, area/*]
    severity:
      status: block
    types:
      meeting:
        required: [date]
        severity:
          date: block
---
```

A child `SCHEMA.md` in `meetings/` relaxes the `status` rule for that folder only:

```yaml
---
conventions:
  version: 1
  frontmatter:
    severity:
      status: warn
---
```

A `status` value outside the list is a warning in `meetings/`, and still a block everywhere else. The
`date` rule for meetings is unchanged: it is a `block` the child did not name.

## Severity precedence

For a violation of property `p` on a note of type `t`, the first level that is set wins:

1. `types[t].severity[p]`
2. `severity[p]`
3. `types[t].severity["*"]`
4. `severity["*"]`
5. `warn`

A consequence catches people out. A parent's `types.X.severity.p: block` beats a child's `severity["*"]: warn`,
because the parent's named key is higher in the list. A child's `"*"` never relaxes a named parent block.

To relax a block, the child names the same key at the same level, or sets it to `null`. In the example above,
a child that wants meeting notes without a date to pass writes `types: { meeting: { severity: { date: warn } } }`
or `types: { meeting: { severity: { date: null } } }`. With `null`, the child's own `"*"` then applies.

## What blocks

Only a violation that the write itself adds can block. A violation is identified by its code, its property and
its value; the note's type is not part of the identity. So:

- **A partial fix always passes.** Removing one of several violations never blocks, even when the rest remain.
- **A new note counts in full.** Every blocking violation on it is a violation the write adds.
- **An existing note the caller cannot read is judged as new.** The verdict depends only on the bytes the
  caller sends, so it never reveals the old content.
- **An existing note over the read bound is judged as new** for the same reason: its old bytes are not read.
- **An existing note with broken YAML** counts every required property as missing, so a fix that adds them passes.
- **A rename in place passes**, even when the note already breaks a rule: its baseline is itself.

### Moves and copies

A move or copy is judged against its destination. The note's violations in its source folder are the baseline:
a violation that the source note already had under the source folder's rules does not count again.

- A rename within a folder passes.
- Moving a note into a stricter folder can be refused, if the note breaks a `block` rule there that it did not break
  where it was.
- A copy or move that overwrites an existing destination uses the source as the baseline, not the note it replaces.
- A source the caller cannot read is never blocked, so the verdict never reveals its frontmatter.
- The source's size does not matter: a large source is not read for the baseline, and the verdict judges the bytes
  being written against the source's rules.

### Bulk tools

- `bulk_create_notes`, `bulk_set_property` and similar bulk writes fail one item at a time. A blocked item has its
  error in its own `results[i].error`, and the other items are written. `stop_on_first_error` stops the batch at the
  first failure, as it does for any other error.
- `bulk_move_notes` refuses the whole batch. A real run with one refused row moves nothing.
- `bulk_move_notes` with `dry_run: true` writes nothing. Each row that a real run would refuse carries a
  `would_block` entry with the `convention_blocked` error.

### Warn-only writes

Two kinds of write report violations as warnings and never refuse:

- `restore_note`, which restores a snapshot, even when the snapshot breaks a `block` rule.
- Backlink rewrites of notes the call did not name. `move_note`, `move_attachment` and `bulk_move_notes` rewrite
  the links in other notes, and those notes are warn-only. The moved note itself is judged.

### Never gated

These never refuse a write: `rewrite_link`, `prune_hub_links`, the delete tools, memory and reflect notes, and
writes made outside a tool call, such as background sweeps and the command line. A write is checked only when its
tool declares the `conventions` field in its output. `rewrite_link`, `prune_hub_links` and `delete_note` do not.

Writes that are checked include `write_note`, `append_note`, `patch_note`, `move_note`, `copy_note`,
`update_frontmatter`, `add_tag`, `remove_tag`, `commit_wiki_page` and the periodic-note and template tools.

## The `convention_blocked` error

A refused write returns the error code `convention_blocked`. Nothing is written.

- `retryable` is `false`. Resending the same content is refused again.
- `details` has `path`, `violations` (each with its property, code, allowed values and source layer, capped at the
  warning limit) and `violations_omitted` (how many more were cut).
- The recovery path is `get_conventions(path)`. It shows the rules that apply. Fix the content so it no longer adds
  the violation, then send the write again.

A write that only fixes an existing violation is never refused.

## Fail-open behaviour

The check is advisory when something goes wrong. A write is never refused because the check itself failed.

- **A broken layer** (a `SCHEMA.md` that does not parse, or sets a bad value) contributes no rules. Its problems are
  still reported as file warnings.
- **An unreadable layer** is not applied, and its problems are not reported to the caller.
- **A check that throws** lets the write go ahead. The fault is reported to the server's internal-error handler, and
  the write's result has no `conventions` field.

## Reading the results

A successful write's result can carry `conventions.warnings`. Each warning has a `level` of `warn` or `block`.
A `block` entry on a write that succeeded means the note already had that violation and the write did not add it,
so the write was allowed.

To find violations across a folder, run `lint_wiki` with `checks: ["conventions"]`. Each note with a violation gets
a `conventions` proposal. Proposals for notes with a blocking violation come first, and their `detail` says how many
violations are blocking, for example `2 folder convention(s) broken (1 blocking): ...`. A layer with problems gets a
separate `conventions_file` proposal. Run it with `checks: ["conventions_file"]` if you want only the layer problems.
