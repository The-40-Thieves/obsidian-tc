# Derived edges are never written back into notes

The engine infers edges between notes that no human linked, from tag co-occurrence, vector
neighbourhood, and model passes. None of them is ever written into a note as a wikilink. We
call this the isnad boundary: provenance runs one way, so authored content can produce derived
state and derived state can never present itself as authored.

Writing inferred links back into the vault would be the cheaper implementation and would make
the edges visible in Obsidian's own graph view, which is why someone will propose it. It is
rejected because the vault is the user's authored record, and a note that cannot be trusted to
contain only what its author wrote stops being usable as evidence for anything, including our
own measurements. Derived edges are rebuildable by definition; authored content is not.
