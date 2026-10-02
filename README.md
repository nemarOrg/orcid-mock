# orcid-mock

An ephemeral mock of the Open Researcher and Contributor ID (ORCID) service for tests and continuous integration:
the OAuth 2.0 authorization-code flow, OpenID Connect, and the public record API,
with users defined in a JSON file and all state kept in memory.

Status: the foundation is in progress on the MVP1 epic (#1).
The server starts, loads and validates a users file, serves the admin API (health, reset, users, clients), and answers every other path in the right error shape.
OAuth, OpenID Connect, and the record API arrive in the next phases.
See [`.context/plan.md`](.context/plan.md) for the roadmap and [`.context/research.md`](.context/research.md) for the findings behind it.

## Install and run

One codebase, four ways to run it, in order of how much you control.
All four take the same settings (a users file, `PUBLIC_BASE_URL`, and the admin API), described under [Run it from a checkout](#run-it-from-a-checkout).

### With `bunx`

Bun 1.4 or later is required: the package ships TypeScript and starts with `#!/usr/bin/env bun`, so Node cannot run it.

```bash
bunx @nemarorg/orcid-mock                              # serve the starter users on http://127.0.0.1:9700
bunx @nemarorg/orcid-mock fixture --out users.json     # write the starter users file to edit
bunx @nemarorg/orcid-mock --users users.json           # serve your own file
```

The package also exports `createApp` from `@nemarorg/orcid-mock` and `createMockApp` (a users file in, an app and its store out) from `@nemarorg/orcid-mock/bootstrap`, both portable (Web APIs only, for a Worker or any `fetch` host), `startServer` from `@nemarorg/orcid-mock/server` (Bun only), and the users-file JSON Schema and example as `@nemarorg/orcid-mock/fixtures/users.schema.json` and `.../users.example.json`.

### As a container

```bash
docker run --rm -p 127.0.0.1:9700:9700 \
  -e PUBLIC_BASE_URL=http://localhost:9700 \
  -e USERS_FILE=/fixtures/users.json \
  -v "$PWD/users.json:/fixtures/users.json:ro" \
  ghcr.io/nemarorg/orcid-mock:latest
```

- **Set `PUBLIC_BASE_URL`.**
  Inside a container the default would be `http://127.0.0.1:9700`, which is not an address a caller outside the container can use, and every URL the mock emits (the issuer, redirects, links) is built from it.
  Set it to the address your application uses to reach the mock.
- **Publish the port on loopback** (`-p 127.0.0.1:9700:9700`), as above.
  A bare `-p 9700:9700` listens on every interface of the host, and the admin API behind it has no authentication and returns the fixture passwords.
- Tags: `1.2.3`, `1.2`, `1`, and `latest`; a prerelease such as `1.2.3-rc.1` gets only its exact tag.
  The image is multi-arch (`linux/amd64` and `linux/arm64`), runs as `nonroot` on a distroless base with no shell, and holds one file, `/orcid-mock`.
- The image sets `HOST=0.0.0.0` and `PORT=9700`, since the container's network is the boundary.
  Its health check runs `/orcid-mock health` (there is no `curl`, and no shell for `docker run --health-cmd`), which checks `http://127.0.0.1:$PORT`, so it follows a `PORT` override.
- Without `USERS_FILE` it serves the bundled starter users.
  A mounted users file must be readable by user `nonroot` (uid 65532).
- [`docker-compose.yml`](docker-compose.yml) is a ready example: `docker compose up --wait`.

### As a binary

Each GitHub Release attaches one file per platform and a `SHA256SUMS` file: `orcid-mock-linux-x64`, `orcid-mock-linux-arm64`, `orcid-mock-linux-x64-musl`, `orcid-mock-linux-arm64-musl`, `orcid-mock-darwin-x64`, `orcid-mock-darwin-arm64`, `orcid-mock-windows-x64.exe`, and `orcid-mock-windows-arm64.exe`.
Nothing needs installing to run one; it embeds the Bun runtime and the starter users.

```bash
base=https://github.com/nemarOrg/orcid-mock/releases/latest/download
curl -fsSLO "$base/orcid-mock-linux-x64" -O "$base/SHA256SUMS"
grep ' orcid-mock-linux-x64$' SHA256SUMS | sha256sum -c -     # macOS: shasum -a 256 -c -
chmod +x orcid-mock-linux-x64
./orcid-mock-linux-x64 --users users.json
```

- The `-musl` builds are for Alpine, which needs `apk add libstdc++ libgcc` first.
- A binary does not read `.env` or `bunfig.toml` from the directory it runs in.
- The binaries are not code-signed beyond macOS's ad hoc signature, so a macOS browser download may need `xattr -d com.apple.quarantine <file>`, and Windows SmartScreen may ask once.
- Each release also carries GitHub build provenance attestations, for the binaries and for the image:
  ```bash
  gh attestation verify orcid-mock-linux-x64 --repo nemarOrg/orcid-mock
  gh attestation verify oci://ghcr.io/nemarorg/orcid-mock:1.2.3 --repo nemarOrg/orcid-mock
  ```

### As a GitHub Action

```yaml
steps:
  - uses: actions/checkout@v7
  - uses: nemarOrg/orcid-mock@v1
    with:
      users-file: ci/orcid-users.json   # optional; the bundled starter users when omitted
  - run: bun test                       # ORCID_API_BASE, ORCID_PUB_API_BASE, and ORCID_MOCK_URL are set
```

The step runs the image and waits (up to 60 seconds) for it to report healthy; if it does not, the step prints the container logs and fails.
Then it exports `ORCID_API_BASE`, `ORCID_PUB_API_BASE`, and `ORCID_MOCK_URL` (all the same base URL) to the rest of the job, and sets the same values as step outputs (`orcid-api-base`, `orcid-pub-api-base`, `orcid-mock-url`) along with `container-id`.

| Input | Default | Meaning |
|---|---|---|
| `version` | `1` | Image tag to run: `1`, `1.2`, `1.2.3`, or `latest`. The default is the Action's own major, so `@v1` runs the 1.x line; the release workflow refuses a release whose major differs from it. |
| `users-file` | none | Path in your workspace to a users file, mounted read-only and readable by every user; the starter users when empty. |
| `port` | `9700` | Port published on the runner's loopback interface. |
| `public-base-url` | `http://localhost:<port>` | The URL your application uses to reach the mock; it becomes the issuer and the base of every absolute URL. It must be an `http` or `https` URL with no whitespace or control characters (the Action refuses anything else, since the value is written to `GITHUB_ENV`); trailing slashes are removed. |
| `image` | `ghcr.io/nemarorg/orcid-mock` | Image repository without a tag, for running a locally built image. |

Linux runners only, because the image is a Linux container.
A composite action has no post step, so the container is not stopped by the action: it lives until the job ends, and `docker rm -f "${{ steps.<id>.outputs.container-id }}"` stops it sooner.
Reset between tests with `curl -X POST "$ORCID_MOCK_URL/__admin/reset"`.
The Action needs a published image, so `uses: nemarOrg/orcid-mock@v1` works after the first release, which will be `1.0.0`.

### The Cloudflare Worker entry

`src/worker.ts` and [`wrangler.toml`](wrangler.toml) are a smoke test that the portable layer runs in a real Workers runtime, not a way to host the mock: it serves the starter users from memory, one store per isolate, with nothing durable and no users file.
`PUBLIC_BASE_URL` must be set as a binding (it is never taken from the request), or every request answers 500 saying so.
`bun x wrangler deploy --dry-run --outdir dist/worker` bundles it, and `tests/worker.test.ts` runs that bundle in workerd.
A deployed Worker is reachable from the internet and exposes the unauthenticated admin API, fixture passwords included, so `wrangler.toml` sets `workers_dev = false` and says to put an access gate in front of it before you route it anywhere.
The hosted mode will run the same app inside a Durable Object per tenant.

## Run it from a checkout

Bun only; there is nothing to build.

```bash
bun install
bun run src/main.ts                           # serve the bundled starter users
bun run src/main.ts id -n 3                   # three freshly minted ORCID iDs
bun run src/main.ts fixture --out users.json  # write the starter users file to edit
bun run src/main.ts --users users.json        # serve your own file
```

The server prints exactly one line on stdout once it is listening, and sends its logs (one JSON object per line) to stderr:

```json
{"event":"listening","url":"http://127.0.0.1:9700","port":9700}
```

Each setting comes from an environment variable or a flag; a flag wins, and an empty value counts as unset (`USERS_FILE=` serves the starter).
An invalid value, an unreadable users file, or a users file that fails validation prints the problem on stderr and exits with code 2.

| Variable | Flag | Default | Meaning |
|---|---|---|---|
| `PUBLIC_BASE_URL` | `--base-url` | `http://{host}:{port}` | Absolute `http` or `https` URL, with no query, fragment, or credentials; trailing slashes are stripped and a path prefix is kept. Every absolute URL the mock emits derives from it, never from the `Host` header. |
| `PORT` | `--port` | `9700` | `0` picks a free port; the readiness line reports the one it bound. |
| `HOST` | `--host` | `127.0.0.1` | Interface to bind. The admin API is unauthenticated, so the default is loopback; `0.0.0.0` exposes it, passwords included, to the network, and the container image sets it only because the container's network is the boundary. |
| `USERS_FILE` | `--users` | the bundled starter | Path to a users file. |
| `LOG_LEVEL` | `--log-level` | `info` | `debug`, `info`, `warn`, or `error`. |

When `PUBLIC_BASE_URL` is unset, the base URL is built from the bound address: `http://127.0.0.1:{port}` for the default host, and also for a wildcard host (`0.0.0.0` or `::`).
Inside a container the bound address means nothing to a caller, so set `PUBLIC_BASE_URL` explicitly there.
A path prefix in `PUBLIC_BASE_URL` (`https://example.test/orcid`) is only used to build URLs: the server still routes at the root, so a reverse proxy must strip the prefix before forwarding.

The other commands are `orcid-mock schema [--out FILE]` (the JSON Schema for the users file), `orcid-mock health [--url URL]` (exit code 0 when `{URL}/__admin/health` answers 200 and 1 otherwise, printing nothing on success, for health checks in images without `curl`; without `--url` it checks `http://127.0.0.1:$PORT`, port 9700 when `PORT` is unset), `--version`, and `--help`.

### The users file

[`fixtures/users.example.json`](fixtures/users.example.json) is the bundled starter (regenerate it with `bun run example`), and [`fixtures/users.schema.json`](fixtures/users.schema.json) is the JSON Schema it names in its `$schema` line, so an editor validates and completes as you type.
`orcid-mock fixture` writes the same users with `$schema` pointing at the published schema URL, so the file works wherever you put it.
Field names are ORCID's own in snake_case, and a typo fails with its path.
Leave `orcid` empty and the mock mints a checksum-valid iD in the `0009-9...` block, the same one on every load, and one that does not change when you add other users.
An iD from any block is accepted if its checksum is right, for example `0000-0002-1825-0097`, ORCID's own fictional demo record.
Put-codes you leave out are assigned above the largest one in the file.
The rules a schema cannot express (checksums, duplicate iDs and emails, one primary email, a public or limited email being verified) are checked when the file loads.
[ADR 0003](.context/decisions/0003-fixture-schema-and-id-minting.md) records the reasoning, including the small risk that a minted iD belongs to someone.

### The admin API

No authentication and no CORS in MVP1, and `GET /__admin/users` returns the fixture passwords, so keep the server on loopback.
A request that carries an `Origin` header other than the server's own (the origin of `PUBLIC_BASE_URL`) is refused with `403 {"error":"forbidden_origin"}`: browsers always send `Origin` on a cross-origin request, so a web page cannot reset or rewrite a local mock, while `curl` and test clients, which send none, are unaffected.
Users are read and written in the users-file form, with the minted iD and every put-code filled in, which is how a test learns them.
A body must be JSON with a JSON `Content-Type`; anything else is `400 {"error":"invalid_request"}`, and a body that fails validation is `400 {"error":"invalid_fixture","issues":[{"path","message"}]}`.

| Request | Answer |
|---|---|
| `GET /__admin/health` | `200 {"status":"ok","users":n,"clients":n}` |
| `POST /__admin/reset` | `200`, same body as health; users, clients, and counters return to the loaded file, codes, tokens, and sessions are cleared |
| `GET /__admin/users` | `200`, an array of users |
| `GET /__admin/users/{iD}` | `200` the user, or `404` |
| `POST /__admin/users` | create only; an omitted or empty `orcid` mints one; `201` with the user, or `409 {"error":"conflict"}` if the iD exists |
| `PUT /__admin/users/{iD}` | upsert; the path iD wins and a body `orcid` that differs is `400`; `201` or `200` |
| `DELETE /__admin/users/{iD}` | `204`, or `404` |
| `GET /__admin/clients`, `GET /__admin/clients/{client_id}` | `200` the clients (secret included) in users-file form, or `404` |
| `PUT /__admin/clients/{client_id}` | upsert a client, so an app under test on a random port can register its `redirect_uri`; `201` or `200` |

## Why

ORCID's sandbox is shared, cannot be reset from an API, delivers mail only to one throwaway provider, and needs real accounts,
so nobody can drive a brand-new ORCID sign-up from an automated test.
No open-source project mocks ORCID's identity layer and its record API together:
ORCID retired its own mock in 2012, and the generic OAuth and OpenID Connect mocks would still need the whole ORCID surface built on top.

## What it will do (MVP1)

- The authorization-code flow with an auto-consent page, a `login_as` shortcut for headless drivers, exact `redirect_uri` matching, and an unmodified `state` round trip.
- The token endpoint with ORCID's non-standard response (`orcid` and `name` alongside the access token), refresh tokens, and ORCID's error shapes (`invalid_grant`, `invalid_token`, `invalid_scope`).
- OpenID Connect: discovery document, JWKS, an RS256 ID token whose `sub` is the iD, and userinfo.
- Every public read endpoint of the v3.0 API that is a projection of a user: `record`, `person`, `personal-details`, `email`, `employments`, `educations`, `works` and `works/{put-codes}`, `fundings`, `keywords`, `external-identifiers`, `researcher-urls`, `biography`, `activities`,
  with per-item visibility, verified and primary flags on emails, stable put-codes, the summary-then-detail round trip, `Accept` negotiation with 406, and 400 (error code 9042) above 100 put-codes.
- Checksum-valid iDs (ISO 7064 MOD 11-2) generated for fixtures.
- Ephemeral by construction: `POST /__admin/reset`, `POST /__admin/users`, `GET /__admin/health`, a fixed `PUBLIC_BASE_URL`, one process or one container per job.

## What comes after (MVP2)

Member-API writes for works and employments, the hosted multi-tenant service, XML and other representations, webhooks, rate-limit emulation.

## How it will be used

```yaml
services:
  orcid:
    image: ghcr.io/nemarorg/orcid-mock:1
    ports: ["9700:9700"]
    env:
      PUBLIC_BASE_URL: http://localhost:9700
```

This `ports` line publishes on every interface, which is acceptable only because a hosted runner is a fresh, single-job machine; anywhere else, publish on loopback as above.
The image defines its own health check, `/orcid-mock health`, and a runner waits for a service container's health check before the first step.
An `options: --health-cmd` is not needed, and none could run the real command: Docker runs that form through `/bin/sh`, which the image does not have.
A `services:` container starts before your repository is checked out, so it can serve only the bundled starter users; to serve your own file, use [the Action](#as-a-github-action) after `actions/checkout`.

Point your application at it with the same variables you use for the sandbox
(for NEMAR: `ORCID_API_BASE` and `ORCID_PUB_API_BASE`).

## Releasing

For maintainers.
Nothing is published until a version tag is pushed.
One version, from `package.json`, numbers the npm package, the image, the binaries, and (as its major) the Action.

1. Bump `version` in `package.json` in a pull request and merge it to `main`.
   The first release is `1.0.0`: the Action defaults to the image tag `1`, and the workflow refuses a stable release whose major differs from that default in `action.yml`.
   A prerelease is `1.2.3-rc.1`: it gets only its exact image tag, the `next` tag on npm, a prerelease GitHub Release, and no change to any floating tag.
2. Tag the merge commit and push the tag: `git tag v1.2.3 && git push origin v1.2.3`.
3. The [Release workflow](.github/workflows/release.yml) then works in this order, so that a failure leaves nothing public and a re-run converges:
   it refuses a tag that differs from `package.json` or is not on `main`, runs lint, type checking, and the tests, and checks the npm token (`bun pm whoami`);
   it builds every binary once and runs each on a runner of its kind (Linux x64 and arm64, macOS arm64, Windows x64);
   it builds the image, smoke-tests the amd64 image and runs the arm64 image once, and only then pushes the exact tag `1.2.3`, tests what it pushed, and attests it;
   it publishes `@nemarorg/orcid-mock` to npm, unless that version is already there;
   it creates the GitHub Release if it does not exist and uploads the binaries and `SHA256SUMS` (replacing any earlier upload);
   and last it moves `latest`, `1`, and `1.2`, and the `v1` tag that `uses: nemarOrg/orcid-mock@v1` follows.
4. Floating tags only move forward: each moves only when the released version is the highest stable version in its scope (`latest` against all, `1` against 1.x.y, `1.2` against 1.2.z), so a patch for an old line never takes `latest`.
   An exact image tag is never overwritten: if it already exists and was built from another commit, the workflow stops.
5. After a partial failure, re-run the workflow's failed jobs (or all of them); each step skips what is already done.
6. To rehearse, run the workflow by hand (Actions, Release, Run workflow) with "dry-run" on, from any branch.
   It does every build and check, and does not push the image, publish, create the release, or move a tag.
   A dry run does not use the `release` environment, so it cannot check the npm token, and says so.

### One-time setup, by the repository owner

These are repository and registry settings; no workflow or pull request creates them.

- **npm.**
  The `@nemarorg` scope must exist.
  Create a granular access token ([npm's documentation](https://docs.npmjs.com/about-access-tokens): classic tokens were revoked in November 2025, so a granular token is the only kind) with read and write permission on `@nemarorg/orcid-mock` or the scope, and "Bypass 2FA" checked, because nobody is present to enter a one-time password in a workflow.
  A granular token that can write is capped at 90 days ([GitHub changelog, 5 November 2025](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/)), so put the expiry date in your calendar and replace the secret before it passes; the workflow's `bun pm whoami` check fails the release early, before anything is public, when the token has expired.
  Be aware that npm's documentation says the ability to publish directly with a bypass-2FA token is scheduled for removal in January 2027, in favor of trusted publishing (OpenID Connect) or stage-only tokens, and that trusted publishing needs the npm command line, not `bun publish` ([oven-sh/bun#22423](https://github.com/oven-sh/bun/issues/22423)).
  The publish job will need rework before then; [ADR 0005](.context/decisions/0005-distribution-and-release.md) records this.
- **GitHub environment `release`** (Settings, Environments, New environment).
  Under "Deployment branches and tags", choose "Selected branches and tags" and add a tag rule `v*.*.*`.
  Turn on "Required reviewers" and add yourself, so every real release waits for an approval.
  Under "Environment secrets", add `NPM_TOKEN` with the token (an environment secret, not a repository secret).
  Only the `preflight` and `npm` jobs use the environment, and only on real runs.
- **Tag ruleset** (Settings, Rules, Rulesets, New ruleset, New tag ruleset).
  Name it `release tags`, set enforcement to Active, and target tags matching `v*`.
  Turn on "Restrict creations", "Restrict updates", and "Restrict deletions".
  Add a bypass for the Repository admin role, so you can push release tags, and for the GitHub Actions app, so the last job can move `v1`.
  The ruleset stops anyone else from creating, moving, or deleting a `v*` tag, which the Action (`@v1`) and the release workflow trust.
  Check on the first real release that the `promote` job could push `v1`; if the ruleset blocks it, the app is missing from the bypass list.
- **Package visibility.**
  After the first image push, set the `orcid-mock` package to public in the organization's package settings on GitHub, and confirm it is linked to this repository (the image's `org.opencontainers.image.source` label does that).
  A new package starts private, and neither `docker pull` nor the Action works for anyone else until it is public.

## License

MIT. Copyright The Regents of the University of California.
