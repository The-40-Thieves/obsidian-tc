# Release tag signing

**Status: wired, awaiting a key.** The CI verification step now *gates* the release — `build-native`
declares `needs: verify-tag`, and every other job chains from it — but it still runs in report mode
until a maintainer public key is committed. This document is the setup runbook.

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

- `v1.10.0` — annotated, **unsigned**
- `v1.9.1` — a **lightweight** tag (a bare commit ref), so there is not even an object to sign

## One-time setup

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
