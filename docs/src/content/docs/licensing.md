---
title: AGPL and you
description: What the AGPL-3.0 licence actually requires, in plain language — running it locally, serving a modified copy, hosting it for others, and the commercial exception.
---

:::caution
This page is an explanation, not legal advice. Have counsel review before relying on it.
:::

obsidian-tc is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-only —
see [LICENSE](https://github.com/The-40-Thieves/obsidian-tc/blob/main/LICENSE)). This page walks
through what that actually obligates you to do, for the situations people most often ask about.

## What AGPL-3.0 requires, in short

Two separate mechanisms do the work:

- **Conveying** (distributing copies to others — GPLv3 §§4–6, which AGPL-3.0 incorporates):
  if you hand someone a copy of the software, modified or not, you must give them (or offer
  them) the corresponding source, under the same license. This is the ordinary GPL copyleft —
  nothing AGPL-specific about it.
- **§13, Remote Network Interaction** — the clause that makes AGPL different from plain GPLv3.
  Quoting the license text directly:

  > Notwithstanding any other provision of this License, if you modify the Program, your
  > modified version must prominently offer all users interacting with it remotely through a
  > computer network (if your version supports such interaction) an opportunity to receive the
  > Corresponding Source of your version by providing access to the Corresponding Source from a
  > network server at no charge, through some standard or customary means of facilitating
  > copying of software.

  Two things both have to be true before §13 bites: (1) you're running a **modified** version,
  and (2) other people **interact with it remotely over a network**. Neither conveying nor §13
  is triggered by merely running the software for yourself.

Full text: [gnu.org/licenses/agpl-3.0.html](https://www.gnu.org/licenses/agpl-3.0.html). The FSF's
own worked example of §13 in practice: [GPL FAQ — "A company is running a modified version of a
program licensed under the GNU Affero GPL (AGPL) on a web site. Does the AGPL say they must
release their modified sources?"](https://www.gnu.org/licenses/gpl-faq.html#UnreleasedModsAGPL)
(short answer: yes, because that's exactly the case §13 targets).

## Three situations

### (a) Running an unmodified copy locally over stdio, on your own machine

This is the default `obsidian-tc /path/to/vault` setup described throughout the
[Getting Started](/getting-started/install/) docs: the server talks to your MCP client over
**stdio**, a transport this repo's own [auth model](/security/auth-model/) describes as
"trusted-local" precisely because it never leaves the process boundary.

No source-offer duty arises here, on the maintainer's reading (this is a reasoned interpretation
of the license text above, not settled case law, and specifically not legal advice — see the
banner at the top of this page):

- You haven't modified the Program, so §13's own trigger ("if you modify the Program") doesn't
  apply in the first place.
- Nobody is interacting with it "remotely through a computer network" — a single local process
  talking to itself over stdio is not offering network interaction to anyone else.
- No conveying happens either — you haven't handed a copy to another party, so the ordinary
  GPL distribution requirements (§6) don't trigger.

### (b) A modified copy served to remote users over HTTP

This is the case §13 exists for. If you change the source and then run that modified version
with the [Streamable HTTP transport](/getting-started/mcp-clients/#streamable-http) enabled, so
that other people's clients connect to it over the network, you must prominently offer those
users the Corresponding Source of *your modified version* — not just point them at this
project's upstream repo. The FAQ answer quoted above is exactly this scenario.

### (c) A hosted offering for third parties

Running an **unmodified** copy of obsidian-tc as a hosted service for other people (say, an
MCP-as-a-service offering) does not by itself trigger §13's source-offer duty, for the same
reason as (a): §13 only fires when *you* have modified the Program. It doesn't relieve you of
ordinary AGPL obligations if you do modify it while hosting it (that's case (b) again), and it
doesn't change anything about the license terms your own users are bound by if they, in turn,
receive a copy from you.

Either way — hosted unmodified or hosted modified — some organizations find AGPL's terms
incompatible with how they want to operate a hosted offering. That's what the commercial
exception below is for.

## The commercial exception

Quoting [CONTRIBUTING.md](https://github.com/The-40-Thieves/obsidian-tc/blob/main/CONTRIBUTING.md#license-and-sign-off-dco)
directly, since that's the canonical source for this project's own terms:

> obsidian-tc is licensed under [AGPL-3.0-only](https://github.com/The-40-Thieves/obsidian-tc/blob/main/LICENSE).
> A separate commercial-exception license may also be available for organizations that cannot
> meet the AGPL's network-copyleft terms; if that applies to you, open a discussion to ask — the
> terms are decided case by case and are not published here.

To ask: open a
[GitHub discussion](https://github.com/The-40-Thieves/obsidian-tc/discussions). There's no
published price list or standard contract — each case is evaluated on its own facts.

## Common misconceptions

- **"Linking the vault/plugin over MCP makes my notes AGPL."** No. AGPL's copyleft reaches
  modified/conveyed copies of *this software*; it says nothing about the content of your
  Obsidian vault. Your notes stay yours, under whatever terms you already apply to them.
- **"Using the server as a tool makes my agent AGPL."** No. An agent that calls obsidian-tc's
  MCP tools over a network connection is *interacting with a service*, not incorporating or
  conveying a copy of the server's source into the agent itself. AGPL's copyleft attaches to
  copies and modifications of the Program, not to every process that happens to talk to it.
- **"The TC Bridge plugin is under whatever license I assume."** Check for yourself — read
  [`packages/plugin/package.json`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/packages/plugin/package.json).
  As of this writing it declares `"license": "AGPL-3.0-only"`, the same as the rest of the
  repository; there is currently no separate license for the plugin package.

## See also

- [LICENSE](https://github.com/The-40-Thieves/obsidian-tc/blob/main/LICENSE) — the full AGPL-3.0
  text as shipped in this repo.
- [CONTRIBUTING.md § License and Sign-off (DCO)](https://github.com/The-40-Thieves/obsidian-tc/blob/main/CONTRIBUTING.md#license-and-sign-off-dco)
- [gnu.org/licenses/agpl-3.0.html](https://www.gnu.org/licenses/agpl-3.0.html) — the license,
  hosted by the FSF.
- [GPL FAQ § "A company is running a modified version..."](https://www.gnu.org/licenses/gpl-faq.html#UnreleasedModsAGPL)
- [Security → Auth model](/security/auth-model/) — the stdio-vs-HTTP trust boundary referenced
  in situations (a) and (b) above.
