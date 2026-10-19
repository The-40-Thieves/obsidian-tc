---
title: Render
description: Deploy obsidian-tc on Render from a Blueprint, with a persistent disk, generated secrets and a health check.
---

:::caution
These templates need obsidian-tc v1.34.0 or later. Until v1.34.0 is published, `:latest` is v1.33.1, which has no health route (`/healthz`) and does not read the environment settings the template relies on, so the deploy will not become healthy. Once v1.34.0 is out, `:latest` works; pin the exact version for production.
:::

The repository's `render.yaml` is a Render Blueprint. It creates one web service from the published
image `ghcr.io/the-40-thieves/obsidian-tc:latest` with a persistent disk at `/data`. The image's
ENTRYPOINT boots the server from `OBSIDIAN_TC_CONFIG`, and the server serves HTTP on the port Render
injects as `PORT`. Nothing here needs a shell on the host, but the config file must be written to
the disk before the first boot (see [Config file](#config-file)).

The Blueprint uses the image rather than building the repository's `Dockerfile`, so the release that
CI tested is the one that runs, and Render runs no build.

## What the Blueprint creates

| Item | Value | Why |
| --- | --- | --- |
| Service type | `web`, `runtime: image` | Pulls the published image. |
| Plan | `1c-2g` (Standard, 2 GB) | A persistent disk needs a paid plan. Starter (`0.5c-512mb`, 512 MB) is below the roughly 430 MB idle footprint plus indexing peaks. |
| Disk | `obsidian-tc-data`, mounted at `/data`, 10 GB | The vault, the cache and the config file live here. The disk can be grown later but not shrunk. |
| Health check | `healthCheckPath: /healthz` | Liveness only. See [Railway](/deployment/railway/#environment-variables) for why `allowedHosts` must include the public host. |
| `OBSIDIAN_TC_CONFIG` | `/data/config.json` | The config file on the disk. |
| `OBSIDIAN_TC_VAULT_PATH` | `/data/vault` | The vault, on the disk. |
| `OBSIDIAN_TC_CACHE_DIR` | `/data/cache` | The cache, on the disk. |
| `OBSIDIAN_TC_PUBLIC_URL` | prompted | The public origin. See [Public URL](#public-url-and-custom-domain). |
| `OBSIDIAN_TC_AS_SETUP_TOKEN` | generated | Claims the bundled authorization server once. See [First-run claim](#first-run-claim). |
| `OPENAI_API_KEY` | prompted, blank by default | Only for an embeddings config that names the `openai` provider. See [Embeddings](/configuration/embeddings/). |

Render also injects `PORT`, which the server reads as described in
[Environment variables](/deployment/railway/#environment-variables). The variable table there applies
here unchanged.

## Cost

Render bills a web service by its plan and the disk by its size. As listed on
[Render's pricing page](https://render.com/pricing) on 2026-10-19:

| item | price |
|---|---|
| Standard instance (`1c-2g`, 1 CPU, 2 GB) | $25 per month |
| Persistent disk | $0.25 per GB per month (the Blueprint's 10 GB: $2.50 per month) |

That is about $27.50 per month for the Blueprint as written. Prices change, so check the pricing page
and the plan in the Blueprint review before you create the service.

## Create the service

1. Click **Deploy to Render** in the repository README, or open
   `https://render.com/deploy?repo=https://github.com/The-40-Thieves/obsidian-tc`.
2. Review the service, the plan and the disk, then enter the values Render prompts for:
   `OBSIDIAN_TC_PUBLIC_URL`, and `OPENAI_API_KEY` if you use the `openai` embeddings provider.
3. Render generates `OBSIDIAN_TC_AS_SETUP_TOKEN`. Copy it from the service's environment page now,
   because you need it for the first-run claim.
4. Before the first boot succeeds, write the config file to the disk. The disk is empty until then.
   `OBSIDIAN_TC_CONFIG` names this file, so it must exist before the server can be configured from
   it. Use the same starting
   point as [Railway's config file](/deployment/railway/#config-file), with the paths above:
   `/data/vault` for the vault and `/data/cache` for the cache. Set `transports.http.host` to
   `0.0.0.0` and `transports.stdio` to `false`, as on Railway.

## Public URL and custom domain

`OBSIDIAN_TC_PUBLIC_URL` must be `https://host` or `https://host:port`, with no path, query or
credentials. Render gives each service a `https://<name>.onrender.com` address; set the variable to
that origin, or to your own domain once it is attached in the Render dashboard. The value sets
`auth.resource` (the origin plus `/mcp`) and is added to `allowedHosts`, so a custom domain must be
attached and resolve before clients connect. Change the variable and redeploy after any change of
domain.

## First-run claim

With `auth.as` enabled in the config file, claim the operator account once: open
`<public URL>/oauth/setup` and enter `OBSIDIAN_TC_AS_SETUP_TOKEN`. Then remove the variable from the
service's environment. The setup token is for the one claim; leaving it set makes the server warn at
every boot. The full authorization-server flow is in
[Authentication](/deployment/railway/#authentication), which applies unchanged.

## Vault source

The vault on the disk is the only copy the server reads. Seeding it from a laptop is not part of the
Blueprint. To keep the vault in step with a Git repository, use the `-git` image and the variables
in [Git-backed vault](/deployment/railway/#git-backed-vault--git-image). Those tags are first
published with the next release, so the `-git` image is not yet available for the Blueprint's
`image.url`.

## Limits of a disk

A service with a persistent disk runs as a single instance, cannot scale to several instances, and
its deploys are not zero-downtime. Render also refuses some mount paths, such as `/`, so keep the
mount at `/data`.

## What this does not do yet

- **Not yet verified on a live Render service.** The Blueprint fields were checked against Render's
  documentation, not by creating a service. A live deploy check is still needed.
- **The config file is not created for you.** The Blueprint ships no template, as Railway does not.
