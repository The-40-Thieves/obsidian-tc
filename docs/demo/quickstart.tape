# quickstart.tape — the README/docs-home demo.
#
# Renders docs/public/demo/quickstart.gif: zero-config boot on the repo's own tiny fixture vault
# (examples/scratch-vault — synthetic placeholder content, see its README), a search, a read, and
# a write that overwrites an existing note and walks through the HITL confirmation it triggers.
# Not rendered in this environment — neither `vhs` nor `asciinema`/`agg` is installed here (see
# `command -v vhs asciinema agg`) — so this tape and docs/public/demo/quickstart-storyboard.svg (a
# static panel-by-panel stand-in built from these same beats) ship together until someone with the
# toolchain installed runs:
#
#   vhs docs/demo/quickstart.tape
#
# which regenerates docs/public/demo/quickstart.gif (kept under the 2 MB budget via Framerate/
# Width/Height below — re-check the file size after a re-render and tighten those if it grows past
# it). Both files live under docs/public/ (not docs/demo/, where this tape itself lives) because
# that is Astro/Starlight's static-asset directory — it is what makes the docs-home embed at
# /demo/quickstart-storyboard.svg (and, once rendered, /demo/quickstart.gif) actually servable.
#
# Prerequisite for a real run: `bun run build` once (so `node packages/server/dist/cli.js` and the
# Claude Code CLI's `claude mcp add`/`claude -p` — the exact client wiring docs/src/content/docs/
# getting-started/first-run.md already recommends, reused here rather than inventing a demo-only
# client — are both on PATH), and a scratch copy of examples/scratch-vault so the recording's
# write_note overwrite never touches the checked-in fixture.

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

# 1. Zero-config boot: a bare vault path is enough, no config file (packages/server/src/cli/
# resolve-config.ts's `configFromVaultPath`) — start it in the background so this one terminal can
# also drive the client below.
Type "npx obsidian-tc /tmp/quickstart-demo-vault &"
Enter
Sleep 2s
Wait /ready on stdio/

# 2. Wire the running server into Claude Code — the one-command form first-run.md documents.
Type "claude mcp add obsidian-tc -- npx -y obsidian-tc /tmp/quickstart-demo-vault"
Enter
Sleep 1.5s

# 3. search_text — find the seeded note by its placeholder content.
Type `claude -p "search the vault for the word onboarding and show me what matched"`
Enter
Sleep 3s

# 4. read_note — open the note the search surfaced.
Type `claude -p "read the Welcome note in full"`
Enter
Sleep 3s

# 5. write_note overwriting an existing note — triggers the HITL confirmation
# (packages/server/src/cli/commands/elicit-mint.ts's mintElicitAudited path): the tool call is
# held pending a token, Claude Code surfaces it as a confirmation prompt, and the demo approves it
# rather than the call silently succeeding.
Type `claude -p "overwrite the Welcome note with a one-line summary of what obsidian-tc does"`
Enter
Sleep 2s
Wait /confirm/
Sleep 500ms

# 6. Approve the pending write.
Type "y"
Enter
Sleep 2s

Hide
Type "kill %1 2>/dev/null; rm -rf /tmp/quickstart-demo-vault"
Enter
Show
Sleep 1s
