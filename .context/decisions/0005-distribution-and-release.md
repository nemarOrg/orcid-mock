# Architecture Decision Record (ADR) 0005: Distribution and release

**Status:** accepted; amended by [ADR 0008](0008-client-helpers.md), which added the Python Package Index (PyPI) as a channel, published through trusted publishing from a `pypi` environment, and made one version number cover five artifacts
**Date:** 2026-10-01
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0001 promises one codebase that is a local process, a continuous integration (CI) service container, and later a Worker and a hosted service.
Phase 5 turns that into things people can download, and the repository is public, so a tag is a real, mostly irreversible event: an npm version can never be reused, and a registry tag that moved backwards breaks someone's build.
Constraints: Bun only (no npm command line), no `nodejs_compat` (ADR 0002), and a fixture server whose admin API is unauthenticated.

## Decision

**Four channels, one version.**
The npm package `@nemarorg/orcid-mock` (run with `bunx`), the container image `ghcr.io/nemarorg/orcid-mock`, the compiled binaries on the GitHub Release, and the composite Action `nemarOrg/orcid-mock` all carry the version in `package.json`, and a `v<major>` tag follows the Action.
The Action's default image tag is its own major; the release workflow refuses a stable release whose major differs from that default.

**Binaries are cross-compiled once, on Linux, with `bun build --compile`** for linux x64 and arm64 (glibc and musl), macOS x64 and arm64, and Windows x64 and arm64.
They do not autoload `.env` or `bunfig.toml`.
The release builds them once, runs each on a runner of its kind, and uploads those exact files.

**The image is distroless, and the binary checks its own health.**
`gcr.io/distroless/cc-debian12:nonroot` holds only `/orcid-mock`; there is no shell, so `HEALTHCHECK` is exec form and `orcid-mock health` defaults its URL to `http://127.0.0.1:$PORT`.
Both base images are pinned by digest, the build cross-compiles for `TARGETARCH` on the build machine, and the image carries `org.opencontainers.image.revision`.

**Release order puts the irreversible steps last and makes every step idempotent.**
Verify (tag equals version, on `main`, Action default equals major, lint, typecheck, test), then preflight (npm token, binaries, platform smoke runs), then build and smoke-test the image before the first push, push only the exact-version tag, publish to npm unless that version exists, create or update the GitHub Release, and finally move `latest`, `<major>`, `<major>.<minor>`, and `v<major>`.
A floating tag moves only when the released version is the highest stable version in its scope (`latest` against every stable version, `<major>` against its major, `<major>.<minor>` against its minor); a prerelease moves none.
An existing exact image tag is never overwritten: a re-run for the same commit reuses it, and any other commit stops the workflow.
The npm token lives in a `release` environment (tags `v*.*.*` only, a required reviewer), used on real runs only, and a tag ruleset on `v*` protects the tags the Action trusts.

