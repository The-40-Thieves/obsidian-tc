# Release tag signing

**Status: ENABLED (2026-07-24).** A maintainer key is registered and committed, and
`REQUIRE_SIGNED_TAG` is `"true"` — an unsigned, lightweight, or unlisted-signer `v*` tag now fails
`verify-tag`, and because `build-native` needs that job, nothing downstream runs. This document is
the setup runbook and the record of how it was enabled.

Verified end to end before enforcement was turned on:

| case | exit | outcome |
|---|---|---|
| `v1.11.0`, signed, listed signer | 0 | accepted |
| same tag, signer absent from the allowlist | 1 | rejected — *"No principal matched"* |
| `v1.10.0`, unsigned | 1 | rejected — *"no signature found"* |

> **Fixed 2026-07-24.** `verify-tag` previously gated nothing: no job declared `needs: verify-tag`
> and `build-native` had no `needs:` at all, so it ran in parallel. A failing signature check could
> not stop `publish-npm` from publishing — immutably. One `needs:` edge is what makes the check
> load-bearing rather than decorative.
>
> The same commit added a `github.ref_type != 'tag'` guard, because a `workflow_dispatch` dry run
> targets a *branch*: with the new `needs:` edge in place, enforcing on a branch would have broken
> every dry run the moment `REQUIRE_SIGNED_TAG` flipped — precisely the 8-target rehearsal that has
> to keep working.

## Why the tag specifically

`publish.yml` fires on `push: tags: ['v*']`. That tag is the trigger for the entire release: the
ghcr image build, the npm publishes, the SBOMs and the provenance attestations all hang off it.

Everything downstream is already well attested — Actions pinned to commit SHAs, the gitleaks
scanner pinned by digest, CycloneDX SBOMs per package, `npm publish --provenance`. The trigger
itself is the weakest link in that chain: anyone who can push a `v*` tag starts a release, and
nothing cryptographically binds that tag to a person.

Current state, for the record:

- `v1.11.0` — annotated, **signed** (ed25519, `SHA256:S0ERslg2h7R5xuvz0Z01gBHyXzBZzZNKyAq25Xh3ElY`)
- `v1.10.0` — annotated, **unsigned** (predates this work; would be rejected today)
- `v1.9.1` — a **lightweight** tag (a bare commit ref), so there is not even an object to sign

## One-time setup

*(Done for the current maintainer; kept for the next one, or for a key rotation.)*

**1. Create a signing key.** SSH signing is simpler than GPG here and reuses a key you likely have:

```bash
ssh-keygen -t ed25519 -C "release signing — obsidian-tc" -f ~/.ssh/obsidian_tc_signing
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/obsidian_tc_signing.pub
git config --global tag.gpgSign true
```

**2. Register the key with GitHub** as a *signing* key (Settings → SSH and GPG keys → New SSH key →
Key type: **Signing Key**). An authentication key is not sufficient; GitHub will not show tags as
Verified without a signing-key entry.

**3. Commit the public key** so CI can verify against it:

```bash
printf '%s %s\n' "your-github-email@example.com" "$(cat ~/.ssh/obsidian_tc_signing.pub)" \
  > .github/allowed_signers
```

The format is `<principal> <key-type> <key>` — one line per authorised signer.

**4. Flip the workflow to enforce.** In `.github/workflows/publish.yml`, set
`REQUIRE_SIGNED_TAG: "true"`. Until then the step reports the gap and continues.

Once flipped, an unsigned or lightweight tag fails `verify-tag`, and because `build-native` needs
that job, **nothing downstream runs** — no npm publish, no ghcr push. That is the intended
behaviour: npm versions are immutable, so a release must be refused *before* it starts rather than
half-completed.

## Releasing after setup

```bash
git tag -s v1.11.0 -m "v1.11.0"     # -s = signed; tag.gpgSign true makes this the default
git push origin v1.11.0
```

Verify locally before pushing:

```bash
git -c gpg.ssh.allowedSignersFile=.github/allowed_signers verify-tag v1.11.0
```

## Why enforcement is opt-in rather than immediate

Turning enforcement on before a key exists would fail the next release with no warning. The step
therefore runs in report mode by default: every release run states plainly whether the tag was
signed, so the gap stays visible rather than silent, and flipping `REQUIRE_SIGNED_TAG` is a
one-line change once step 3 is done.

A lightweight tag can never pass verification — it is a bare pointer with no object to carry a
signature. `git tag -s` (or `-a`) is required.

---

## Recovering a partially-failed release (THE-575)

npm versions are immutable, so a release that fails *after* publishing cannot be retried by bumping.
Two changes make it resumable:

* The **F3 preflight classifies** rather than asserts. All target versions unpublished → publish
  normally. **All** published → treated as a RESUMED release: the npm-mutating steps are skipped and
  the pipeline continues. **Some** published → hard failure, because that is either a mid-publish
  death or a tag cut without bumping, and guessing is how a version-skewed half-release gets
  cemented.
* `build-docker`, `build-binaries` and `build-mcpb` **no longer depend on `publish-npm`**. None of
  them consumes an npm-published package — they build from the tag. That dependency was why v1.11.0
  shipped without its image, binaries, bundle and release notes.

To resume: `gh run rerun <run-id>` (a **full** re-run, not `--failed`).

> `actions/download-artifact` fails with `Failed to GetSignedArtifactURL: (404) Not Found: workflow
> run not found` after repeated `gh run rerun --failed` invocations, even when the artifacts exist
> and are unexpired — it resolves them scoped to the run *attempt*. A full re-run rebuilds them in
> the same attempt. This costs a full native-matrix rebuild, which is the price of resumability.

### The promote step is gone (THE-574, resolved)

There is no longer a manual promote. Trusted publishing authorises `npm publish` only, so
`npm dist-tag add` fell back to token auth and failed `EOTP` on **every** release — a structural
incompatibility, not a misconfiguration, and one on a deadline: npm's 2026-07-08 changelog withdraws
package *management* actions from 2FA-bypass tokens first, in early August 2026.

The workflow now publishes straight to the release dist-tag in dependency order with `obsidian-tc`
**last**, which is safe because every inter-package dependency is exact-pinned rather than ranged —
so no install resolves a sub-package by tag, and a sequence that dies partway leaves
`obsidian-tc@latest` on the previous intact release. See *Ordered npm publish* in `RELEASING.md`,
which also records why npm's staged publishing was evaluated and not adopted.

If you ever do need to move a dist-tag by hand, it requires an interactive OTP. Omit `--otp` so npm
prompts for it — passing it on the command line puts the code in shell history, and a stale or
mistyped value fails with an opaque `E400`.
