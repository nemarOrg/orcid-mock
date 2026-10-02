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
[ADR 0003](.context/decisions/0003-fixture-schema-and-id-minting.md) records the reasoning, including the small risk that a minted iD belongs to someone.

### The admin API

No authentication and no cross-origin resource sharing (CORS) in MVP1, so keep the server on loopback.
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
Helpers that do this in a test are in [`tests/helpers/oauth.ts`](tests/helpers/oauth.ts):
`authorizeAs`, `exchangeCode`, `obtainToken`, `clientCredentials`, and `refreshTokens`.

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

### Where ORCID is undocumented or unobserved

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

Ask for the `openid` scope and the token response carries an identity (ID) token, signed with a key the server generates the first time it needs one.
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

`GET /oauth/jwks` returns the JSON Web Key Set (JWKS) with one RS256 key (RSA with SHA-256, 2048 bits, exponent `AQAB`) in ORCID's compact shape and key order, `{"keys":[{"kty":"RSA","e":"AQAB","use":"sig","kid":"...","n":"..."}]}`, with no `alg` member.
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

### Where ORCID is undocumented or unobserved

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
| `/distinctions`, `/invited-positions`, `/memberships`, `/services`, `/research-resources` | Always empty: a fixture has no such sections. |
| `/work/{pc}`, `/employment/{pc}`, `/education/{pc}`, `/qualification/{pc}`, `/funding/{pc}`, `/peer-review/{pc}` | One full item. |
| `/other-names/{pc}`, `/keywords/{pc}`, `/researcher-urls/{pc}`, `/external-identifiers/{pc}`, `/address/{pc}` | One person-level item. |
| `/works/{pc,pc,...}` | Up to 100 full works: `{"bulk": [{"work": ...}, {"error": ...}]}`. |

Every section is a container, `{"last-modified-date", <items>, "path"}`, with `[]` and a null date when empty.
Item paths are singular for activities and plural for person-level items, `display-index` is a number on person-level items and a string on activity summaries, and put-codes are numbers.
Not served: search, the unversioned redirects, the member API host, XML, and the `summary` and `citation` variants of single items.

### `Accept`

`application/json` is compact, and `application/orcid+json` and `application/vnd.orcid+json` are pretty-printed in Jackson's layout (`"key" : value`, `[ ]` for an empty array).
The `Content-Type` echoes the type as the client wrote it, with `;charset=UTF-8` added only when it gave no charset (and without any `q` or `qs`); errors follow the same style.
Ranges are tried by the client's q-value, then specificity, then ORCID's own weight for each type, then the order written, as ORCID does:
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
A put-code that is not a number on a single-item path is 404 / 9001, a wrong method on a read path is 405 / 9001, `GET /v3.0/` is 406 / 9001, and any other unrouted path is 404 / 9001.
Error bodies have ORCID's five keys in order, `response-code`, `developer-message`, `user-message`, `error-code`, `more-info`.
Every response, errors included, carries `access-control-allow-origin: *`, `cache-control: no-cache, no-store, max-age=0, must-revalidate`, `pragma: no-cache`, `expires: 0`, `x-content-type-options: nosniff`, and `x-frame-options: DENY`.

### Where ORCID is undocumented, unobserved, or cannot be copied

- Every URI is built from `PUBLIC_BASE_URL`: `orcid-identifier.uri` is `PUBLIC_BASE_URL/{iD}`, and `host` is that URL's host, port included, where ORCID writes `https://orcid.org/{iD}` and `orcid.org`.
- Every item is self-asserted: `source-orcid` is the user, `source-client-id` and the three `assertion-origin-*` keys are null, and `source-name` is the user's public display name, or null when the name is not public.
- A valid token for another iD, a public client's token, and a client-credentials token get the public view, not an error; ORCID serves `limited` reads from its member host, which was not observed.
- `history` is orcid-mock's: `WEBSITE`, no `completion-date`, `submission-date` from the name, `last-modified-date` the latest edit of anything, `claimed` from the fixture, and `verified-email` and `verified-primary-email` computed from every email whatever its visibility, as ORCID does; `preferences` is `{"locale": "en"}`.
- An unclaimed record is always 409 / 9036; ORCID blocks it only while younger than a ten-day claim wait period.
- Normalization: work, affiliation, and peer-review ids carry `{"value", "transient": true}`; only a DOI is changed (lowercased and reduced to its `10.<registrant>/<suffix>` part, with ORCID's 8001 error when that fails); funding ids carry null, as observed.
- Groups merge transitively on external ids that are not `part-of` or `funded-by`, among visible items only, and a merged group stays where its earliest member's group was formed.
  Works are ordered by publication date, title, then type; affiliations by ORCID's start and end date strings; fundings and person-level lists by display index, then creation date; peer reviews by completion date, newest first.
  ORCID's source orders fundings and peer reviews this way; the works rule was only a guess.
- Bulk works returns found works in put-code order, which is what pub.orcid.org returned for a request in another order; the source leaves it to the database.
  In a 9034 message, `${clientName}` is filled with the reader's client name when the token has one (source only) and left as is for an anonymous reader (observed).
- Emails keep the fixture's order, since ORCID's has no `order by`.
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
7. A real release asks the environment's reviewer twice: before the preflight job (the token check) and before the npm publish, since each job that uses an environment is approved on its own.

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
