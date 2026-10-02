# Releasing orcid-mock

For maintainers; nothing here is needed to use the mock.
A release is cut by pushing a tag: the [Release workflow](.github/workflows/release.yml) repeats some of the checks that continuous integration (CI) runs on every pull request, and then publishes.
One version, from `package.json`, numbers the npm package, the image, the binaries, the two [test helpers](README.md#test-helpers), and (as its major) the Action.
The reasoning is in Architecture Decision Records (ADRs) [0005](.context/decisions/0005-distribution-and-release.md) and [0008](.context/decisions/0008-client-helpers.md).
The first release is `1.0.0`, and [the owner checklist](#owner-checklist-for-100) lists, in order, everything that has to be done by hand for it.

## Cutting a release

1. Bump `version` in `package.json`, `clients/node/package.json`, and `clients/python/pyproject.toml` to the same string, in a pull request, and merge it to `main`.
   Run `uv lock` in `clients/python` afterwards, since the lockfile records the project's own version: the workflow refuses a stale one (`uv lock --check`).
   The workflow also refuses a tag that differs from any of the three, and the helpers' tests fail until the three agree.
   The Action defaults to the image tag `1`, and the workflow refuses a stable release whose major differs from that default in `action.yml`, so a `2.0.0` needs that default changed first.
   A prerelease is `1.2.3-rc.1`: it gets only its exact image tag, the `next` tag on npm, a prerelease GitHub Release, and no change to any floating tag.
   Write it `-alpha.N`, `-beta.N`, or `-rc.N` and nothing else, because the Python helper needs a form that Python Enhancement Proposal (PEP) 440 can spell (`1.2.3-rc.1` is `1.2.3rc1` on the Python Package Index (PyPI)).
2. Tag the merge commit and push the tag: `git tag v1.2.3 && git push origin v1.2.3`.
3. The Release workflow then works in this order, so that a failure leaves nothing public and a re-run converges:
   it refuses a tag that differs from `package.json` or is not on `main`, runs lint, type checking, and the tests, and checks the npm token (`bun pm whoami`);
   it builds every binary once and runs all eight ([which binaries CI executes](#which-binaries-ci-executes)), and builds the helpers' packages (the Node helper's compiled tarball, the Python helper's wheel and source distribution) in jobs that hold no credentials;
   it builds the image, smoke-tests the amd64 image and runs the arm64 image once, and only then pushes the exact tag `1.2.3`, tests what it pushed, and attests it;
   it publishes `@nemarorg/orcid-mock` and `@nemarorg/orcid-mock-testing` (the tarball the earlier job built) to npm, each unless that version is already there, and `orcid-mock-testing` to PyPI through trusted publishing (the `pypi` job only uploads the files the earlier job built, and skips a file the index already has);
   it creates the GitHub Release if it does not exist and uploads the binaries and `SHA256SUMS` (replacing any earlier upload);
   and last it moves `latest`, `1`, and `1.2`, and the `v1` tag that `uses: nemarOrg/orcid-mock@v1` follows.
4. A real release asks the `release` environment's reviewer twice: before the preflight job (the token check) and before the npm publish, since each job that uses an environment is approved on its own; and it asks the `pypi` environment's reviewers, if it has any, before the PyPI publish.

### Floating tags

Floating tags only move forward: each moves only when the released version is the highest stable version in its scope (`latest` against all, `1` against 1.x.y, `1.2` against 1.2.z), so a patch for an old line never takes `latest`.
An exact image tag is never overwritten: if it already exists and was built from another commit, the workflow stops.

The `v1` tag is the one the Action is used by, and the `promote` job force-pushes it with the workflow's token after each stable release.
The tag ruleset (item 8 of [the checklist](#owner-checklist-for-100)) protects `v*.*.*`, which matches every exact version tag and does not match `v1`, so `promote` can move `v1` and nothing needs to bypass the ruleset.
If `promote` did not move it, or moved it wrongly, set it by hand to the released commit:

```bash
git tag -f v1 <sha> && git push -f origin v1
```

### Re-running a failed release

After a partial failure, re-run the workflow's failed jobs (or all of them); each step skips what is already done.
The build artifacts (the binaries, the Node tarball, the Python wheel and source distribution) are kept for 30 days, and GitHub allows a re-run for the same 30 days after the first run, so a re-run converges within that window.
After it, repair a half-finished release by releasing the next patch version.

### Dry run

To rehearse, run the workflow by hand (Actions, Release, Run workflow) with "dry-run" on.
GitHub offers that button only for a workflow that is on `main`, so a rehearsal is possible once `release.yml` has been merged there; "Use workflow from" picks the branch to rehearse.
A dry run does every build and check, and does not push the image, publish, create the release, or move a tag.
It does not use the `release` or `pypi` environments, so it cannot check the npm token or the trusted publisher, and says so in a notice.

## Which binaries CI executes

All eight binaries are executed on every change to a packaging file and again by the Release workflow before anything is public ([`smoke-binaries.yml`](.github/workflows/smoke-binaries.yml)).
Each is checked against `SHA256SUMS`, asked for its version, and asked to mint an iD:

| Binary | Where it runs |
|---|---|
| `orcid-mock-linux-x64`, `orcid-mock-linux-arm64` | `ubuntu-latest`, `ubuntu-24.04-arm` |
| `orcid-mock-linux-x64-musl`, `orcid-mock-linux-arm64-musl` | an `alpine` container (after `apk add libstdc++ libgcc`) on the same two Linux runners |
| `orcid-mock-darwin-x64` | `macos-15-intel` |
| `orcid-mock-darwin-arm64` | `macos-latest` |
| `orcid-mock-windows-x64.exe`, `orcid-mock-windows-arm64.exe` | `windows-latest`, `windows-11-arm` |

Only the linux x64 binary is also started as a server, asked for its health, and stopped with `SIGTERM` (the `binaries` job in [`ci.yml`](.github/workflows/ci.yml)); the other seven are not served in CI.
A `coverage` job in the same workflow compares the names in `SHA256SUMS` with the smoke matrix and fails when a built binary has no smoke job, so a new target cannot ship without being run.

`macos-15-intel` is the last x86_64 macOS image GitHub offers, and GitHub's announcement ends it in August 2027 ([actions/runner-images#13045](https://github.com/actions/runner-images/issues/13045)).
Before then, remove its matrix entry from `smoke-binaries.yml` and put `orcid-mock-darwin-x64` in the `UNEXECUTED` variable of the `coverage` job, or every release and every packaging change will queue on a runner label that no longer exists.
Add the same fact to [ADR 0005](.context/decisions/0005-distribution-and-release.md), whose amendment already says that nothing can execute the darwin x64 binary in CI after that date.

## Pins

### What Dependabot proposes

Each proposal waits seven days after the release, and each is a pull request to review, not an automatic merge.

- **GitHub Actions:** the full commit hash and the version comment of every `uses:` line in `.github/workflows/`.
- **Bun packages:** the exact dependencies in `package.json` and in `clients/node/package.json`, with their lockfiles.
  That includes `@types/bun`, which must not be merged alone: see the Bun row below.
- **Python packages:** the dependencies of `clients/python` and `uv.lock`.

### What stays manual

Dependabot cannot see these, because they are plain text in files it does not read.
Its Docker updater reads `FROM image:tag` lines, and the Dockerfile takes its two base images from `ARG` defaults, so it proposes nothing for them; writing the images literally in the `FROM` lines would change that.
Prefer a release that is at least seven days old, as the cooldown does, and let CI prove the bump.

| Pin | Where | How to bump |
|---|---|---|
| Base images, with their digests | `Dockerfile`: `BUN_IMAGE` (`oven/bun`) and `RUNTIME_IMAGE` (distroless) | Find the new index digest with `docker buildx imagetools inspect <image>:<tag> --format '{{.Manifest.Digest}}'`, and change the tag and the digest together; the `oven/bun` tag follows the Bun version (next row). |
| BuildKit image (`BUILDKIT_IMAGE`), with its digest | `ci.yml`, `release.yml` | The same, for `moby/buildkit:<tag>`, in both files. |
| QEMU registration image (`BINFMT_IMAGE`), with its digest | `release.yml` | The same, for `tonistiigi/binfmt:<tag>`. |
| Alpine image (`ALPINE_IMAGE`), with its digest | `smoke-binaries.yml` | The same, for `alpine:<tag>`. |
| Bun | `packageManager` and `@types/bun` in `package.json` and in `clients/node/package.json`; the `oven/bun` tag and digest in `Dockerfile` | These five move together, in one pull request: when Dependabot proposes `@types/bun`, add the rest to its branch (or bump all five by hand), then run `bun install` in both directories to refresh the lockfiles. The workflows read the version from `package.json`. |
| `setup-uv` `version` (uv itself) | every `astral-sh/setup-uv` step in `ci.yml` and `release.yml` | Change them all to the same release (`grep -n 'version: "0' .github/workflows/*.yml` finds them), and run `uv lock --check` in `clients/python`. |
| Node | the two `node-version` lines of `actions/setup-node` in `ci.yml` (24 and 22) | Take the newest release of each line from <https://nodejs.org/dist/index.json> that is at least seven days old. The helper's `engines.node` (`>=22`) is the range it supports, not a pin. |
| zizmor | `uvx zizmor@<version>` in `ci.yml`, and the comment in `.github/zizmor.yml` | Change both, run `uvx zizmor@<version> --offline .github/workflows action.yml`, and fix or document any new finding. |

## Owner checklist for 1.0.0

These are repository and registry settings; no workflow or pull request creates them.
Do them in this order.

1. **Merge [pull request #20](https://github.com/nemarOrg/orcid-mock/pull/20) into `main` with a regular merge,** not a squash, so the phase history stays.
2. **Repository hardening** (Settings, Advanced Security and Rules):
   turn on secret scanning and push protection, and turn on private vulnerability reporting, which [`SECURITY.md`](SECURITY.md) tells reporters to use;
   add a branch ruleset on `main` that blocks deletion and force pushes, requires a pull request, and requires the CI jobs `check`, `clients`, `binaries`, `docker`, and `e2e`;
   optionally, under Settings, Actions, General, require actions to be pinned to a full-length commit SHA, which every workflow here already satisfies.
3. **Dry run.**
   Actions, Release, Run workflow, from `main`, with "dry-run" on.
   Expect green, with notices that the npm token and the PyPI trusted publisher were not checked ([Dry run](#dry-run)).
4. **npm.**
   The `@nemarorg` scope must exist.
   Create a granular access token ([npm's documentation](https://docs.npmjs.com/about-access-tokens): classic tokens were revoked in November 2025, so a granular token is the only kind) with read and write permission on `@nemarorg/orcid-mock` and `@nemarorg/orcid-mock-testing`, or on the scope (a package that does not exist yet cannot be named, so a scope-wide token is the simple choice before the first release), and with the two-factor authentication (2FA) bypass ("Bypass 2FA") checked, because nobody is present to enter a one-time password in a workflow.
   A granular token that can write is capped at 90 days ([GitHub changelog, 5 November 2025](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/)), so put the expiry date in your calendar and replace the secret before it passes; the workflow's `bun pm whoami` check fails the release early, before anything is public, when the token has expired.
   Be aware that npm's documentation says the ability to publish directly with a bypass-2FA token is scheduled for removal in January 2027, in favor of trusted publishing (OpenID Connect) or stage-only tokens, and that trusted publishing needs the npm command line, not `bun publish` ([oven-sh/bun#22423](https://github.com/oven-sh/bun/issues/22423)).
   The publish job will need rework before then; [ADR 0005](.context/decisions/0005-distribution-and-release.md) records this.
5. **GitHub environment `release`** (Settings, Environments, New environment), created before any run.
   Under "Deployment branches and tags", choose "Selected branches and tags" and add a tag rule `v*.*.*`.
   Turn on "Required reviewers" and add yourself, so every real release waits for an approval.
   Under "Environment secrets", add `NPM_TOKEN` with the token from item 4 (an environment secret, not a repository secret).
   Only the `preflight` and `npm` jobs use the environment, and only on real runs.
6. **PyPI.**
   The name `orcid-mock-testing` was free on PyPI on 2026-10-01.
   The first release creates the project, through a pending trusted publisher, so create that before tagging: sign in at pypi.org, open Your account, Publishing, and add a pending publisher for the project `orcid-mock-testing` with owner `nemarOrg`, repository `orcid-mock`, workflow `release.yml`, and environment `pypi` ([PyPI's documentation](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/)).
   There is no token to create or rotate; the `pypi` job's OpenID Connect identity is the credential.
   Nothing can check this setup before it is used: a mistyped repository, workflow, or environment name in the pending publisher surfaces only when the `pypi` job runs, which is after the image and the npm packages are public.
   A re-run converges (the image tag, the npm versions, and the files already published are skipped), so the repair is to fix the publisher on pypi.org and re-run the failed job; but check the four values twice before tagging.
   Then create the **GitHub environment `pypi`** (Settings, Environments, New environment) with the same tag rule `v*.*.*`; "Required reviewers" is optional, and it needs no secret.
   The environment's name must match the one in the pending publisher.
7. **Package settings.**
   In the organization's package settings on GitHub, allow public packages, so that the image's package can be made public after its first push (a new package starts private).
8. **Tag ruleset** (Settings, Rules, Rulesets, New ruleset, New tag ruleset).
   Name it `release tags`, set enforcement to Active, and target tags matching `v*.*.*`.
   Turn on "Restrict creations", "Restrict updates", and "Restrict deletions".
   Add the Repository admin role to the bypass list, with bypass mode "Always", so that you can push release tags.
   The floating `v1` tag is outside the pattern on purpose, so the `promote` job can move it ([Floating tags](#floating-tags)).
9. **Optional: the sandbox conformance job.**
   Create the environment `conformance`, restricted to `main`, with the two sandbox secrets and the repository variable described under [Conformance](README.md#against-the-sandbox) (the variable must name a populated sandbox record), then dispatch the Conformance workflow with `job=sandbox`.
10. **Tag `v1.0.0` on the merge commit and push it:** `git switch main && git pull && git tag v1.0.0 && git push origin v1.0.0`.
    Approve the `release` environment twice (before `preflight` and before `npm`), and watch the `pypi` and `promote` jobs.
11. **After the release:**
    - make the `ghcr.io/nemarorg/orcid-mock` package public and confirm it is linked to this repository (the image's `org.opencontainers.image.source` label does that);
    - pull `:1.0.0`, `:1`, and `:latest` anonymously (`docker logout ghcr.io` first);
    - confirm the `v1` tag points at the release commit, and if not, use the manual fallback under [Floating tags](#floating-tags);
    - dispatch Conformance with `job=services-smoke`;
    - run `bunx @nemarorg/orcid-mock@1.0.0 --version`;
    - install `orcid-mock-testing==1.0.0` in a scratch project (`uv init scratch`, then `uv add orcid-mock-testing==1.0.0` inside it);
    - run `gh attestation verify` on a downloaded binary and on the image (`gh attestation verify oci://ghcr.io/nemarorg/orcid-mock:1.0.0 --repo nemarOrg/orcid-mock`);
    - start [#17](https://github.com/nemarOrg/orcid-mock/issues/17), the adoption in nemar-cli.
