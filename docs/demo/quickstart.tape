# quickstart.tape — the README/docs-home demo.
#
# Renders docs/public/demo/quickstart.gif: zero-config boot on the repo's own tiny fixture vault
# (examples/scratch-vault — synthetic placeholder content, see its README), a search, a read, and
# a write that overwrites an existing note and walks through the HITL confirmation it triggers.
# Not rendered in this environment — neither `vhs` nor `asciinema`/`agg` is installed here (see
# `command -v vhs asciinema agg`) — so this tape and docs/public/demo/quickstart-storyboard.svg (a
# static panel-by-panel stand-in, captured from a REAL run of the built server against a scratch
# copy of this same fixture vault, not invented) ship together until someone with the toolchain
# installed runs:
#
#   vhs docs/demo/quickstart.tape
#
# which regenerates docs/public/demo/quickstart.gif (kept under the 2 MB budget via Framerate/
# Width/Height below — re-check the file size after a re-render and tighten those if it grows past
# it). Both files live under docs/public/ (not docs/demo/, where this tape itself lives) because
# that is Astro/Starlight's static-asset directory — it is what makes the docs-home embed at
# /demo/quickstart-storyboard.svg (and, once rendered, /demo/quickstart.gif) actually servable.
#
# Prerequisite for a real run: the Claude Code CLI (`claude mcp add`/`claude -p` — the exact client
# wiring docs/src/content/docs/getting-started/first-run.md already recommends, reused here rather
# than inventing a demo-only client) on PATH, and network access for the `npx obsidian-tc` it spawns
# (no local build needed — npx pulls the published package). A scratch copy of examples/scratch-
# vault means the recording's write_note overwrite never touches the checked-in fixture.

Output docs/public/demo/quickstart.gif

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 720
Set Padding 20
Set Theme "Dracula"
Set TypingSpeed 60ms
Set Framerate 30

Hide
# A scratch copy so the recorded write_note overwrite never dirties the checked-in fixture vault.
Type "cp -r examples/scratch-vault /tmp/quickstart-demo-vault"
Enter
Sleep 500ms
Show

# 1. Wire the vault into Claude Code — one command, per first-run.md. `claude mcp add` spawns
# `npx obsidian-tc /tmp/quickstart-demo-vault` itself over stdio when a tool call needs it; no
# separate `npx obsidian-tc ... &` here — a stdio server backgrounded on an interactive TTY that
# still tries to read its controlling terminal raises SIGTTIN, which the plain zero-config
# invocation below (packages/server/src/cli/resolve-config.ts's `configFromVaultPath`) does not
# need, since Claude Code owns the process and its stdio pipes end to end.
Type "claude mcp add obsidian-tc -- npx -y obsidian-tc /tmp/quickstart-demo-vault"
Enter
Sleep 1.5s

# 2. search_text — "placeholder" is real content seeded across all three notes in the fixture
# vault (README.md, Welcome.md, 00-example/Example Note.md) — verified with a live run of the
# built server against this exact fixture: 6 hits, 3 notes.
Type `claude -p "search the vault for the word placeholder and show me what matched"`
Enter
Sleep 3s

# 3. read_note — open one of the notes the search surfaced.
Type `claude -p "read the Welcome note in full"`
Enter
Sleep 3s

# 4. write_note overwriting an existing note — triggers the HITL confirmation. Verified live: the
# call returns an `elicit_required` error (never a silent write), whose `recovery` text names the
# exact command to run: `obsidian-tc elicit --hash <args_hash> --tool write_note --vault main`.
# `claude -p` is headless and does NOT render an interactive approval prompt the way an
# interactive `claude` session would for a client-side MCP elicitation request — so this step
# shows the real `elicit_required` error text, not a fabricated `[y/N]` prompt.
Type `claude -p "overwrite the Welcome note with a one-line summary of what obsidian-tc does"`
Enter
Sleep 3s
Wait /elicit_required|human confirmation required/

# 5. The confirm: mint the token the error named, then resend the same write_note call with it —
# the same two-step Claude Code performs automatically for elicitation-capable clients, made
# explicit here since this recording is headless. `elicit` takes the SAME vault-path-or-config
# positional `serve` does (not a --config flag) — verified end to end against this exact fixture:
# args_hash a969f73c96f03e046659d695c867529c is the real value for Welcome.md's real content, and
# minting against it really does produce a token the retried write_note call accepts.
Type "obsidian-tc elicit /tmp/quickstart-demo-vault --hash a969f73c96f03e046659d695c867529c --tool write_note --vault main --json"
Enter
Sleep 2s
Type `claude -p "now retry the overwrite with that confirmation token"`
Enter
Sleep 3s

Hide
Type "rm -rf /tmp/quickstart-demo-vault"
Enter
Show
Sleep 1s
