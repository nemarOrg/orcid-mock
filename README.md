# orcid-mock

An ephemeral mock of the Open Researcher and Contributor ID (ORCID) service for tests and continuous integration:
the OAuth 2.0 authorization-code flow, OpenID Connect, and the public record API,
with users defined in a JSON file and all state kept in memory.

Status: the foundation is in progress on the MVP1 epic (#1).
The server starts, loads and validates a users file, serves the admin API (health, reset, users, clients), and answers every other path in the right error shape.
OAuth, OpenID Connect, and the record API arrive in the next phases.
See [`.context/plan.md`](.context/plan.md) for the roadmap and [`.context/research.md`](.context/research.md) for the findings behind it.

## Run it

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
| `HOST` | `--host` | `127.0.0.1` | Interface to bind. The admin API is unauthenticated, so the default is loopback; `0.0.0.0` exposes it, passwords included, to the network, and the container image will set it only because the container's network is the boundary. |
| `USERS_FILE` | `--users` | the bundled starter | Path to a users file. |
| `LOG_LEVEL` | `--log-level` | `info` | `debug`, `info`, `warn`, or `error`. |

When `PUBLIC_BASE_URL` is unset, the base URL is built from the bound address: `http://127.0.0.1:{port}` for the default host, and also for a wildcard host (`0.0.0.0` or `::`).
Inside a container the bound address means nothing to a caller, so set `PUBLIC_BASE_URL` explicitly there.
A path prefix in `PUBLIC_BASE_URL` (`https://example.test/orcid`) is only used to build URLs: the server still routes at the root, so a reverse proxy must strip the prefix before forwarding.

The other commands are `orcid-mock schema [--out FILE]` (the JSON Schema for the users file), `orcid-mock health [--url URL]` (exit code 0 when `{URL}/__admin/health` answers 200 and 1 otherwise, printing nothing on success, for health checks in images without `curl`), `--version`, and `--help`.

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
    image: ghcr.io/nemarorg/orcid-mock:latest
    ports: ["9700:9700"]
    env:
      PUBLIC_BASE_URL: http://localhost:9700
      USERS_FILE: /fixtures/users.json
    options: --health-cmd "wget -qO- http://localhost:9700/__admin/health" --health-interval 5s --health-retries 10
```

Point your application at it with the same variables you use for the sandbox
(for NEMAR: `ORCID_API_BASE` and `ORCID_PUB_API_BASE`).

## License

MIT. Copyright The Regents of the University of California.
