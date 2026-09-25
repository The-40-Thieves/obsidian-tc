---
title: obsidian-tc
description: A turbocharged Model Context Protocol server for Obsidian.
template: splash
hero:
  tagline: A turbocharged MCP server for Obsidian.
  actions:
    - text: Getting Started
      link: /getting-started/install/
      icon: right-arrow
    - text: GitHub
      link: https://github.com/the-40-thieves/obsidian-tc
      icon: external
      variant: minimal
---

![obsidian-tc quickstart: zero-config boot, search_text, read_note, and a write_note overwrite that requires confirmation](/demo/quickstart-storyboard.svg)

A static storyboard for now — `docs/demo/quickstart.tape` renders the animated version
(`docs/public/demo/quickstart.gif`) once `vhs` is on your PATH.

## What is obsidian-tc?

obsidian-tc is a Model Context Protocol server that exposes an Obsidian vault to AI agents through ~163 typed tools, presented via a configurable tool-surface facade (a compact triad of meta-tools by default, or the full surface in flat mode). It runs locally or remotely, and supports multi-vault setups and signed-JWT auth. An optional companion plugin, TC Bridge, extends it with live-Obsidian features (command-palette dispatch, Templater, Dataview, and more) over the Obsidian Local REST API — the server runs without it, degrading bridge-only tools gracefully.

v1.31.3 is the current release, published to npm with a container image on GHCR.

Memory you write with obsidian-tc is plain Markdown in your own vault, not a vendor-hosted
feature — see [Memory you own](/getting-started/memory-you-own/) for the on-disk shape, the ACL/
audit pipeline every write goes through, and a session-bootstrap recipe.

See [Getting Started](/getting-started/install/) for install instructions, or browse the [Tool Reference](/tools/).
