# orcid-mock

An ephemeral mock of the Open Researcher and Contributor ID (ORCID) service for tests and continuous integration (CI):
the OAuth 2.0 authorization-code flow, OpenID Connect, and the public record API,
with users defined in a JSON file and all state kept in memory.

Status: the first minimum viable product (MVP1) is complete ([epic #1](https://github.com/nemarOrg/orcid-mock/issues/1)); releases are listed on the [GitHub Releases](https://github.com/nemarOrg/orcid-mock/releases) page.
See [`.context/plan.md`](.context/plan.md) for the roadmap and [`.context/research.md`](.context/research.md) for the findings behind it.

## Contents

- [Quick start](#quick-start)
- [What it does](#what-it-does) and [Why](#why)
- [Install and run](#install-and-run): `bunx`, a container, a binary, a GitHub Action, a `services:` container, and the Cloudflare Worker entry
- [Run it from a checkout](#run-it-from-a-checkout): the settings, the users file, and the admin API
- [Test helpers](#test-helpers) for Node and Python
- [OAuth](#oauth), [OpenID Connect](#openid-connect), and the [Record API](#record-api)
- [Conformance](#conformance): one suite against the mock and ORCID's sandbox
- [What comes after MVP1](#what-comes-after-mvp1), [Contributing](#contributing), and [License](#license)

## Quick start

Run the mock with its starter users, from the npm package or from a checkout of this repository (both need Bun 1.4 or later):

```bash
bunx @nemarorg/orcid-mock                  # from the package
bun install && bun run src/main.ts         # or from a checkout
```

It listens on `http://127.0.0.1:9700` and prints one line on stdout when it is ready.
From another terminal, check that it is up:

```bash
curl -s http://127.0.0.1:9700/__admin/health
# {"status":"ok","users":3,"clients":2}
```

Then sign in as a user with no browser, in three commands.
`login_as` skips the sign-in page, so the redirect's `Location` header carries the code, and the code is exchanged for tokens ([the same round trip, explained](#a-headless-round-trip)):

```bash
BASE=http://127.0.0.1:9700
ORCID=$(curl -s $BASE/__admin/users | grep -o '"orcid":"[^"]*"' | head -1 | cut -d'"' -f4)
CODE=$(curl -si "$BASE/oauth/authorize?client_id=APP-ORCIDMOCK000001&response_type=code&scope=/authenticate&redirect_uri=http://localhost:3000/callback&login_as=$ORCID" | sed -n 's/^[Ll]ocation:.*[?&]code=\([0-9A-Za-z]*\).*/\1/p')
curl -s -X POST $BASE/oauth/token -d grant_type=authorization_code -d code=$CODE -d client_id=APP-ORCIDMOCK000001 -d client_secret=orcid-mock-secret --data-urlencode redirect_uri=http://localhost:3000/callback
# {"access_token":"82b915f4-...","token_type":"bearer","refresh_token":"d6e12d69-...","expires_in":631138518,"scope":"/authenticate","name":"A. Fennimore","orcid":"0009-9814-3544-3504"}
```

A test does the same with one call, `signIn`, from the [Node and Python helpers](#test-helpers).
A container, a binary, and a GitHub Action run the same server: see [Install and run](#install-and-run).

## What it does

- The authorization-code flow with a sign-in page that lists the fixture users, a `login_as` shortcut for headless drivers, ORCID's redirect matching, and an unmodified `state` round trip ([OAuth](#oauth)).
- The token endpoint with ORCID's non-standard response (`orcid` and `name` alongside the access token), refresh and client-credentials grants, revocation, and ORCID's error bodies, status codes, and key order.
- OpenID Connect: a discovery document byte-identical to ORCID's apart from the base URL, the JSON Web Key Set (JWKS), an RS256 (RSA with SHA-256) identity (ID) token whose `sub` is the iD, and userinfo ([OpenID Connect](#openid-connect)).
- The public v3.0 record reads, projected from the users file with ORCID's wire shapes, per-item visibility, grouping and ordering, `Accept` negotiation, record states, and error codes ([Record API](#record-api)).
  Search, Extensible Markup Language (XML), and the summary and citation variants are not served.
- Checksum-valid iDs (ISO/IEC 7064 MOD 11-2) minted for fixtures, and an admin API to reset the server, add, replace, and remove users, register clients, and move the clock.
- Five ways to run it (`bunx`, a container, a binary, a GitHub Action, a `services:` container) and client helpers for Node (Testcontainers, Playwright) and Python (Testcontainers, pytest) ([Install and run](#install-and-run), [Test helpers](#test-helpers)).
- A [conformance suite](#conformance) that holds the mock to ORCID's sandbox and drives a brand-new sign-up end to end in CI, with no browser.

## Why

ORCID's sandbox is shared, cannot be reset from an API, delivers mail only to one throwaway provider, and needs real accounts,
so nobody can drive a brand-new ORCID sign-up from an automated test.
No open-source project mocks ORCID's identity layer and its record API together:
ORCID retired its own mock in 2012, and the generic OAuth and OpenID Connect mocks would still need the whole ORCID surface built on top.
It was built first for the Neuroelectromagnetic Data Archive and Tools Resource (NEMAR), whose command-line sign-in goes through ORCID, and it is meant for anyone with the same problem.

## Install and run

One codebase runs as a `bunx` command, a container, a binary, a GitHub Action, and a `services:` container;
a sixth section describes the Cloudflare Worker entry, which is a portability check and not a way to host the mock.
All of them take the same settings (a users file, `PUBLIC_BASE_URL`, and the admin API), described under [Run it from a checkout](#run-it-from-a-checkout).

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
  ghcr.io/nemarorg/orcid-mock:1
```

- **Set `PUBLIC_BASE_URL`.**
  Inside a container the default would be `http://127.0.0.1:9700`, which is not an address a caller outside the container can use, and every URL the mock emits (the issuer, redirects, links) is built from it.
  Set it to the address your application uses to reach the mock.
- **Publish the port on loopback** (`-p 127.0.0.1:9700:9700`), as above.
  A bare `-p 9700:9700` listens on every interface of the host, and the admin API behind it has no authentication:
  it returns every user in the file and every client secret, and lets anyone who can reach it reset or rewrite all state.
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
The Action runs the published image, so the runner must be able to reach `ghcr.io`.

### As a `services:` container

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

Point your application at it with the same variables you use for the sandbox (for NEMAR: `ORCID_API_BASE` and `ORCID_PUB_API_BASE`).

### The Cloudflare Worker entry

`src/worker.ts` and [`wrangler.toml`](wrangler.toml) are a smoke test that the portable layer runs in a real Workers runtime, not a way to host the mock: it serves the starter users from memory, one store per isolate, with nothing durable and no users file.
`PUBLIC_BASE_URL` must be set as a binding (it is never taken from the request), or every request answers 500 saying so.
`bun x wrangler deploy --dry-run --outdir dist/worker` bundles it, and `tests/worker.test.ts` runs that bundle in workerd.
A deployed Worker is reachable from the internet and exposes the unauthenticated admin API (every fixture user and client secret, and a reset or rewrite of all state), so `wrangler.toml` sets `workers_dev = false` and says to put an access gate in front of it before you route it anywhere.
The planned hosted mode runs the same app inside a Durable Object per tenant.

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
| `HOST` | `--host` | `127.0.0.1` | Interface to bind. The admin API is unauthenticated, so the default is loopback; `0.0.0.0` exposes it to the network, and the container image sets it only because the container's network is the boundary. |
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
The Architecture Decision Record (ADR) [0003](.context/decisions/0003-fixture-schema-and-id-minting.md) records the reasoning, including the small risk that a minted iD belongs to someone.

### The admin API

No authentication and no cross-origin resource sharing (CORS) in MVP1, so keep the server on loopback:
anyone who can reach it can read every user and client secret and reset or rewrite all state.
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
| `POST /__admin/clock` | body `{"advance_seconds": n}` with a finite, non-negative `n`; moves the server's clock forward, so codes, tokens, and sessions expire without sleeping; `200 {"offset_ms": n}` is the new total offset; `reset` zeroes it |

## Test helpers

Helpers for tests that need a mock ORCID: a typed client for the admin API and the headless sign-in, a Testcontainers module that starts the image on a port it picks, Playwright fixtures, and a pytest plugin.
They are separate packages in this repository, [`clients/node`](clients/node) (`@nemarorg/orcid-mock-testing` on npm) and [`clients/python`](clients/python) (`orcid-mock-testing` on the Python Package Index (PyPI), imported as `orcid_mock`), and carry the server's version, so the default image of a helper is the image of its own version ([ADR 0008](.context/decisions/0008-client-helpers.md)).

### The rules every helper follows

- **`ORCID_MOCK_URL`.**
  When it is set (the [GitHub Action](#as-a-github-action) sets it), the Playwright fixtures, `startOrConnect`, and the pytest fixtures use that running instance, start nothing, and never stop it.
  Handing them a users file is an error then, because a running instance's users cannot be set from outside: load them where it starts.
  The container classes themselves (`OrcidMockContainer`) always start a container.
- **`ORCID_MOCK_IMAGE`.**
  Otherwise a helper starts a container from this image, and the default is `ghcr.io/nemarorg/orcid-mock:<the helper's version>`.
  An explicit option (a constructor argument, `withImage`, `--orcid-mock-image`) wins over the variable, which wins over the default.
- **Starting a container.**
  The helper picks a free host port, binds the container's port 9700 to it on `127.0.0.1` only, and starts the image with `PUBLIC_BASE_URL=http://localhost:<port>` and `HOST=0.0.0.0`, because the mock never derives its address from the request.
  It waits for the readiness line on stdout, then for the published port to answer, and copies a users file into the container (mode 0644, so the file's own permissions do not matter).
  If the start fails, the error carries the tail of the container's output, which is where the server says why it exited.
  The Docker daemon must be on the machine that runs the tests.
- **Users files.**
  A path is read when you pass it (`withUsers` in Node, `with_users` and the constructor in Python), so a missing file fails there with an `OrcidMockStartError` naming it, and a second call replaces the first file.
- **Proxies.**
  A proxy named by `HTTP_PROXY` or `ALL_PROXY` must not capture the traffic to a mock on this machine, so the clients ignore those variables: the Python client sets `trust_env=False`, and the Node client talks through `node:http` with an agent of its own, because Bun's `fetch` sends even a request to localhost through `HTTP_PROXY` (checked on Bun 1.4.2) and Node's does when `NODE_USE_ENV_PROXY` is set.
  Your own code is not covered: an application under test that reaches the mock through a proxy needs `NO_PROXY=localhost`.
- **Reset.**
  `reset()` restores the loaded file: users, clients, counters, and the clock, and clears codes, tokens, and sessions.
  A client registered with `putClient` is dropped too, so register it again after a reset.
- **Sign-in.**
  `signIn` is the headless sequence of [the round trip below](#a-headless-round-trip): `GET /oauth/authorize` with `login_as` without following the redirect, the code from `Location`, then `POST /oauth/token`.
  By default it uses the starter file's public client and `/authenticate`; any non-2xx answer is an `OrcidMockError` carrying the status and body, and a redirect that carries no code (an `error` fragment) is one with status 0.

### Testcontainers for Node

The package ships compiled JavaScript (ES modules) with declarations, so it loads under Node 22 or later and under Bun 1.4 or later.
`testcontainers` and `@playwright/test` are optional peer dependencies, each needed only by the entry point that uses it.

```bash
bun add -d @nemarorg/orcid-mock-testing testcontainers
```

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  OrcidMockContainer,
  type StartedOrcidMockContainer,
} from "@nemarorg/orcid-mock-testing/testcontainers";

let mock: StartedOrcidMockContainer;

beforeAll(async () => {
  mock = await new OrcidMockContainer()
    .withUsers("fixtures/users.json") // optional: the starter users otherwise
    .start();
}, 120_000);
afterAll(() => mock.stop());
beforeEach(() => mock.client.reset());

test("a user can sign in", async () => {
  const alder = (await mock.client.users())[0];
  if (!alder) throw new Error("the starter file has users");
  const token = await mock.client.signIn({ orcid: alder.orcid });
  expect(token.orcid).toBe(alder.orcid);
  // Point the application under test at mock.baseUrl.
});
```

`OrcidMockClient` (from `@nemarorg/orcid-mock-testing/client`, no dependencies) has `health`, `reset`, `users`, `user`, `createUser`, `putUser`, `deleteUser`, `putClient`, `advanceClock`, `publicBaseUrl`, and `signIn`.
`startOrConnect()` from the Testcontainers entry point does what the fixtures below do: it uses `ORCID_MOCK_URL` when that is set and starts a container otherwise.

### Playwright

```ts
// tests/signin.spec.ts
import { expect, test } from "@nemarorg/orcid-mock-testing/playwright";

test("signs in with ORCID", async ({ page, orcidMock, signInAs }) => {
  await orcidMock.client.putClient("APP-MY-APP", {
    client_secret: "my-secret",
    redirect_uris: ["http://localhost:5173/auth/callback"],
  });
  const alder = (await orcidMock.client.users())[0];
  if (!alder) throw new Error("the starter file has users");

  await page.goto("http://localhost:5173/login"); // the app redirects to the mock
  await signInAs(page, alder.orcid); // waits for the sign-in page, clicks that user's button
  await expect(page.getByText(alder.orcid)).toBeVisible();
});
```

`orcidMock` is worker-scoped (one mock per worker, from `ORCID_MOCK_URL` or a container) and has `baseUrl`, `client`, and `publicBaseUrl()`; `signInAs(page, iD)` waits until the page is on `<address>/oauth/authorize` (the origin and the path, not the query), clicks the button whose accessible name holds the iD, and throws with the mock's answer if it refuses the sign-in (a locked user).
Set the container's image and users with `test.use({ orcidMockOptions: { image, users } })`.
`signInAs(page, iD, { baseUrl })` is also exported for a plain Playwright `Page`; `baseUrl` is the address the browser reaches the mock at and the address the mock puts in its own URLs (`PUBLIC_BASE_URL`), which are the same for a container and can differ for a running instance, so pass both as an array then (the fixture does).

- **Both runtimes.**
  Playwright's runner loads the package under Node and under Bun (`bun --bun x playwright test`); both are tested, with `@playwright/test` 1.63.
- **A running instance is shared.**
  Workers get a container each, but with `ORCID_MOCK_URL` every worker talks to the same mock and its state, so set `workers: 1` in `playwright.config.ts` and call `orcidMock.client.reset()` between tests (and register your client again after it).
- **Popups.**
  When the application signs in in a popup, pass the popup page: `const popup = await page.waitForEvent("popup"); await signInAs(popup, alder.orcid);`.
- **An application that must know the mock's address at start-up** (a `webServer` entry in `playwright.config.ts`) cannot wait for a worker's random port: start the mock yourself on a fixed port and set `ORCID_MOCK_URL` to it, as the [GitHub Action](#as-a-github-action) does.

### pytest

```bash
uv add --dev orcid-mock-testing
```

The plugin registers itself with pytest on install (the `pytest11` entry point) and needs Python 3.11 or later.

```python
# tests/test_signin.py
def test_a_user_can_sign_in(orcid_mock_reset):
    alder = orcid_mock_reset.users()[0]
    token = orcid_mock_reset.sign_in(alder["orcid"])
    assert token["orcid"] == alder["orcid"]
```

`orcid_mock` is a session-scoped fixture that yields the `OrcidMockClient` (`base_url` is the address to give the application under test); `orcid_mock_reset` is function-scoped, resets before the test, and yields the same client.
Choose the container with `pytest --orcid-mock-image ghcr.io/nemarorg/orcid-mock:1 --orcid-mock-users fixtures/users.json`.
Without the plugin, `orcid_mock.container.OrcidMockContainer` is a `testcontainers` `DockerContainer`:

```python
from orcid_mock.container import OrcidMockContainer

with OrcidMockContainer(users="fixtures/users.json") as mock:
    token = mock.client.sign_in(mock.client.users()[0]["orcid"])
```

## OAuth

`/oauth/authorize`, `/oauth/token`, and `/oauth/revoke` follow ORCID's OAuth 2.0 authorization-code flow; [OpenID Connect](#openid-connect) builds on it.
The starter file registers two clients with the secret `orcid-mock-secret` and the redirect URIs `http://localhost:3000/callback` and `http://127.0.0.1:3000/callback`:
`APP-ORCIDMOCK000001`, a public client, and `APP-ORCIDMOCK000002`, a member client that may also ask for `/read-limited`.
Register your own with `PUT /__admin/clients/{client_id}`.
[ADR 0004](.context/decisions/0004-oauth-surface-and-orcid-mock-choices.md) records the reasoning behind the choices below.

### A headless round trip

Add `login_as=<iD>` to the authorize request and the sign-in page is skipped:
the answer is a 302 whose `Location` carries the code.
Read it with `curl -i`, then exchange it.

```bash
BASE=http://127.0.0.1:9700
ORCID=$(curl -s $BASE/__admin/users | grep -o '"orcid":"[^"]*"' | head -1 | cut -d'"' -f4)

# 1. Sign in as that user and read the code from the Location header.
CODE=$(curl -si "$BASE/oauth/authorize?client_id=APP-ORCIDMOCK000001&response_type=code&scope=/authenticate&redirect_uri=http://localhost:3000/callback&state=abc&login_as=$ORCID" | sed -n 's/^[Ll]ocation:.*[?&]code=\([0-9A-Za-z]*\).*/\1/p')
echo "$CODE"
# rHJ4cw

# 2. Exchange the code (a form body, as ORCID requires; the redirect_uri must repeat the one above).
curl -s -X POST $BASE/oauth/token \
  -d grant_type=authorization_code -d code=$CODE \
  -d client_id=APP-ORCIDMOCK000001 -d client_secret=orcid-mock-secret \
  --data-urlencode redirect_uri=http://localhost:3000/callback
# {"access_token":"82b915f4-...","token_type":"bearer","refresh_token":"d6e12d69-...","expires_in":631138518,"scope":"/authenticate","name":"A. Fennimore","orcid":"0009-9814-3544-3504"}
```

The response has ORCID's keys in ORCID's order:
`access_token`, `token_type` (always `bearer`), `refresh_token`, `expires_in` (`631138518`, about twenty years), `scope` (space-separated, `openid` without a slash), `name`, and `orcid` (the bare iD).
`name` is the public display name:
the credit name if the name is public and there is one, else the given and family names if the name is public, else `""`.
The code is six characters from `[0-9a-zA-Z]`, works once, and the `state` comes back exactly as sent.
In a test, the [helpers](#test-helpers)' `signIn` does these two steps.

### The sign-in page

Without `login_as`, `GET /oauth/authorize` renders a small page (no script, no external asset) that lists every user in the file as a button, plus Deny.
There is no password prompt: choosing a user signs in as that user, and the page labels a locked or deactivated user, who cannot sign in.
Choosing a user issues a code and redirects; Deny redirects with `error=access_denied` and the `state`.
A missing `response_type`, a missing or unknown `client_id`, and a `redirect_uri` that is not under a registered one are each a 400 and never a redirect.
After that, errors go back to the client the way ORCID's current front end does it:
`redirect_uri#error=unsupported_response_type` for a `response_type` other than `code`,
and `redirect_uri#error=invalid_scope` for a missing or unknown scope, for `/read-public`, or for `/read-limited` from a public client.
A redirect URI matches when its scheme, userinfo, host (case-sensitive), and port equal a registered one's and its path starts with the registered path;
the query is ignored for matching and kept when redirecting.
Signing in sets a session cookie, which `prompt=none` with the `openid` scope uses to issue a code silently;
without a session it redirects with `#login_required`.
`prompt=login` with `openid` ignores the session and shows the page.
`login_as` is an orcid-mock extension: a locked or deactivated user cannot sign in, and under `prompt=none` it is ignored.

### The token endpoint

Form-encoded `POST` only (anything else, a `GET` included, is a 415).
Client credentials come from an `Authorization: Basic` header, which wins when present, or from `client_id` and `client_secret` in the form.
Three grants are served:

| `grant_type` | Notes |
|---|---|
| `authorization_code` | The code, the same `redirect_uri` as at authorize, and the same client; a used, expired, or unknown code is `400 invalid_grant`. |
| `refresh_token` | Rotates both tokens; `scope` may narrow but not widen; `revoke_old` defaults to true and `false` keeps the old tokens valid. |
| `client_credentials` | `/read-public` only; the response has `"orcid": null` and no `name`. |

`POST /oauth/revoke` takes a `token` (access or refresh) and the same client credentials, revokes the pair, and answers 200 with an empty body.
`POST /__admin/clock` moves the server's clock to expire codes (ten minutes), sessions (24 hours), and tokens (twenty years) without sleeping.

### OAuth: where ORCID is undocumented or unobserved

These are orcid-mock's own choices, each marked "orcid-mock choice" where it is implemented:

- A code lives ten minutes and a session 24 hours of server time; ORCID documents only that a code works once.
- The sign-in page and `login_as` are orcid-mock's own, and a locked or deactivated user is refused with a 400 where real ORCID would refuse the sign-in.
- The session cookie is `Secure` when `PUBLIC_BASE_URL` is https.
- Revoke: a missing `token` is `400 invalid_request`, an unknown token is a 200 (RFC 7009 section 2.2), and a token issued to another client is `400 unauthorized_client` and is left alone (RFC 7009 section 2.1).
- ORCID documents the messages "Invalid authorization code: [code]" and "One of the provided parameters is invalid, or, the provided token/code is invalid or expired" for a failed code exchange, but not their error codes, so `invalid_grant` is orcid-mock's inference.
- `unsupported_grant_type` for an unknown grant, `code is required`, and `Invalid refresh token: <token>` are orcid-mock's own wording, because ORCID's answers were not observed.
- Refreshing with a scope outside the original is a 400 `invalid_scope`, following RFC 6749 section 5.2; ORCID's error documentation has a 400 `Invalid scope` only for `/webhook`, and ORCID's registry code maps an invalid scope to a 401.
- The `state` parameter is returned as sent and its length is not limited, where ORCID documents a limit of 2000 characters.
- `Basic` credentials are used as written, not percent-decoded.
- The scope of a token keeps the order it was requested in.
- The 415 body is the sentence alone, without the web server's error page around it.
- A redirect URI is refused if it holds a character a header cannot carry (percent-encode it), and `%2e` counts as a dot segment, because a browser resolves it as one.
- When several parameters are missing, only the order of `response_type` before `client_id` was observed; the order of the others is orcid-mock's.

## OpenID Connect

Ask for the `openid` scope and the token response carries an ID token, signed with a key the server generates the first time it needs one.
`/.well-known/openid-configuration`, `/oauth/jwks`, and `/oauth/userinfo` are the three routes a relying party (an application that signs users in through ORCID) needs to verify it and to read the user.
All three follow ORCID's CORS filter, so a browser app can call them:
they echo the request's `Origin` in `Access-Control-Allow-Origin` (and send none when the request has none), send `Access-Control-Allow-Credentials: true`, even on the userinfo 403, and answer a preflight.
No OAuth or admin route does.

### Discovery

`GET /.well-known/openid-configuration` is ORCID's document byte for byte: the same fields in the same order, pretty-printed the way ORCID's Java server prints them (`"key" : value`, two-space indent, `[ "a", "b" ]` arrays on one line), with `https://orcid.org` replaced by `PUBLIC_BASE_URL`.
`issuer` is that URL exactly, with no trailing slash, and every endpoint is built from it, so a path prefix is kept.
Nothing is read from the `Host` header.

The document advertises the `id_token` and `id_token token` response types and the `implicit` grant, as ORCID's does, but this mock implements only the code flow.
The authorize endpoint answers those response types with `redirect_uri#error=unsupported_response_type`.
Keeping the document identical to ORCID's, rather than consistent with what the mock serves, is deliberate: a client that configures itself from it should see what it would see against ORCID.

### JWKS

`GET /oauth/jwks` returns the JWKS with one RS256 key (2048-bit RSA, exponent `AQAB`) in ORCID's compact shape and key order, `{"keys":[{"kty":"RSA","e":"AQAB","use":"sig","kid":"...","n":"..."}]}`, with no `alg` member.
It is sent with `cache-control: no-cache, no-store, max-age=0, must-revalidate` and `pragma: no-cache`.
The `kid` reads `orcid-mock-` and 32 lowercase letters and digits, in the pattern of ORCID's `<env>-orcid-org-<32>`.
The key is generated on the first request that needs it, once per server, and survives `POST /__admin/reset`, so a client that cached the JWKS stays valid; a new process has a new key.

### The ID token

`POST /oauth/token` with `grant_type=authorization_code` adds `id_token` to the response when the granted scope includes `openid`, as the last key, after `orcid`.
A refresh and a client-credentials grant never carry one.

```bash
CODE=$(curl -si "$BASE/oauth/authorize?client_id=APP-ORCIDMOCK000002&response_type=code&scope=openid&nonce=n1&redirect_uri=http://localhost:3000/callback&login_as=$ORCID" | sed -n 's/^[Ll]ocation:.*[?&]code=\([0-9A-Za-z]*\).*/\1/p')
curl -s -X POST $BASE/oauth/token \
  -d grant_type=authorization_code -d code=$CODE \
  -d client_id=APP-ORCIDMOCK000002 -d client_secret=orcid-mock-secret \
  --data-urlencode redirect_uri=http://localhost:3000/callback
# {"access_token":"...","token_type":"bearer","refresh_token":"...","expires_in":631138518,"scope":"openid","name":"A. Fennimore","orcid":"0009-9814-3544-3504","id_token":"eyJraWQi..."}
```

Any library for JSON Object Signing and Encryption (JOSE) verifies it against the published key:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(new URL(`${BASE}/oauth/jwks`));
const { payload } = await jwtVerify(idToken, jwks, {
  issuer: BASE, // PUBLIC_BASE_URL
  audience: "APP-ORCIDMOCK000002",
  algorithms: ["RS256"],
});
```

The `algorithms` option is there because the JWKS has no `alg` member, as ORCID's has none, so nothing binds the key to an algorithm: pin RS256, the only one the discovery document advertises.
The protected header is exactly `{"kid": ..., "alg": "RS256"}`, with no `typ`, as in ORCID's examples.
The claims are written in this order:

| Claim | Value |
|---|---|
| `aud` | The client id, as a string (not an array). |
| `sub` | The bare iD. |
| `auth_time` | When the user signed in, in seconds. |
| `amr` | The string `pwd`, and only for a member client; ORCID returns it to the Member API only. |
| `iss` | `PUBLIC_BASE_URL`, equal to the discovery `issuer`. |
| `exp`, `iat` | Seconds; `exp` is `iat` plus 24 hours. |
| `nonce` | The authorize request's `nonce`, and only when it had one. |
| `jti` | A random universally unique identifier (UUID). |
| `at_hash` | The base64url of the left half of the access token's SHA-256. |
| `given_name`, `family_name`, `name` | The fields of a public name that exist (`name` is the credit name); none at all when the name is `limited` or `private`. |

There is no `email`, `email_verified`, or `locale`.
`iat`, `exp`, and `auth_time` are wall-clock time: `POST /__admin/clock` moves only what the server checks (codes, sessions, tokens), never what it emits, so a client library comparing them with its own clock accepts the token.

**The 24-hour lifetime is orcid-mock's choice.**
ORCID's own sources disagree: its 2017 example expires after 600 seconds, its 2019 token-delegation example after about twenty years (as long as an access token), and its 2020 text and the removed legacy implementation after 24 hours.
What ORCID's current authorization server issues was not observed.
A day outlasts any test run and is still a real, finite lifetime.

### Userinfo

`GET /oauth/userinfo` reads `Authorization: Bearer <access token>`.
`POST /oauth/userinfo` reads an `access_token` parameter first, from the query string or a form body (the query string wins, as a servlet's `getParameter` returns the first value), and then the header; a parameter that is no good does not hide a good header, as in ORCID's controller.
The token must be a live access token with the `/authenticate` or the `openid` scope; `/read-limited` and `/read-public` tokens do not qualify.

```json
{"id":"http://127.0.0.1:9700/0009-9814-3544-3504","sub":"0009-9814-3544-3504","name":"A. Fennimore","family_name":"Fennimore","given_name":"Alder"}
```

`id` is the iD under `PUBLIC_BASE_URL`, `sub` the bare iD.
A name that is not public, and any field that does not exist, is `null`, not left out.
Everything else, including no token, an unknown, revoked, or expired token, a refresh token, and a token without the scope, is ORCID's single answer: `403` with `{"error":"access_denied","error-description":"access_token is invalid"}`.
The key is hyphenated, unlike the underscore in every other ORCID error body, and there is no `WWW-Authenticate` header.

### OpenID Connect: where ORCID is undocumented or unobserved

- The 24-hour ID token lifetime, above.
- The preflight answer copies ORCID's allowed methods and headers.
  What ORCID answers to an `OPTIONS` request that has no `Access-Control-Request-Method` was not observed, so it is a 404 here, as for any unrouted method.
- No success response of ORCID's 2026 authorization server was captured, so the ID token's claims follow its documentation and its removed legacy implementation, and the userinfo body, with `id` and the nulls, follows ORCID's source.
- A userinfo token whose user was deleted answers 403, as an unknown token does.

## Record API

`GET /v3.0/...` serves the public read endpoints of ORCID's v3.0 record API, in JSON, from the users in the file.
The shapes, key order, `null` versus `[]`, error bodies, and headers are ORCID's, from its source and from live reads of `pub.orcid.org/v3.0` on 2026-10-01, so a client written against ORCID works unchanged except for the host in a URI.
[ADR 0007](.context/decisions/0007-record-api-fidelity-and-deviations.md) records the decisions below; every behavior has a permalink in the source, and every choice is marked "orcid-mock choice".

### Endpoints

All are `GET`, and `HEAD` and a trailing slash work on each; `{pc}` is a put-code.

| Path under `/v3.0/{iD}` | Answer |
|---|---|
| (the iD alone), `/record` | The whole record: `orcid-identifier`, `preferences`, `history`, `person`, `activities-summary`, `path`. |
| `/person`, `/personal-details`, `/activities` | A composition of the sections below; each section is byte for byte what its own endpoint serves. |
| `/email`, `/address`, `/other-names`, `/keywords`, `/external-identifiers`, `/researcher-urls`, `/biography` | Person-level sections. `/email` is `email` and `/address` is `address`, but `person` nests them as `emails` and `addresses`. |
| `/employments`, `/educations`, `/qualifications`, `/fundings`, `/peer-reviews`, `/works` | Activity sections, grouped. |
| `/distinctions`, `/invited-positions`, `/memberships`, `/services`, `/research-resources` | Always empty: a fixture has no such sections; their item paths (`/distinction/{pc}` and so on) answer 404 / 9016, or 400 / 9006 for the put-code of an employment, education, or qualification. |
| `/work/{pc}`, `/employment/{pc}`, `/education/{pc}`, `/qualification/{pc}`, `/funding/{pc}`, `/peer-review/{pc}` | One full item. |
| `/other-names/{pc}`, `/keywords/{pc}`, `/researcher-urls/{pc}`, `/external-identifiers/{pc}`, `/address/{pc}` | One person-level item. |
| `/works/{pc,pc,...}` | Up to 100 full works: `{"bulk": [{"work": ...}, {"error": ...}]}`. |

Every section is a container, `{"last-modified-date", <items>, "path"}`, with `[]` and a null date when empty.
Item paths are singular for activities and plural for person-level items, `display-index` is a number on person-level items and a string on activity summaries, and put-codes are numbers.
Not served: search, the unversioned redirects, the member API host, XML, the `summary` and `citation` variants of single items, and ORCID's two other representations (`application/ld+json` for the record, a citation style for a work), which are a 406 here.

### `Accept`

`application/json` is compact, and `application/orcid+json` and `application/vnd.orcid+json` are pretty-printed in Jackson's layout (`"key" : value`, `[ ]` for an empty array).
The `Content-Type` echoes the type as the client wrote it, with `;charset=UTF-8` added only when it gave no charset (and without any `q` or `qs`); errors follow the same style.
Ranges are tried by the client's q-value, then ORCID's own weight (`qs`) for each type, then specificity, then the order written, as ORCID does:
`application/json, text/plain, */*` is JSON, and `application/json, application/vnd.orcid+xml` is JSON in either order.
A header that does not parse (`application/json;q=abc`, a leading comma) is ORCID's 400 with an HTML page, which orcid-mock sends in a minimal form.

**Deviation, until XML exists:** real ORCID answers XML to a missing `Accept`, to `*/*` and `application/*`, to an XML type, and to a list that prefers XML.
orcid-mock answers 406 / 9001 with no `Content-Type` and a developer message that says it serves JSON only, that real ORCID would answer XML, and which header to send.
Any other type (`text/csv`, `text/html`, `application/ld+json`) is ORCID's own 406 / 9001.
Send `Accept: application/json` explicitly: Bun's and Node's `fetch` default to `*/*`.

### Who sees what

An item's `visibility` is `public`, `limited`, or `private`.

- **Anonymous, or any token that does not qualify below:** only `public` items.
  Non-public items are removed, not redacted, and a group left empty is removed; a non-public `name` or `biography` is `null`; every container, group, and `person` or `personal-details` date is recomputed from what survives, so none leaks the date of a hidden item (`history.last-modified-date` is the record's own and counts everything).
- **A member client's token with `/read-limited`, for the record's own iD:** also `limited` items.
- **`private`:** never served, to anyone.
- **A bad token:** `401 {"error":"invalid_token","error_description":"Invalid access token: <token>"}` on every `/v3.0` path, with no `WWW-Authenticate`.
  The token is read from `Authorization: Bearer` first, then from an `access_token` query parameter; a blank value is no token.
- A single item that exists but is hidden is 403 / 9039, not 404; `/biography` is 403 / 9039 for a hidden biography and 404 / 9041 for none.

### Record states and errors

Every record-scoped read checks, in this order: unknown iD (404 / 9016, with no checksum check), deprecated (301 with `Location` at the same path on the primary record, built from `PUBLIC_BASE_URL`, and a 9007 body), unclaimed (409 / 9036), locked (409 / 9018), deactivated (409 / 9044).
Bulk works checks only that the record exists.
In a bulk read, more than 100 put-codes is 400 / 9042 (checked first), an element that is not a number is 400 / 9006, and a put-code that is not the record's is a 9034 element after the works, with HTTP 200.
A put-code in a single-item path is read before the record's state is checked: a non-number is 404 / 9001 for a work, funding, education, employment, or peer review (ORCID declares those as numbers in the path), and 400 / 9006 for every other kind.
An affiliation put-code that belongs to another kind is 400 / 9006 (`Given affiliation <pc> doesn't match the desired type <kind>`), because ORCID keeps affiliations in one table.
A wrong method on a read path is 405 / 9001, `GET /v3.0/` is 406 / 9001 (`OPTIONS` is 200 and other methods 405), `/v3.0` with no slash is a 302 to `/v3.0/v3.0` for any method (ORCID's unversioned-path rule applied to the iD `v3.0`), and any other unrouted path is 404 / 9001.
ORCID's own root-level resources (`search`, `csv-search`, `expanded-search`, `group-id-record`, `client`, `identifiers`, `statistics`, `status`, `pubStatus`) are not served and are never read as an iD: they answer 404 / 9001, not 404 / 9016.
Error bodies have ORCID's five keys in order, `response-code`, `developer-message`, `user-message`, `error-code`, `more-info`.
Every response, errors included, carries `access-control-allow-origin: *`, `cache-control: no-cache, no-store, max-age=0, must-revalidate`, `pragma: no-cache`, `expires: 0`, `x-content-type-options: nosniff`, and `x-frame-options: DENY`.

### Record API: where ORCID is undocumented, unobserved, or cannot be copied

- Every URI is built from `PUBLIC_BASE_URL`: `orcid-identifier.uri` is `PUBLIC_BASE_URL/{iD}`, and `host` is that URL's host, port included, where ORCID writes `https://orcid.org/{iD}` and `orcid.org`.
- Every item is self-asserted: `source-orcid` is the user, `source-client-id` and the three `assertion-origin-*` keys are null, and `source-name` is the user's public display name, or null when the name is not public.
- A valid token for another iD, a public client's token, and a client-credentials token get the public view, not an error; ORCID serves `limited` reads from its member host, which was not observed.
- `history` is orcid-mock's: `WEBSITE`, no `completion-date`, `submission-date` from the name, `last-modified-date` the latest edit of anything, `claimed` from the fixture, and `verified-email` and `verified-primary-email` computed from every email whatever its visibility, as ORCID does; `preferences` is `{"locale": "en"}`.
- An unclaimed record is always 409 / 9036; ORCID blocks it only while younger than a ten-day claim wait period.
- Normalization: work, affiliation, and peer-review ids carry `{"value", "transient": true}`; only a Digital Object Identifier (DOI) is changed (lowercased and reduced to its `10.<registrant>/<suffix>` part, with ORCID's 8001 error when that fails); funding ids carry null, as observed.
- Groups merge transitively on external ids that are not `part-of` or `funded-by`, among visible items only, and a merged group stays where its earliest member's group was formed.
  Works are ordered by publication date, title, then type; affiliations by ORCID's start and end date strings; fundings and person-level lists by display index, then creation date; peer reviews by completion date, newest first, with a missing part first because ORCID's database is PostgreSQL (source only).
- Bulk works returns found works in put-code order, which is what pub.orcid.org returned for a request in another order; the source leaves it to the database.
  In a 9034 message, `${clientName}` is filled with the reader's client name when the token has one (source only) and left as is for an anonymous reader (observed).
- Emails keep the fixture's order, since ORCID's has no `order by`.
- Source only, because no such record or item could be found to observe: 403 / 9039 for a single hidden item, 404 / 9041 for a record with no biography, 409 / 9018 for a locked record, and 409 / 9036 for an unclaimed one.
- The parameters of an echoed `Content-Type` keep the order the client wrote, where ORCID's follow a hash map's, and the 400 page for a malformed `Accept` is shorter than Tomcat's.
- `OPTIONS` answers 200 with `Allow: HEAD,GET,OPTIONS`, and the CORS lists only when the request is a preflight.

### Example

```bash
BASE=http://127.0.0.1:9700
ORCID=$(curl -s $BASE/__admin/users | grep -o '"orcid":"[^"]*"' | head -1 | cut -d'"' -f4)

# What NEMAR reads: the public name.
curl -s -H 'Accept: application/json' $BASE/v3.0/$ORCID/personal-details | grep -o '"given-names":{[^}]*}'
# "given-names":{"value":"Alder"}

# Pretty-printed, as application/vnd.orcid+json asks for it.
curl -s -H 'Accept: application/vnd.orcid+json' $BASE/v3.0/$ORCID/keywords

# No Accept means XML at ORCID, which orcid-mock answers with a 406 that says so.
curl -s -H 'Accept:' $BASE/v3.0/$ORCID/email
# {"response-code":406,"developer-message":"406 Not Acceptable: orcid-mock serves JSON only, ...","error-code":9001,...}
```

## Conformance

[`conformance/`](conformance) is one test suite that runs unchanged against this mock and against ORCID's sandbox (`sandbox.orcid.org`).
A client that passes it works against either, and a place where the mock differs from ORCID shows up as a failing case here instead of a surprise in production.
The client under test, [`conformance/client.ts`](conformance/client.ts), is plain `fetch` with nothing specific to the mock:
a client-credentials token request, record reads, and the raw requests the error cases need.
The cases are listed at the top of [`conformance/conformance.test.ts`](conformance/conformance.test.ts).

| Group | Cases |
|---|---|
| `T` token endpoint | A client-credentials grant for `/read-public`: ORCID's keys in ORCID's order, `token_type` `bearer`, `orcid` null, no `name`, and a lifetime over ten years. |
| `A` anonymous reads | `personal-details`, `person`, `record`, `works`, `employments`, and `email` of one public record: status, `application/json`, every container's keys in order, every `path`, and the keys and value types of any item present. |
| `B` reads with a token | The same six reads with the client-credentials bearer token. |
| `E` error shapes | A wrong client secret (401), a JSON body at the token endpoint (415), a bad bearer (401, the token echoed, no `WWW-Authenticate`), an unknown iD and an iD with a wrong check character (404, error 9016), `Accept: text/csv` (406, error 9001, no `Content-Type`), and 101 put-codes on bulk works (400, error 9042). |

The assertions are structural: keys, order, and the kind of each value, never a count or a value, because a fixture and a real record hold different data.
Where the mock differs from ORCID on purpose, the suite avoids the case or checks only what both satisfy, with a comment naming the decision record:
it always sends `Accept` (ORCID answers XML to none, the mock a 406, [ADR 0007](.context/decisions/0007-record-api-fidelity-and-deviations.md)), it checks that `orcid-identifier` agrees with itself and not that it names `orcid.org`, and it looks for the 415 sentence inside the body, which ORCID wraps in a web server's error page and the mock sends alone (recorded under [OAuth, where ORCID is undocumented or unobserved](#oauth-where-orcid-is-undocumented-or-unobserved)).
No assertion branches on the target.

The target comes from the environment, and a missing or malformed variable stops the run with one message that names it (never its value):

| Variable | Meaning |
|---|---|
| `CONFORMANCE_TARGET` | `mock` or `sandbox`. |
| `ORCID_API_BASE` | The OAuth host: the mock's base URL, or `https://sandbox.orcid.org`. |
| `ORCID_PUB_API_BASE` | The record API host: the same base for the mock, or `https://pub.sandbox.orcid.org`. |
| `ORCID_CLIENT_ID`, `ORCID_CLIENT_SECRET` | A registered client. Not needed with `CONFORMANCE_ANONYMOUS_ONLY=1`. |
| `ORCID_PUBLIC_ID` | An iD whose record is public and whose name is public. |
| `CONFORMANCE_ANONYMOUS_ONLY` | `1` runs only the cases that need no registered client (groups `A` and `E`) and skips `T` and `B` with a message in the output. |
| `CONFORMANCE_REQUIRE_ITEMS` | `1` fails a run whose works, employments, or email container is empty, so a record with nothing in it cannot pass as full coverage. |
| `CONFORMANCE_DELAY_MS` | The least time between two requests; the default is 400 for the sandbox and 0 for the mock. |

Every read prints how many items it checked, for example `A4 works: 3 groups, 4 summaries checked`, so the output shows what a pass covered.
The client retries a request once after a 429, 502, 503, or 504, waiting for `Retry-After` (at most 30 seconds), and says so when it does.

### Against the mock

```bash
bun run src/main.ts serve --port 0 > ready.json &     # one line on stdout: {"event":"listening","url":"http://127.0.0.1:...","port":...}
until [ -s ready.json ]; do sleep 0.1; done            # the readiness line
export CONFORMANCE_TARGET=mock
export ORCID_API_BASE="$(jq -r .url ready.json)" ORCID_PUB_API_BASE="$(jq -r .url ready.json)"
export ORCID_CLIENT_ID=APP-ORCIDMOCK000001 ORCID_CLIENT_SECRET=orcid-mock-secret   # the starter fixture's public client
export ORCID_PUBLIC_ID="$(curl -s "$ORCID_API_BASE/__admin/users" | jq -er '[.[] | select(.name.visibility == "public")][0].orcid')"
bun run conformance
kill $!                                                # stop the server
```

The starter users' iDs are minted, so the iD is read from the admin API rather than written down.
The round trip (below) calls `POST /__admin/reset`, which resets the whole mock, so run the suite against a mock you own and not one that holds data you want to keep.
A container works the same way: start it with [the Action](#as-a-github-action) or `docker run`, and point the two bases at its `PUBLIC_BASE_URL`.
Every pull request, and every push to `main`, does exactly that in the `e2e` job of [`ci.yml`](.github/workflows/ci.yml):
it builds the image from the `Dockerfile`, starts it with this repository's Action, and runs the suite against it with `CONFORMANCE_REQUIRE_ITEMS=1`, using the public client and a user chosen by what it holds (a public name and at least one public work, employment, and email) rather than by position.

`bun run conformance` runs `bun test ./conformance`.
The plain `bun test` and `bun run test` run only the server's own tests under `tests/`, because `bunfig.toml` sets the test root to `tests`.

### Against the sandbox

```bash
export CONFORMANCE_TARGET=sandbox
export ORCID_API_BASE=https://sandbox.orcid.org ORCID_PUB_API_BASE=https://pub.sandbox.orcid.org
export ORCID_CLIENT_ID=... ORCID_CLIENT_SECRET=...      # a client you registered in the sandbox
export ORCID_PUBLIC_ID=...                              # a sandbox record with a public name
bun run conformance
```

The suite spaces its requests 400 ms apart and sends about twenty in a run, far below ORCID's anonymous limit of 12 a second.
The sandbox is shared and cannot be reset, so it is not an environment to hammer.
Without a sandbox client you can still run the half that needs no credentials, the anonymous reads and the error shapes, with `CONFORMANCE_ANONYMOUS_ONLY=1` and no client variables:

```bash
CONFORMANCE_TARGET=sandbox CONFORMANCE_ANONYMOUS_ONLY=1 \
  ORCID_API_BASE=https://sandbox.orcid.org ORCID_PUB_API_BASE=https://pub.sandbox.orcid.org \
  ORCID_PUBLIC_ID=... bun run conformance
```

The `T` and `B` cases are then skipped, and say so in the output.
The one `E` case that names a client, a wrong secret, uses an unregistered placeholder client id and gets `invalid_client`, as it does for a real client with a wrong secret.
The record `0000-0001-6919-3953` is a public sandbox record with a public name that this was checked against; it is nearly empty and not under our control, so use your own.
Nothing in CI uses `CONFORMANCE_ANONYMOUS_ONLY`.

The sandbox half runs weekly (Mondays, 05:23 UTC) and on demand from [`conformance.yml`](.github/workflows/conformance.yml), job `sandbox`; a manual run has an input `job` (`sandbox`, `services-smoke`, or `both`, default `sandbox`).
The job does not require items, and appends the items each read checked to the job summary.
The job needs a sandbox client and a public sandbox record, which the repository owner configures once ([`RELEASING.md`](RELEASING.md#owner-checklist-for-100), item 9).
Until they exist, the job prints a `::warning::` naming what is missing, writes the same to the job summary, and succeeds without running, so a skip is visible and not silent.
A failing case on the sandbox means the mock is wrong about ORCID or ORCID changed: find out which, and fix the mock or the assertion, never by weakening the check to pass.

### Sign-in is checked on the mock only

Real ORCID needs a person to sign in (a browser, a password, a consent click), so the sandbox run covers the token endpoint and the record API and cannot cover sign-in.
[`conformance/round-trip.test.ts`](conformance/round-trip.test.ts) covers it on the mock, as the definition of done for a brand-new sign-up with no browser, and is skipped with a message when `CONFORMANCE_TARGET` is not `mock`.
It registers a client and creates a user through the admin API, signs in with `login_as`, exchanges the code for an ID token, verifies the token against the discovery document's `jwks_uri` (RS256 pinned, with `exp`, `iat`, `sub`, `aud`, and `iss` required), reads the user through userinfo and the record API, calls `POST /__admin/reset`, and checks that the user and the test's client are gone (404, error 9016, and `invalid_client`) while the fixture's own users remain.

### The services container check

The `services-smoke` job in [`conformance.yml`](.github/workflows/conformance.yml) runs the published image as a `services:` container with no `--health-cmd`.
Its first step asserts that Docker reports the service container `healthy`, and the next reaches `/__admin/health` once, with no retry.
What that proves is that the image carries a `HEALTHCHECK` which a real runner accepts and reports healthy; it does not prove that the runner would wait for a slow start.
It runs only on a manual dispatch (input `job` set to `services-smoke` or `both`, and input `image`, default `ghcr.io/nemarorg/orcid-mock:1`) and can pass only against a published image whose package is public.

## What comes after MVP1

The second minimum viable product (MVP2) is planned to add member-API writes for works and employments, the hosted multi-tenant service, XML and other representations, webhooks, and rate-limit emulation.

## Contributing

Report a vulnerability privately, as [`SECURITY.md`](SECURITY.md) describes.
Maintainers cut releases as [`RELEASING.md`](RELEASING.md) describes.

Bun for JavaScript and TypeScript and `uv` for Python, never `npm`, `npx`, or `pip`.
Each gate is green before a commit:

| Where | Gates |
|---|---|
| the server (repository root) | `bun install`, `bun run lint`, `bun run typecheck`, `bun run test` (which runs only `tests/`; the helpers have their own, and [the conformance suite](#conformance) needs a running server) |
| the Node helper (`clients/node`) | `bun install`, `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test` (which also builds, packs, and loads the package under Node, so Node 22 or later must be on `PATH`) |
| the Python helper (`clients/python`) | `uv sync`, `uv run ruff check`, `uv run ruff format --check`, `uv run ty check`, `uv run pytest --cov` |
| the workflows (`.github/`) | `actionlint .github/workflows/*.yml`, and `uvx zizmor@<the version `ci.yml` pins> --offline .github/workflows action.yml` (the `check` job runs the second) |

The helpers' tests start a real mock, so they need Docker, a local build of the image, and (for the Node helper's browser tests) Chromium:

```bash
docker build -t orcid-mock:local .
export ORCID_MOCK_IMAGE=orcid-mock:local
(cd clients/node && bun x playwright install chromium)
```

They also start the server from this checkout (`bun run src/main.ts serve --port 0`) to test `ORCID_MOCK_URL` mode, so run `bun install` at the repository root first.
Python files are linted and formatted by a pre-commit hook that runs `ruff` through the Python helper's project on the staged files only; enable it once per clone with:

```bash
git config core.hooksPath .githooks
```

## License

MIT. Copyright The Regents of the University of California.
