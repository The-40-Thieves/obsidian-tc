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

## What is obsidian-tc?

obsidian-tc is a Model Context Protocol server that exposes an Obsidian vault to AI agents through ~123 typed tools, presented via a configurable tool-surface facade (a compact triad of meta-tools by default, or the full surface in flat mode). It runs locally or remotely, supports multi-vault setups, signed-JWT auth, and ships a companion plugin that powers tool-call delivery via the Obsidian Local REST API.

v1.3.6 is the current release, published to npm with a container image on GHCR.

See [Getting Started](/getting-started/install/) for install instructions, or browse the [Tool Reference](/tools/).
