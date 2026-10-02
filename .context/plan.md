# Plan

Charter written 2026-09-08 after the nemar-cli v0.10.0 release,
which made browser sign-in through Open Researcher and Contributor ID (ORCID) the only way into the NEMAR command-line tool
and left one flow untestable end to end: a brand-new ORCID sign-up.

## Goal

A single small program that stands in for ORCID in tests and CI, and later as a hosted service anyone can point a staging system at,
so that an integration written against it also works against the real ORCID.

## Decisions

1. Build, do not adopt: no existing project covers ORCID's identity layer and record API together (see research.md).
2. Bun and TypeScript with Hono on the standard `fetch` interface, so one codebase runs as a CLI process, a container image, and a Cloudflare Worker.
3. JWTs through a `jose`-family library on Web Crypto (RS256 only, one static key pair per run); everything else written here.
4. All state in memory behind a `Store` interface; the hosted mode swaps in Durable Objects with a time-to-live per tenant.
5. Users come from a JSON file (`USERS_FILE`) validated by a published JSON Schema, and can be added at run time through the admin API.
6. A fixed `PUBLIC_BASE_URL` decides the issuer and every absolute URL; nothing is derived from the `Host` header.
7. Fidelity first: ORCID's real response shapes, status codes, error bodies, visibility rules, and put-code semantics, each with a citation.
8. MIT license; published to npm as `@nemarorg/orcid-mock` and as a container image on GitHub's registry.

## MVP1: everything easy, all read-only

Tracked in epic #1, re-sequenced on 2026-10-01 into seven phases so fixtures land before identity.
Phase 1 runs alone; phases 2 and 5 run in parallel after it; then 3, 4, and 7; then 6.
Wire details below were corrected on 2026-10-01 against live ORCID responses and ORCID's source (see research.md).

### Phase 1: foundation (#4)

- Hono on the standard `fetch` interface with a portable layer that uses Web APIs only (ADR 0002), a frozen `Store` interface with the in-memory implementation, and every piece of mutable state inside the Store.
- The users-file schema (Zod as the source, JSON Schema generated), the ISO/IEC 7064 MOD 11-2 checksum, and a generator that mints iDs and a starter file.
- Admin API: `GET /__admin/health`, `POST /__admin/reset` (back to the file), `GET`, `POST`, `PUT`, and `DELETE` on `/__admin/users`, and `PUT /__admin/clients/{client_id}`.
- `PUBLIC_BASE_URL`, `USERS_FILE`, `PORT`, `HOST`, `LOG_LEVEL`; a test harness that starts the real server on a free port; CI.

### Phase 2: OAuth 2.0 (#5)

