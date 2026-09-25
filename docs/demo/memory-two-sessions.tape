# memory-two-sessions.tape — the "Memory you own" guide's demo (getting-started/memory-you-own.md).
#
# Renders docs/public/demo/memory-two-sessions.gif: session ONE imports a small basic-memory note
# set into the vault's memory graph (obsidian-tc memory import --from basic-memory --apply), then a
# fresh session TWO — no state carried over except the vault itself — recalls what session one
# wrote, three ways: plain full-text (search_text), a graph walk (query_entity_graph), and a direct
# read (get_entity). The point of the recording is that recall in session two needs nothing but the
# vault: no server restart tricks, no hidden client-side cache, because the memory IS the vault.
#
# Not rendered in this environment — neither `vhs` nor `asciinema`/`agg` is installed here (see
# `command -v vhs asciinema agg`) — so this tape and
# docs/public/demo/memory-two-sessions-storyboard.svg (a static panel-by-panel stand-in) ship
# together until someone with the toolchain installed runs:
#
#   vhs docs/demo/memory-two-sessions.tape
#
# which regenerates docs/public/demo/memory-two-sessions.gif (kept under the 2 MB budget via
# Framerate/Width/Height below — re-check the file size after a re-render and tighten those if it
# grows past it). Both files live under docs/public/ (not docs/demo/, where this tape itself lives)
# because that is Astro/Starlight's static-asset directory — see quickstart.tape's own header for
# why. Every command below, and the storyboard SVG's panel text, was captured from REAL runs of the
# built server's `memory import` CLI and its create_entity/get_entity/query_entity_graph/
# search_text tools against a scratch copy of examples/scratch-vault's basic-memory fixture set
# (packages/server/test/fixtures/memory-import/basic-memory) — see the getting-started/
# memory-you-own.md guide page, which embeds the exact same captured output this tape re-derives.
#
# Prerequisite for a real run: a built obsidian-tc (`bun run build` in packages/server, or `npx
# obsidian-tc` once published) on PATH, and a small script or a second MCP client wired for the
# "session two" tool calls below — `obsidian-tc memory import` is a CLI command, but
# get_entity/query_entity_graph/search_text are MCP tools with no bare-CLI form, so a real render
# drives them through whatever MCP client this environment already recommends (see
# getting-started/first-run.md), the same choice quickstart.tape makes for its own tool calls.

Output docs/public/demo/memory-two-sessions.gif

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 780
Set Padding 20
Set Theme "Dracula"
Set TypingSpeed 60ms
Set Framerate 30

Hide
# A scratch copy of the fixture vault + the fixture basic-memory source directory, so this
# recording never dirties either checked-in fixture.
Type "cp -r examples/scratch-vault /tmp/memory-demo-vault && cp -r packages/server/test/fixtures/memory-import/basic-memory /tmp/memory-demo-src"
Enter
Sleep 500ms
Show

# ===== Session one =====

# 1. Dry-run preview — nothing written yet. Real output: 3 entities to create, 1 relation target
# not found (a note in the fixture references a note that is not in this small batch), 1 file
# skipped for malformed frontmatter.
Type "obsidian-tc memory import --from basic-memory /tmp/memory-demo-src /tmp/memory-demo-vault --vault main"
Enter
Sleep 2s

# 2. --apply writes for real: create_entity + add_observation + link_entities + update_frontmatter,
# through the same ACL/audit-checked dispatch an MCP client uses.
Type "obsidian-tc memory import --from basic-memory /tmp/memory-demo-src /tmp/memory-demo-vault --vault main --apply"
Enter
Sleep 2s

# 3. The materialized note, read straight off disk — plain Markdown, provenance frontmatter and
# all.
Type `cat "/tmp/memory-demo-vault/memory/note/Coffee Brewing Methods.md"`
Enter
Sleep 2s

Hide
Type "clear"
Enter
Show

# ===== Session two (fresh — nothing carried over but the vault) =====

# 4. Full-text recall, no embeddings needed.
Type `claude -p "search this vault's text for 'French press'"`
Enter
Sleep 3s

# 5. Graph recall from the entity search_text found.
Type `claude -p "walk the memory graph one hop out from the Coffee Brewing Methods entity"`
Enter
Sleep 3s

# 6. A direct read — confirms the observations and relations session one wrote are still there,
# unmodified, with no session-two setup beyond pointing at the same vault.
Type `claude -p "read the Coffee Brewing Methods memory entity in full"`
Enter
Sleep 3s

Hide
Type "rm -rf /tmp/memory-demo-vault /tmp/memory-demo-src"
Enter
Show
Sleep 1s
