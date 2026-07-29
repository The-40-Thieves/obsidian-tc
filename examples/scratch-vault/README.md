# Scratch vault

A tiny, entirely synthetic Obsidian vault for local development — point `examples/config.scratch.json`
at this directory (or `just link-plugin examples/scratch-vault`) instead of ever running obsidian-tc
against your real notes.

Every file here is placeholder content invented for this repository. None of it names, describes, or
resembles any real note, vault, or person — see `scripts/check-vault-leak.mjs`, the gate this fixture
must never trip (THE-421: this public repo has leaked real vault data once already).

If you need more notes to exercise a feature (backlinks, tags, folders), add more placeholder `.md`
files under here rather than pointing the server at anything real.