- `GET /oauth/authorize`: validates `client_id`, `response_type=code`, `scope`, and `redirect_uri` (ORCID matches the origin exactly and the path as a prefix); renders a consent page listing fixture users; `login_as=<iD>` (or `prompt=none` with a session) skips it; redirects with `code` and the unmodified `state`; an unknown client or a mismatched `redirect_uri` never redirects.
- `POST /oauth/token`, form-encoded only (415 otherwise): `authorization_code` (single use; the ten-minute expiry is this project's choice, ORCID documents none), `refresh_token`, `client_credentials`; the response carries `access_token`, `token_type` (`bearer`), `refresh_token`, `expires_in` (`631138518`, about twenty years), `scope`, `orcid`, and `name` (`orcid` is `null` and `name` is absent for client credentials).
- `POST /oauth/revoke`; `POST /__admin/clock` to expire codes and tokens without sleeping.
- Scopes: `/authenticate`, `openid`, `/read-limited`, `/read-public`; unknown scope answers `invalid_scope`.

### Phase 3: OpenID Connect (#6)

- `/.well-known/openid-configuration`, `/oauth/jwks`, `/oauth/userinfo` (GET and POST; a bad token is a 403 with the hyphenated `error-description` key), RS256 ID token with `sub` equal to the iD, `nonce`, `auth_time`, `amr`; the signing key is generated once per tenant and kept across reset.

### Phase 4: record API, public v3.0, JSON (#7)

- `record`, `person`, `personal-details`, `email`, `address`, `other-names`, `keywords`, `external-identifiers`, `researcher-urls`, `biography`, `employments`, `educations`, `qualifications`, `works`, `work/{put-code}`, `works/{put-codes}`, `fundings`, `peer-reviews`, `activities`.
- Every section is a container of `last-modified-date`, the item array, and `path`; non-public items are removed, not redacted; a non-public name or biography is `null`; a `/read-limited` token from a member client also sees `limited`.
- `Accept`: `application/json`, `application/orcid+json`, `application/vnd.orcid+json`; a missing or wildcard `Accept` gets XML from real ORCID, so the mock answers 406 with a message saying so (documented deviation until XML exists); anything else answers 406 (error 9001).
- More than 100 put-codes answers 400 (error 9042); an unknown or malformed iD answers 404 (error 9016); deprecated answers 301 with `Location`; locked, deactivated, and unclaimed answer 409; a bad bearer answers 401 `invalid_token`.

### Phase 5: packaging and distribution (#8)

- Compiled binaries, a multi-arch container image, the npm package with a `bunx` entry, a GitHub Action, a release workflow, and the Worker smoke test.

### Phase 6: the definition of done (#9)

- An `e2e` job in CI: the image built from the `Dockerfile`, started by this repository's Action, and a brand-new sign-up driven with no browser (create a user, sign in, verify the ID token, read the record, reset).
- One conformance suite (`conformance/`) whose client code runs unchanged against the mock and against `sandbox.orcid.org`, run weekly against the sandbox, and a smoke test of the image as a `services:` container.
- Adoption was split off in the re-scope of 2026-10-02: replacing nemar-cli's per-file `Bun.serve` ORCID stand-ins with this server is follow-up #17, after 1.0.0 is published.
  Adoption in the website stays subject to that repository's testing policy (open question 1).

### Phase 7: client helpers (#10)

- Testcontainers modules for Node and Python, a Playwright fixture, and a pytest plugin.

## MVP2

- Member-API writes: `POST` and `PUT` for works and employments with put-code assignment, `DELETE`, 409 on duplicates.
- Hosted service: multi-tenant, a tenant per token with an isolated user set and a time-to-live, deployed as a Cloudflare Worker with Durable Objects (or on nemar infrastructure), with a small page to create a tenant and upload a fixture, so anyone can point a staging system at it without running anything.
- XML representation, webhooks, rate-limit and 503 emulation, JWKS rotation.

## Distribution: how people get one

One codebase, four ways to run it, in order of how much the user controls:

1. Local process: `bunx @nemarorg/orcid-mock --users users.json`; the user owns everything, nothing leaves the machine.
2. CI service container: `ghcr.io/nemarorg/orcid-mock` in a GitHub Actions `services:` block with a health check; one fresh instance per job, gone when the job ends; the fixture file ships with the repository under test.
3. Self-hosted Worker: `wrangler deploy` from the repository (or a deploy button) puts a private instance on the user's own Cloudflare account; the same code, the Durable Object store, their own base URL.
4. Hosted by NEMAR: one public multi-tenant instance where a caller creates a tenant, uploads a fixture, and receives an isolated base URL that expires; nothing to install, for people who only want to point a staging system somewhere.

Control comes from the same three knobs everywhere: the users file, `PUBLIC_BASE_URL`, and the admin API (`reset`, `users`); the hosted mode adds a tenant token and a time-to-live.
Paths 1 and 2 are MVP1; paths 3 and 4 are MVP2 and share the storage interface decided above.

### Every other channel worth having

All of these wrap the same binary or image; none needs new server code.

MVP1, nearly free once the image and the `bun build --compile` binary exist:

- Container image on GitHub's registry (`ghcr.io/nemarorg/orcid-mock`), multi-arch (amd64 and arm64), tagged by version and `latest`, with a `docker-compose.yml` example.
- Static binaries per platform attached to each GitHub Release (Linux, macOS, Windows, both architectures), so no runtime install at all.
- A GitHub Action (`nemarOrg/orcid-mock-action` or `uses: nemarOrg/orcid-mock@v1`) that pulls the image, waits for health, and exports `ORCID_API_BASE`; one line in a workflow instead of a `services:` block.
- A Testcontainers module for Node and for Python, so integration tests start and stop it themselves.
- A Playwright fixture (`signInAs(iD)`) and a pytest plugin (`orcid_mock` fixture) built on the admin API.

MVP2:

- Homebrew tap and a Nix flake for the binary.
- A Dev Container feature, so a codespace has it running on open.
- Helm chart and a plain Kubernetes manifest for teams whose CI runs in a cluster.
- One-click templates for Cloudflare (deploy button), Fly.io, Railway, and Render, each pointing at the same image or Worker.
- A VS Code task and an `npx`-compatible shim for people without Bun.


## Open questions

1. The website repository forbids mocks by policy; a real ORCID-shaped server on the network is a boundary stand-in like the backend's existing fixtures, but that reading needs the owner's sign-off before a live website test lands.
2. Staging keeps the real ORCID app for realism; whether a CI-only configuration of the dev worker may point `ORCID_API_BASE` at this server is a separate decision.
3. Whether the legacy password-plus-typed-ORCID sign-up route in nemar-cli (still live, no CLI caller) is worth supporting or should be removed first.
4. Hosting: Cloudflare Worker with Durable Objects versus a container on nemar infrastructure; the portable HTTP layer keeps both open.

## Not doing

- Emulating ORCID's registration and email verification UI.
- Dynamic client registration, hybrid flows, key rotation in MVP1.
- Reproducing the public versus member hostname split (one origin serves both).
