---
title: External Capture & Import
description: Pull ambient screen activity or Readwise highlights into your vault, staged for human review before anything is written.
---

obsidian-tc can pull content in from outside your vault — passively-captured screen
activity, or highlights from a read-later service — through the same
**staged-and-reviewed** pipeline every capture producer uses: nothing lands in your
vault until you explicitly approve it.

:::note
Both importers are **inert by default**. If you never configure a source, neither
CLI command makes a network call or changes anything.
:::

## The pipeline

```
backend (Pensieve, Readwise, …)
        │
        ▼
  obsidian-tc CLI import command   (import-ambient / import-highlights)
        │  redact secret-shaped substrings, drop exact duplicates
        ▼
     capture_queue                 (SQLite — not the vault)
        │  poison-scanned at enqueue time
        ▼
  list_capture_queue               (you, or your MCP client, review the queue)
        │
        ▼
    commit_capture                 (explicit, per-item — the only vault write)
        │
        ▼
      your vault
```

`commit_capture` is the **only** path from the capture queue to a vault note, and it
is always a deliberate, per-item call naming a target path. Every row is scanned
for poison-shaped content the moment it's enqueued (instruction overrides,
persistence directives, hidden/obfuscated text) and carries that verdict —
`none` / `suspect` / `high` — into the queue for review. `high` is refused
outright at `commit_capture` time, even if you try to commit it — it never
reaches the vault regardless of review.

