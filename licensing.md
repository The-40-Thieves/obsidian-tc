---
title: Licensing
description: What the Apache-2.0 licence lets you do with reliquary-tc, what it asks in return, and how the earlier AGPL-3.0 releases fit in.
---

<Warning>
This page is an explanation, not legal advice. Have counsel review before relying on it.
</Warning>

reliquary-tc is licensed under the **Apache License, Version 2.0** (Apache-2.0; see
[LICENSE](https://github.com/The-40-Thieves/reliquary-tc/blob/main/LICENSE) and
[NOTICE](https://github.com/The-40-Thieves/reliquary-tc/blob/main/NOTICE)). It is a permissive
licence: you can run, modify, host and redistribute the software, including in closed-source and
commercial products, without publishing your changes.

## What Apache-2.0 asks of you {#what-apache-20-asks-of-you}

The obligations apply when you **redistribute** the software or a derivative of it (§4). Running it,
including running a modified copy as a hosted service, does not trigger them. When you do
redistribute:

- Give recipients a copy of the licence.
- Mark files you changed with a prominent notice that you changed them.
- Keep the copyright, patent, trademark and attribution notices from the source.
- Pass along the attribution notices in the `NOTICE` file, if your distribution includes one.

The licence also carries an express **patent grant** from each contributor (§3), which ends for
anyone who sues claiming the software infringes a patent. It grants **no trademark rights** (§6):
the project's names and logos are not licensed by it.

Full text: [apache.org/licenses/LICENSE-2.0](https://www.apache.org/licenses/LICENSE-2.0).

## Earlier releases stay AGPL-3.0 {#earlier-releases-stay-agpl-30}

Releases up to and including **1.34.x** were published under the GNU Affero General Public
License v3.0 only (AGPL-3.0-only), and a licence that has been granted cannot be taken back. If
you use one of those releases, its AGPL terms still govern that copy, including §13's duty to
offer source to remote users of a modified version. Upgrading to a release made after the switch
puts you under Apache-2.0.

## Common questions {#common-questions}

- **"Do my vault notes fall under the licence?"** No. The licence covers this software, not the
  content of your Obsidian vault. Your notes stay yours.
- **"Does calling the server from my agent put my agent under Apache-2.0?"** No. An agent that
  calls reliquary-tc's MCP tools is using a service. It does not incorporate the server's source.
- **"What about the TC Bridge plugin?"** It is part of this repository and under the same licence.
  Read [`packages/plugin/package.json`](https://github.com/The-40-Thieves/reliquary-tc/blob/main/packages/plugin/package.json)
  to confirm what the current copy declares.
- **"What do third-party components bundle in?"** Each keeps its own licence. For what may be
  bundled, fetched or user-installed for the inference runtimes and models, see
  [Vendor runtime and model licensing](https://github.com/The-40-Thieves/reliquary-tc/blob/main/docs/VENDOR-RUNTIME-LICENSING.md).

## Contributing {#contributing}

Contributors sign [The 40 Thieves Contributor License Agreement](https://github.com/The-40-Thieves/reliquary-tc/blob/main/CLA.md)
once, and sign off every commit under the Developer Certificate of Origin. The agreement gives the
maintainer a permanent copyright and patent license to each contribution, including the right to
license it under other terms in the future; contributors keep their copyright. This does not change
the Apache-2.0 licence you receive the software under. Details are in
[CONTRIBUTING.md § License and Sign-off (DCO)](https://github.com/The-40-Thieves/reliquary-tc/blob/main/CONTRIBUTING.md#license-and-sign-off-dco).

## See also {#see-also}

- [LICENSE](https://github.com/The-40-Thieves/reliquary-tc/blob/main/LICENSE): the full Apache-2.0
  text as shipped in this repo.
- [NOTICE](https://github.com/The-40-Thieves/reliquary-tc/blob/main/NOTICE): the attribution notice
  that travels with redistributions.
- [Security → Auth model](/security/auth-model/): the stdio-vs-HTTP trust boundary.
