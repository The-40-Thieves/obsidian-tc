# obsidian-tc

The converged memory engine for Obsidian vaults: vault read/write, retrieval, and an
experiential work-memory tier, exposed to agents as a governed MCP capability surface.

This glossary is the project's canonical vocabulary. It is not a spec and carries no
implementation detail. See `docs/adr/` for decisions and `ARCHITECTURE.md` for how any of it
is built.

## Content

**Vault**:
An Obsidian vault directory registered with the server. The unit of isolation: every stored
row, edge, and index entry belongs to exactly one.
_Avoid_: workspace, library, corpus (a corpus is a measurement artifact, see below)

**Note**:
A single markdown file inside a vault, addressed by its vault-relative path.
_Avoid_: document, page, file, entry

**Chunk**:
A bounded span of one note, and the unit that is embedded, indexed, retrieved, and ranked.
Nothing smaller is addressable by retrieval.
_Avoid_: passage, segment, fragment, snippet

**Authored**:
Content a human wrote into the vault. Authored state is owned by Obsidian and is never
mutated by the engine as a side effect of retrieval.
_Avoid_: source, original, user data

**Derived**:
Anything the engine computes from authored content and could rebuild from scratch after
deletion. The authored/derived split is the load-bearing distinction in the whole system.
_Avoid_: generated, cached, computed

**Hub note**:
A note whose link degree is high enough that traversing through it carries no topical
signal. Hubs are excluded from edge creation and lose expansion priority.
_Avoid_: index note, MOC, super-node

## Graph

**Edge**:
A directed relation between two notes in the vault graph.
_Avoid_: link (a link is the wikilink a human typed; an edge is the engine's record of it),
relation, connection

**Literal edge**:
An edge that exists because a human wrote a wikilink. The authored layer of the graph.
_Avoid_: real edge, hard edge, explicit link

**Derived edge**:
An edge the engine inferred, on its own edge kind, from tag co-occurrence, vector
neighbourhood, or a model pass. Reconciled full-state per kind so it can never contaminate
the literal layer.
_Avoid_: soft link, inferred link, virtual edge

**Densification**:
Adding derived edges so that multi-hop queries can traverse between notes a human never
linked.
_Avoid_: graph enrichment, edge expansion, link prediction

**Isnad boundary**:
The rule that derived edges are never written back into notes as wikilinks. Provenance runs
one way: authored content can produce derived state, derived state can never masquerade as
authored.
_Avoid_: write-back rule, no-mutation rule

## Retrieval

**Stream**:
One candidate generator feeding the retrieval pipeline (dense, lexical, graph, temporal).
Streams produce ranked candidates independently and are only reconciled at fusion.
_Avoid_: retriever, channel, source, leg

**Fusion**:
Combining several streams' ranked candidates into one ordering. Reciprocal rank is the
default basis; score-space combination is a separate, non-default mode.
_Avoid_: rank fusion, merging, blending, ensembling

**Query specificity**:
A per-query signal for how rare the query's terms are in the corpus, used to weight the
lexical stream against the dense stream. Rare terms favour lexical, common vocabulary
favours dense.
_Avoid_: query difficulty, IDF score, rarity

**Enrichment**:
Prefixing a chunk's indexed text with its note title and heading breadcrumb before embedding
or lexical indexing, so a chunk carries where it came from.
_Avoid_: contextualization, augmentation, decoration

**Hypothetical answer**:
A caller-supplied draft answer used to seed the dense query vector instead of the raw query.
Supplied by the client, never generated server-side. Known in the literature as HyDE.
_Avoid_: HyDE (in code and tickets; acceptable only as a literature citation), synthetic
query, query expansion

**Representation**:
The full set of choices that determine what a stored vector means: model, dimensions,
distance metric, chunker, enrichment, index shape. A change to any of them invalidates every
stored vector.
_Avoid_: embedding config, vector schema, model settings

**Generation**:
A vault's monotonic version counter, incremented inside the transaction of every mutation
that could change query results. Half of a cache key.
_Avoid_: version, revision, epoch, sequence number

**ACL fingerprint**:
A stable digest of a caller's effective access rules. The other half of a cache key, and
what makes a cached bundle safe to serve only back to callers who could have produced it.
_Avoid_: permission hash, caller key, identity hash

**Prewarm bundle**:
A composed session-bootstrap result written ahead of the request that will read it. Carries
its own expiry and content hash, both enforced by the reader.
_Avoid_: prefetch cache, warm cache, preload

**Dark**:
Shipped, tested, reachable, and default-off, because it lost its measured comparison. A dark
mechanism keeps its numbers on the record instead of being deleted or quietly enabled.
_Avoid_: disabled, experimental, feature-flagged, WIP

**Golden set**:
The pinned, versioned query set with judged relevance that every retrieval change is
measured against. Assert its parsed length before trusting a run.
_Avoid_: eval set, benchmark, test queries, corpus

## Work memory

**Membrane**:
The isolation boundary around low-trust captured state. There are no references across it;
authored and experiential material meet only when a query composes them.
_Avoid_: sandbox, quarantine, partition

**Episode**:
One captured record of an agent's dispatch and its outcome. The atom of the experiential
tier.
_Avoid_: event, trace, interaction, log entry

**Eligibility**:
An episode's readiness to be read back. Episodes are born unpromoted, are raised only by
deterministic rules, and can be lowered but never raised by a model.
_Avoid_: status, approval, validation state

**Trust**:
A score on the channel an episode arrived through, floored at read time. Distinct from
eligibility: trust is about provenance, eligibility is about content.
_Avoid_: confidence, reliability, quality score

**Preference profile**:
A versioned record of a caller's inferred preferences, updated only by typed deltas that add,
strengthen, weaken, or retract. Never regenerated wholesale.
_Avoid_: user model, memory profile, settings

**Retrieval log**:
The append-only record of what was served for which query, later stamped with whether the
caller rated it and whether the response cited it. Access statistics are views over this log,
never columns mutated on authored state.
_Avoid_: analytics, usage data, telemetry

**Forget**:
Propagating deletion across every tier that derived something from the deleted material, with
the erasure itself recorded in a hash-chained log.
_Avoid_: delete, purge, unlearn, remove

**Reflect**:
Recall followed by synthesis with source provenance. The third retrieval verb alongside
search and context.
_Avoid_: summarize, synthesize, ask

## Governance

**Capability**:
A governed unit of the tool surface. Every capability declares its access scope, whether it
is destructive, and how it is rate limited, and every call is evaluated against those
declarations before it runs.
_Avoid_: tool (acceptable when speaking MCP protocol), endpoint, command, function

**Scope**:
The access class a capability requires: read, write, delete, bulk, execute, or admin.
_Avoid_: permission, role, grant, capability level

**Dispatch pipeline**:
The fixed order in which a call is checked before its implementation runs: transport, lookup,
auth, ACL, policy, handler, observability. Nothing skips a layer.
_Avoid_: middleware chain, request pipeline, interceptors

**HITL gate**:
The check that stops a call which crosses a human-in-the-loop floor and returns a token the
caller must present to proceed. The token is bound to the exact arguments it was issued for.
_Avoid_: confirmation, approval prompt, consent check

**Kill switch**:
The vault-level setting that denies every mutating capability regardless of any other rule.
_Avoid_: read-only flag, lockdown, freeze

**Facade**:
The mode that shapes which capabilities the surface advertises. Advertising is separate from
reachability: an unadvertised capability is still callable by name.
_Avoid_: tool filter, visibility mode, profile