**`bun publish` without npm provenance; attestations instead.**
`bun publish` has no provenance option and cannot do npm trusted publishing (oven-sh/bun#15601, #22423), and the project rule forbids the npm command line.
The image and the binaries carry GitHub build provenance attestations, and the package carries none.

**The Worker entry is a portability smoke test, not a hosted mode.**
`src/worker.ts` serves the starter users from memory in one store per isolate, takes its base URL only from the `PUBLIC_BASE_URL` binding, and is bundled and run in workerd by a test.
The hosted mode, in the second minimum viable product (MVP2), runs the same app inside a Durable Object per tenant.

## Consequences

- A person can run the mock without Bun (binary, container) or without Docker (binary, `bunx`); the cost is a larger set of things to keep green, which CI covers on every change to packaging files and the release workflow covers again before anything is public.
- A failed release leaves the repository releasable: re-running the failed jobs finishes it.
  The first public effect is an image tag for a commit that has passed every check, and the last effects (floating tags) can only move forward.
- The npm path has a deadline.
  npm's documentation says direct publishing with a token that bypasses two-factor authentication is scheduled for removal in January 2027, and trusted publishing needs npm 11.5.1 or later.
  Before then the publish job must change, either by adding the npm command line for that one step (an exception to the Bun-only rule, to be decided then) or by a stage-only token with a manual approval, or by `bun publish` gaining OpenID Connect support.
- The binaries are not code-signed beyond macOS's ad hoc signature; a browser download on macOS may need its quarantine flag cleared.
- A granular npm token lasts at most 90 days, so a token that has expired fails the release at preflight, which is the intended place to find out.
- Repository settings (the `release` environment, the tag ruleset, package visibility) are manual and owned by the owner; [`RELEASING.md`](../../RELEASING.md) lists the exact steps.

## Amendments

- **2026-10-02: all eight binaries are executed.**
  The decision above has the release run each binary on a runner of its kind, which held for four of the eight when it was written.
  The smoke job now executes all eight, each asked for its version and to mint an iD: the two musl builds in `alpine` containers on the Linux runner of the same architecture, the Windows arm64 build on `windows-11-arm`, and the darwin x64 build on `macos-15-intel`.
  Only the linux x64 binary is also started as a server; the other seven are not served in CI.
  `macos-15-intel` is the last x86_64 macOS image GitHub offers, and GitHub ends it in August 2027, after which nothing can execute the darwin x64 binary in CI.
- **2026-10-02: the tag ruleset covers `v*.*.*`, not `v*`.**
  The decision above says a tag ruleset on `v*` protects the tags the Action trusts.
  The ruleset targets `v*.*.*`, which matches every exact version tag (`v1.2.3`, `v1.2.3-rc.1`) and not the floating `v1` tag.
  A ruleset on `v*` would also restrict updates to `v1`, and the `promote` job moves `v1` with a force-push using the workflow's token, so it would block the last step of every release.
  The cost is that anyone with write access can move `v1`; [`RELEASING.md`](../../RELEASING.md) has the manual fallback for setting it.
- **2026-10-02: the build-time runtime download is an accepted risk.**
  `bun build --compile --target` downloads each target's Bun runtime while it builds, over HTTPS, and nothing compares the download with a checksum.
  This happens in two places: the `binaries` job of the release workflow, which holds no credentials, and the image build, because the Dockerfile cross-compiles the linux arm64 binary the same way inside the `image` job, which holds `packages: write`, `id-token: write`, and `attestations: write`.
  The risk is accepted for both: every binary is executed before anything is published, the image is smoke-tested before and after its push, and the attestations tie each published file and the image to the workflow run that built it (they do not prove that the embedded runtime is the one Bun published).
  If that stops being enough, `bun build --compile-executable-path` takes a runtime that the build script has downloaded and checked itself, in place of Bun's own download.

## Alternatives considered

- **Publish with the npm command line and provenance now:** works today, but breaks the Bun-only rule for one step and is not needed until the token deadline.
- **A Node-compatible build of the package:** `bunx` needs Bun, so the package ships TypeScript; a Node build would need a bundling step and a second runtime to test.
- **Alpine or `scratch` instead of distroless:** Alpine adds a shell and a package manager to a fixture server; `scratch` has no libc, and the Bun binary needs glibc and `libgcc`.
- **Moving `latest` on every tag:** simple, but a patch for 1.1 released after 1.2 would take `latest` and `1` backwards.
- **Moving floating tags only for the highest version overall:** safe, but a patch for an older minor would then never reach its own `1.1` tag.
- **One job that builds, pushes, publishes, and releases:** shorter, but a failure after the push would leave a half-published release with no way to tell which parts were done.

## Receipts

- npm access tokens (granular only, bypass two-factor authentication, the January 2027 removal): https://docs.npmjs.com/about-access-tokens
- Classic tokens revoked on 9 December 2025: https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/
- Classic token creation disabled and the 90-day cap on write tokens, 5 November 2025: https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/
- npm trusted publishing (npm 11.5.1 or later): https://docs.npmjs.com/trusted-publishers
- `bun publish` and OpenID Connect or provenance: https://github.com/oven-sh/bun/issues/22423 and https://github.com/oven-sh/bun/issues/15601
- `Dockerfile`, `action.yml`, `scripts/build-binaries.ts`, `scripts/floating-tags.ts`, `src/worker.ts`, and `.github/workflows/release.yml` implement this decision.
