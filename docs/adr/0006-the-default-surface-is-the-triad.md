# The default tool surface is the triad, and stays that way until something measures otherwise

obsidian-tc registers 150 capabilities and advertises **three** by default. `toolFacade.mode`
defaults to `triad`, so a fresh install hands a client `find_capability`, `describe_capability` and
`call_capability`, and nothing else. Every capability remains callable; only the advertised surface
is collapsed.

This has been read as a problem twice. In July 2026 two tickets proposed shipping a hand-curated
lean profile instead, and both were cancelled on the same day because the facade had landed and was
a stronger form of the same idea. A third ticket reopened the proposal a fortnight later, asking for
"a curated 8-12 semantic tool default" — which the shipped default already beats by a factor of
three or four. We are keeping the triad.

The competitive read is the part worth writing down, because it inverts the intuition. Across the
four Obsidian MCP servers anyone actually uses, the default surface runs from 6 to 15 tools, median
about 9 or 10, and **not one of them ships a progressive-disclosure mechanism**. They do not need
one: nobody else has a surface large enough to require it. So obsidian-tc is simultaneously the
largest total surface in the category by an order of magnitude, and the *smallest default*. The
familiar complaint — too many tools — is true of the total and false of the thing a new user is
handed.

What we are not claiming is that the triad is *better*. Both 2026 cancellations made reopening
conditional on the same thing: evidence that the facade is worse for tool-selection accuracy than a
flat curated subset would be. That evidence has never been gathered, and the instrument to gather it
does not exist — `packages/server/eval/` measures retrieval quality (nDCG against a golden set),
which is a different question entirely. Choosing the triad today is therefore a decision to leave a
working default alone, not a finding that it wins.

That makes the reopen path specific. If the triad's roughly 50:1 compression is ever suspected of
hurting tool selection, the answer is **an eval that measures tool selection** — not flipping the
default to `domain` on intuition, and not reviving a hand-curated preset. Flipping `domain` on is one
line and the domain map is complete and gated, so it stays cheap whenever there is a reason; there
just is not one yet.

Nothing here removes an option. The infrastructure for a lean profile exists twice over —
`toolVisibility.allowed` is a literal name allowlist, and the three facade modes are already
configurable — and both remain supported. One genuine residual is worth naming: only 15 of the 150
definitions carry `tags`, so the `hiddenTags` / `disabledTags` filters are largely inert. Anything
tag-driven needs that filled in first.

One piece of record-keeping came out of this and is fixed alongside it. The domain-verb facade
shipped in 1.3.0 under the number of the ticket whose *strategy* had just been cancelled, so the
CHANGELOG and several source comments credited a cancelled ticket with a shipped feature. The
feature is real; the attribution was misleading. The comments now say which part shipped and which
part did not.
