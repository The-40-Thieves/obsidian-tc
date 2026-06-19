---
title: Concepts
description: The core building blocks — vaults, tools, scopes, transports, and the companion plugin.
---

## Vaults

A **vault** is an Obsidian vault directory. obsidian-tc is multi-vault: each entry
in `vaults` has an `id`, a `path`, and optional per-vault settings (bridge URLs,
memory folder, command allowlist). Every tool call targets one vault.

## Tools

The server exposes **103 typed tools across 28 domains** — notes, metadata, links,
search, embeddings, structured formats (Bases, Canvas, periodic notes), plugin
bridges, memory, capture, bulk operations, URI generation, and server admin. Each
tool has a Zod-validated input schema and a structured result. See the
[Tool Reference](/tools/).

## Scopes & scope classes

Every tool declares the scopes it requires (e.g. `read:vault`,
`write:vault/02-projects/**`). Scopes drive both **authorization** (ACLs) and
**rate limiting**: each tool maps to a scope *class* — `read`, `write`, `bulk`,
`execute`, or `admin` — and the class selects a throttle tier.

## Transports

- **stdio** — the trusted local transport; full local scope, no auth.
- **HTTP** — opt-in, for remote agents; gated by signed-JWT auth and ACLs.

## Companion plugin

Bridge tools reach a running Obsidian instance through the companion plugin's Local
REST API. Without it the server still runs; bridge tools degrade gracefully to
`plugin_missing` / `plugin_unreachable`.