This guide covers both importers obsidian-tc ships today: **ambient screen
capture** (via [Pensieve](https://github.com/arkohut/pensieve)) and **Readwise
highlight import**. Ambient capture is the newer of the two and needs a companion
app installed and configured, so it gets most of this page.

## Ambient capture (Pensieve)

### What it is

[Pensieve](https://github.com/arkohut/pensieve) (Apache-2.0, formerly "Memos") is a
privacy-focused passive screen recorder maintained outside obsidian-tc: it
screenshots your desktop on an interval, runs local OCR over each screenshot, and
serves the result through a local HTTP API and web UI. obsidian-tc's `import-ambient`
command polls that API, maps whatever it finds into a source-agnostic observation
shape, and stages it for review — it does no screen capture of its own.

That source-agnostic shape (`CanonicalAmbientObservation`) is deliberately not tied
to Pensieve's vocabulary — see [Extending: writing your own backend](#extending-writing-your-own-backend-adapter)
below.

### Installing Pensieve

Pensieve currently **supports macOS and Windows**; Linux support is upstream
**work in progress** (documented as such by the Pensieve project itself). If
you're on Linux, keep an eye on the upstream project rather than expecting this
today.

```sh
pip install memos
```

Then initialize and start it:

```sh
memos init      # writes ~/.memos/config.yaml and its SQLite database
memos enable    # set the service to start on boot
memos start     # begin recording screens, serve the web UI
```

By default Pensieve serves on `http://127.0.0.1:8839` and binds to localhost only.

**macOS:** the first `memos start` triggers a screen-recording permission prompt —
allow it. `memos doctor` reports which interpreter path needs the permission
without triggering a fresh prompt; if you upgrade Python (Homebrew, a new pyenv
version, etc.) the grant goes stale and needs re-authorizing via **System
Settings → Privacy & Security → Screen & System Audio Recording**. Installing
with `pipx install memos` or `uv tool install memos` (rather than a bare
`pip install`) pins the interpreter path so upgrades don't invalidate the grant.

**Windows:** prefer an isolated install over a bare `pip install`:

```powershell
# uv
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
uv tool install memos

# or pipx
pip install --user pipx
python -m pipx ensurepath
pipx install memos
```

Avoid running it under WSL (WSL cannot capture the Windows host's screen) or under
a Python installed from the Microsoft Store (its sandboxed filesystem breaks
Pensieve's paths).

### Pointing obsidian-tc at it

Set `pensieve.baseUrl` in your obsidian-tc config to Pensieve's address:

```json
{
  "vaults": [{ "id": "primary", "path": "/home/user/vaults/primary" }],
  "pensieve": {
    "baseUrl": "http://127.0.0.1:8839"
  }
}
```

Leaving `pensieve` out of the config entirely is the supported "not using this
feature" state — `import-ambient` then no-ops with no network call.

#### Running Pensieve on a different machine

Pensieve's default bind (`127.0.0.1`) only accepts connections from the same
machine it runs on. If obsidian-tc runs on a different box than the one being
recorded — the common setup, since you point ambient capture at whichever machine
you actually work on — reach Pensieve over a private network you control (a
Tailscale/WireGuard-style overlay, or a LAN you trust), not the open internet:

1. On the Pensieve machine, edit `~/.memos/config.yaml` and change
   `server_host: 127.0.0.1` to the address you want it reachable on (its
   Tailscale IP, or `0.0.0.0` to bind every interface — only do this on a
   network you trust, see below), then `memos stop && memos start`.
2. Point `pensieve.baseUrl` at that address, e.g.
   `"http://100.x.x.x:8839"`.

:::caution
Pensieve's API has **no authentication** — access control is entirely up to
whatever network it's reachable on. Only expose it on a private network/VPN
(Tailscale, WireGuard, a trusted LAN), never on the open internet.
:::

### `--machine` labeling

Every observation is stamped with a machine label, since a Pensieve instance
polled over the network has no way to identify itself. It defaults to the
hostname in `pensieve.baseUrl`, but you can override it — useful if you run
Pensieve on more than one computer and want to tell them apart in the queue:

```sh
obsidian-tc import-ambient --vault primary --machine laptop
obsidian-tc import-ambient --vault primary --machine desktop
```

(Point `pensieve.baseUrl` at the right instance before each run if you're
polling more than one machine from the same obsidian-tc config.)

### Running it

```
obsidian-tc import-ambient [path] --vault <id> [--since <iso-date>] [--machine <label>] [--dry-run]
```

- **One-shot:** `obsidian-tc import-ambient --vault primary` pulls the most recent
  observations (bounded per-run, newest first) and stages them.
- **Incremental:** `--since <ISO 8601 timestamp>` scopes to observations captured
  after that instant — this is how you'd run it on a schedule without re-fetching
  everything each time.
- **Preview:** `--dry-run` reports what would be enqueued (including how many
  secrets would be redacted) without writing to the capture queue.

```sh
obsidian-tc import-ambient --vault primary --since 2026-08-17T00:00:00Z --dry-run
```

#### Scheduling

Run it on an interval so ambient capture stays incremental. Track "last run"
yourself (a small wrapper script, or your scheduler's own last-success time) and
pass it as `--since`.

**cron** (Linux/macOS), every 15 minutes:

```
*/15 * * * * /usr/local/bin/obsidian-tc import-ambient /home/user/.config/obsidian-tc/config.json --vault primary --since "$(date -u -d '20 minutes ago' +%Y-%m-%dT%H:%M:%SZ)" >> /home/user/.local/state/obsidian-tc/import-ambient.log 2>&1
```

**launchd** (macOS), a user LaunchAgent (`~/Library/LaunchAgents/io.obsidian-tc.import-ambient.plist`)
running the same command every 900 seconds via `StartInterval`, invoking
`obsidian-tc import-ambient <config> --vault primary --since <timestamp>` as its
`ProgramArguments` — same idea as the cron line above, just launchd's XML shape
instead of a crontab line.

**Task Scheduler** (Windows), one-liner via `schtasks`:

```powershell
schtasks /create /tn "obsidian-tc import-ambient" /sc minute /mo 15 /tr "obsidian-tc import-ambient C:\Users\you\obsidian-tc\config.json --vault primary" /st 00:00
```

(Overlapping `--since` windows are safe — re-observed screens dedupe out; see
below.)

### Reviewing and committing

`import-ambient` only stages rows in the capture queue. To get them into your
vault, review and commit them — either by asking your MCP client to call
`list_capture_queue` / `commit_capture`, or however your client surfaces the
capture queue. Nothing is written to the vault by the import command itself.

## Highlight import (Readwise)

The same staged-and-reviewed pipeline also backs `import-highlights`, which pulls
highlights from a [Readwise](https://readwise.io) account:

```
obsidian-tc import-highlights [path] --vault <id> [--since <iso-date>] [--dry-run]
```

Configure it with a Readwise access token
([readwise.io/access_token](https://readwise.io/access_token)):

```json
{
  "readwise": {
    "token": "your-readwise-token"
  }
}
```

Like `pensieve`, leaving `readwise` unconfigured means `import-highlights` no-ops
with no network call. `--since` scopes to highlights Readwise has updated after
that instant, and `--dry-run` previews without enqueuing. Highlights dedupe on a
hash of (source, source id, text, location, highlighted-at), so re-running a sync
never re-stages the same highlight twice.

## Privacy and security

- **Redaction before enqueue.** Ambient observations are scanned for
  credential-shaped substrings (API keys, tokens, private key blocks, connection
  strings with embedded passwords, and similar patterns) and those are stripped
  out **before** the row ever reaches the capture queue — not after, and not only
  if a reviewer happens to notice.
- **Deduplication.** A re-polled, unchanged screen (the same app showing the same
  text) is recognized and skipped rather than re-staged every run.
- **Human review is mandatory.** Every ambient observation sits in `capture_queue`
  as staged content only. Nothing reaches your vault without an explicit
  `commit_capture` call naming a target path — there is no "auto-commit" setting.
  A capture that fails the poison scan at high risk is refused at commit time even
  if you try.
- **Nothing is captured unless you set it up.** obsidian-tc does no screen
  recording itself. Without `pensieve.baseUrl` configured, `import-ambient` never
  makes a network call; without Pensieve running, there is nothing to import in
  the first place.

:::caution
**Pensieve stores unredacted screenshots and OCR text on the machine it runs on.**
obsidian-tc's redaction only applies to what gets staged into `capture_queue` —
Pensieve's own local database (`~/.memos/`) keeps the raw, unredacted capture
history it recorded, by design (that's what lets you browse it in Pensieve's own
web UI). Enable full-disk encryption on that machine (FileVault on macOS,
BitLocker on Windows) so that data isn't sitting in the clear.
:::

## When Pensieve is unreachable

If `pensieve.baseUrl` is set but Pensieve doesn't respond (not running, wrong
address, network unreachable), `import-ambient` fails loudly: it prints the HTTP
status or connection error to stderr and exits non-zero. It does not silently
skip the run or partially stage results — fix the connection and re-run.

## Extending: writing your own backend adapter

`import-ambient` doesn't hardcode Pensieve's data model into the capture pipeline.
Everything downstream of fetching — redaction, dedup, staging — works against one
source-agnostic shape, `CanonicalAmbientObservation` (`source`, `machine`, `app`,
`window_title`, `text`, `captured_at`, `url`), defined alongside the ingestion
logic in the server package's `capture/ambient-import.ts`. Pensieve's adapter
(`capture/pensieve.ts`) is just the first thing that produces this shape from a
real backend's API — a new one needs only a function that fetches from some other
source and maps its results onto the same fields, the way `capture/pensieve.ts` does for
Pensieve's `/api/search` endpoint. This is the extension point if you want
obsidian-tc to pull ambient observations from a different backend: implement the
mapping, wire it into a CLI entry point the same way, and you get redaction,
dedup, poison scanning, and the human review gate for free.
