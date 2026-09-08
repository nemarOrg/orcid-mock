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

### Phase 1: identity

- `GET /oauth/authorize`: validates `client_id`, `response_type=code`, `scope`, exact `redirect_uri`; renders a consent page listing fixture users; `login_as=<iD>` (or `prompt=none` with a session) skips it; redirects with `code` and the unmodified `state`.
- `POST /oauth/token`: `authorization_code` (single use, ten-minute expiry, `invalid_grant` on reuse or mismatch), `refresh_token`, `client_credentials`; response carries `access_token`, `token_type`, `refresh_token`, `expires_in`, `scope`, `orcid`, `name`, and `id_token` when `openid` was requested.
- OpenID Connect: `/.well-known/openid-configuration`, `/oauth/jwks`, `/oauth/userinfo`, RS256 ID token with `sub` equal to the iD, `nonce`, `auth_time`, `amr`.
- `POST /oauth/revoke`.
- Scopes: `/authenticate`, `openid`, `/read-limited`, `/read-public`; unknown scope answers `invalid_scope`.

### Phase 2: record API (public, v3.0, JSON)

- `record`, `person`, `personal-details`, `email`, `address`, `other-names`, `keywords`, `external-identifiers`, `researcher-urls`, `biography`, `employments`, `educations`, `qualifications`, `works`, `works/{put-codes}` (413 above 100), `fundings`, `peer-reviews` (empty), `activities`.
- Visibility: `public`, `limited`, `private` per item; a `/read-limited` token from a member client sees `limited`; email defaults to `private` and only a verified email may be `public`.
- `Accept`: `application/json`, `application/orcid+json`, `application/vnd.orcid+json`; anything else answers 406.
- Stable put-codes from the fixture (or assigned at load), summary endpoints returning put-codes only.
- 404 for an unknown iD, 401 `invalid_token` for a bad bearer on limited data, 409 for a locked record (fixture flag).

### Phase 3: fixtures and admin

- JSON Schema for the users file; a generator command that mints checksum-valid iDs and a starter file.
- `GET /__admin/health`, `POST /__admin/reset` (back to the file), `POST /__admin/users` (add or replace), `DELETE /__admin/users/{iD}`.
- `PUBLIC_BASE_URL`, `USERS_FILE`, `PORT`, `LOG_LEVEL`.

### Phase 4: packaging and adoption

- npm package with a `bunx @nemarorg/orcid-mock` entry, container image, GitHub Actions service-container example, a Playwright example.
- Adoption in nemar-cli: replace the per-file `Bun.serve` stand-ins in `backend/test` with this server; add the brand-new-ORCID-sign-up case to the device-flow tests.
- Adoption in the website: a live test of `/auth/orcid/start` through `/complete`, subject to that repo's testing policy (open question 1).

## MVP2

- Member-API writes: `POST` and `PUT` for works and employments with put-code assignment, `DELETE`, 409 on duplicates.
- Hosted service: multi-tenant, a tenant per token with an isolated user set and a time-to-live, deployed as a Cloudflare Worker with Durable Objects (or on nemar infrastructure), with a small page to create a tenant and upload a fixture, so anyone can point a staging system at it without running anything.
- XML representation, webhooks, rate-limit and 503 emulation, JWKS rotation.

## Open questions

1. The website repository forbids mocks by policy; a real ORCID-shaped server on the network is a boundary stand-in like the backend's existing fixtures, but that reading needs the owner's sign-off before a live website test lands.
2. Staging keeps the real ORCID app for realism; whether a CI-only configuration of the dev worker may point `ORCID_API_BASE` at this server is a separate decision.
3. Whether the legacy password-plus-typed-ORCID sign-up route in nemar-cli (still live, no CLI caller) is worth supporting or should be removed first.
4. Hosting: Cloudflare Worker with Durable Objects versus a container on nemar infrastructure; the portable HTTP layer keeps both open.

## Not doing

- Emulating ORCID's registration and email verification UI.
- Dynamic client registration, hybrid flows, key rotation in MVP1.
- Reproducing the public versus member hostname split (one origin serves both).
