---
title: Inference gateway
description: Stand up the optional generative tier — reflect synthesis, the challenge red-team, the sleep-time plane — via a self-hosted LiteLLM (or any OpenAI-compatible endpoint).
---

The engine's retrieval never needs an LLM — embeddings, BM25, graph expansion, and
`vault_context` all run locally. The **inference gateway** is the one optional seam
to a *text-generating* model, and everything that writes or judges prose routes
through it by **role**:

| Role | Used by |
| --- | --- |
| `synthesize` | `reflect` (grounded answers with provenance), the sleep-time `plane` consolidation |
| `judge` | the work-episode evaluator (can only *lower* verdicts), citation-inference stage 2, preference extraction |
| `extract` | reserved for extraction pipelines |

**Absence is a supported state.** With no gateway configured, `reflect` returns
recall with `available: false`, `knowledge_challenge` reports unavailable, the
evaluator runs its deterministic rules without the judge layer, and the `plane`
scheduler idles. Nothing else degrades.

## How the engine finds it

Two environment variables — there is deliberately no config-file block, so the
gateway can differ per launcher:

```
OBSIDIAN_TC_GATEWAY_URL=http://127.0.0.1:4000
OBSIDIAN_TC_GATEWAY_TOKEN=<optional bearer, e.g. a LiteLLM virtual key>
```

The engine speaks the OpenAI-compatible chat API to that base URL and requests
**model names equal to the role names** (`extract`, `synthesize`, `judge`). Your
gateway's only job is to answer those three aliases and route them to real models.
The resolved `provider:model` comes back with every response and is stamped into
the attestation of anything the gateway produces (e.g. a persisted reflection's
`source_model`), so model swaps stay auditable.

## Recommended setup: LiteLLM in Docker

One container plus a config file mapping the role aliases. All-local example
(Ollama backend — zero keys, nothing leaves the machine):

```yaml
# litellm-config.yaml
model_list:
  - model_name: extract
    litellm_params: { model: "ollama/qwen2.5:7b-instruct", api_base: "http://host.docker.internal:11434" }
  - model_name: judge
    litellm_params: { model: "ollama/qwen2.5:7b-instruct", api_base: "http://host.docker.internal:11434" }
  - model_name: synthesize
    litellm_params: { model: "ollama/qwen2.5:7b-instruct", api_base: "http://host.docker.internal:11434" }
litellm_settings:
  drop_params: true
```

```sh
docker run -d --name litellm-gateway --restart unless-stopped \
  -p 127.0.0.1:4000:4000 \
  -v /absolute/path/litellm-config.yaml:/app/config.yaml \
  ghcr.io/berriai/litellm:main-latest --config /app/config.yaml --port 4000
```

Then set `OBSIDIAN_TC_GATEWAY_URL=http://127.0.0.1:4000` in your MCP client's
server entry (the `env` block) and restart the client.

Deployment notes, learned the hard way:

- **Pin the image.** LiteLLM's PyPI channel was compromised in early 2026; the
  container channel is the safe distribution, but pin a digest
  (`ghcr.io/berriai/litellm@sha256:…` from `docker image inspect`) rather than a
  floating tag, and keep the container free of credentials it doesn't need — an
  all-local config holds **zero keys**, which makes the supply-chain blast radius
  zero.
- **Bind loopback-only** (`-p 127.0.0.1:4000:4000`) unless you add a master key.
- On Windows git-bash, prefix `docker run` with `MSYS_NO_PATHCONV=1` or the
  container-side `/app/...` paths get mangled into Windows paths.

### Verify

```sh
curl -s http://127.0.0.1:4000/v1/models        # → extract, judge, synthesize
```

Then call the `reflect` tool with any query: a working gateway returns a grounded
`synthesis` with chunk provenance; a missing/broken one returns sources with
`available: false` (that distinction is your health check).

## Choosing models per role

The role→model map is a policy decision, and the yaml is the whole switch —
obsidian-tc never changes:

- **All-local** (above): private, free, offline. Trade-off: a 7B-class
  `synthesize` produces grounded but imperfect prose — treat syntheses as drafts
  and verify against the returned sources. The engine is designed for weak
  judges: the evaluator's judge can only lower eligibility verdicts, and a parse
  failure disables that layer rather than corrupting anything.
- **Hybrid**: point `synthesize` at a hosted model
  (`model: "anthropic/claude-sonnet-5"` + the API key in the **container's** env)
  and keep `judge`/`extract` local. Best quality where it shows most — but
  retrieved vault content leaves the machine on synthesis calls. That is a privacy
  boundary; cross it deliberately.
- Any OpenAI-compatible endpoint works in place of LiteLLM if it can serve the
  three aliases (including Ollama directly, using model aliases created via
  Modelfiles).

## What wakes up

With the gateway live: `reflect` synthesis and `mode: "challenge"`,
`knowledge_challenge` (red-team against decision history), the 4-hour `plane`
sleep-time consolidation, the episode evaluator's judge layer, gateway-gated
preference extraction, and citation-inference stage 2. The sleep-time half also
runs offline via `obsidian-tc reflect` (CLI), which gates on the same env vars.
