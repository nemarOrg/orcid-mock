# Research

Two read-only surveys run on 2026-09-08, condensed.
Citations are in the section headers' sources.

## What the Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) consumes from Open Researcher and Contributor ID (ORCID) today

Source: nemar-cli `backend/src/services/orcid-auth.ts`, `backend/src/routes/auth-orcid.ts`, website `src/pages/auth/orcid/*` on `staging`.

- Scope `/authenticate` only; no `openid`, no `/read-limited`, no member API.
- Authorize URL: `{ORCID_API_BASE}/oauth/authorize` with `client_id`, `response_type=code`, `scope`, `redirect_uri` (`{APP_BASE_URL}/auth/orcid/callback`), `state`; no Proof Key for Code Exchange (PKCE).
- Token: `POST {ORCID_API_BASE}/oauth/token`, form-encoded, `Accept: application/json`; the code reads `orcid` and `name` from the body and discards the access token.
- One record call: `GET {ORCID_PUB_API_BASE}/v3.0/{iD}/personal-details`, reading `name.given-names.value` and `name.family-name.value`, used on every sign-in and by the admin name backfill.
- `ORCID_PUB_API_BASE` is derived from `ORCID_API_BASE` when unset (a `sandbox` substring selects `pub.sandbox.orcid.org`), and one test exercises that derivation by intercepting `fetch` for `*.orcid.org`.
- No checksum validation anywhere; every check is the regex shape `\d{4}-\d{4}-\d{4}-\d{3}[\dX]`.
- No use of works, fundings, employments, or emails from ORCID; author iDs on DataCite records come from DataCite and Crossref lookups, never from ORCID.
- Test stand-ins: every backend test that touches ORCID starts its own `Bun.serve` for the two endpoints above; users are seeded by an admin fixture route that writes the database directly.
  The website has no live ORCID test under its no-mocks policy.
- Untestable today: the brand-new ORCID sign-up through the command-line device flow, the website's link and relink pages, the pending-account state that only a fresh ORCID sign-up produces.
- A legacy password-plus-typed-ORCID sign-up route still exists on the backend with no command-line caller.

## ORCID's real surface

Sources: ORCID API tutorials, `ORCID/ORCID-Source` (`token_delegation.md`, `ORCID_AUTH_WITH_OPENID_CONNECT.md`, `api_errors.md`, `CONTENT_NEGOTIATION.md`), `ORCID/orcid-model`, the ORCID support and FAQ pages.

- OAuth 2.0: `/oauth/authorize`, `/oauth/token` on `orcid.org` and `sandbox.orcid.org`; scopes `/authenticate`, `openid`, `/read-limited`, `/activities/update`, `/person/update`; token response adds `orcid` and `name` to the standard fields; codes are single use; tokens are long-lived until revoked.
- OpenID Connect: `/.well-known/openid-configuration`, `/oauth/userinfo`, `/oauth/jwks`; RS256 only; ID token claims `sub` (the iD), `given_name`, `family_name`, `name`, `auth_time`, `nonce`, `jti`, `amr`; grants `authorization_code`, `implicit`, `refresh_token`; client auth `client_secret_post`; Basic profile only.
- Public API v3.0 on `pub.orcid.org`: `record`, `person`, `email`, `employments`, `educations`, `works` (summaries with put-codes), `works/{put-codes}` (bulk detail, 400 with error 9042 above 100), `fundings`, `peer-reviews`, `activities`; member API on `api.orcid.org` adds limited-visibility reads and writes.
- `Accept`: `application/json`, `application/orcid+json`, `application/vnd.orcid+json` (plus Extensible Markup Language (XML) and Resource Description Framework (RDF) forms); 406 otherwise; a missing or wildcard `Accept` returns XML, not JSON.
- Errors: 400 `invalid_grant` (malformed, expired, or reused code), 401 `invalid_token`, `invalid_scope`, 403, 404, 406, 409 (locked or duplicate), 413 (bulk writes only), 500.
- iD: 16 characters, ISO/IEC 7064 MOD 11-2 check character (`X` for 10): `total = (total + digit) * 2` over the first 15 digits, `result = (12 - total mod 11) mod 11`.
- Visibility: `public`, `limited`, `private` per item; email defaults to `private` and only a verified email can be public; email objects carry `verified` and `primary`.
- Limits: 12 requests per second and 25k reads per day anonymous, 100k per registered public client, 24 per second unlimited for members; 503 over burst.
- Sandbox: isolated, self-service registration, mail only to one throwaway provider, no API reset, records persist; membership not required for sandbox member-API testing.

## Wire corrections, 2026-10-01

Two read-only research passes captured live anonymous responses from `orcid.org`, `sandbox.orcid.org`, and `pub.orcid.org`, and read `ORCID/ORCID-Source` and `ORCID/orcid-model`; the full notes stay out of the repository because they quote real records.
What changed in our understanding:

- `/oauth/authorize` is now a single-page app that answers 200 to everything; the underlying authorization server answers an unknown client with 400 `{"error_description":"Invalid parameter: client_id","error":"invalid_request"}`, and never redirects to an unverified `redirect_uri`.
- Redirect URIs match on the exact origin and the path as a prefix (`OrcidOauthRedirectResolver`, and ORCID's FAQ on redirect URIs); the query is ignored for matching.
- Authorization codes are six mixed-case alphanumeric characters, single use; ORCID documents no expiry.
- Since April 2026 the token endpoint proxies a new authorization server: form-encoded only (415 otherwise); a bad client is 401 `{"error_description":"Client authentication failed","error":"invalid_client"}`; a missing `grant_type` is 400 `unsupported_grant_type`; tokens are lowercase UUIDs with `expires_in` 631138518 (about twenty years); `client_credentials` returns `"orcid":null` and no `name`.
- `/oauth/userinfo` accepts GET and POST and answers a bad token with 403 `{"error":"access_denied","error-description":"access_token is invalid"}` (hyphenated key); the production JSON Web Key Set (JWKS) key has no `alg` member.
- Record API: every section is `{last-modified-date, <items>, path}` with `[]` and `null` when empty; non-public items are removed and a non-public name or biography is `null`; `/email` returns key `email` but `person` nests it as `emails`.
- Record API errors use `response-code`, `developer-message`, `user-message`, `error-code`, `more-info`: 404 / 9016 for an unknown or malformed iD (no checksum check on reads), 406 / 9001 with no `Content-Type`, 400 / 9042 above 100 put-codes, 301 with `Location` for deprecated, 409 / 9044 deactivated, 409 / 9018 locked, 409 / 9036 unclaimed, 403 / 9039 for a single non-public item, and an OAuth-style 401 `invalid_token` for a bad bearer.
- iDs: ORCID assigns at random from 0000-0001-5000-0007 to 0000-0003-5000-0001 and from 0009-0000-0000-0000 to 0009-0010-0000-0000 (ORCID support, "Structure of the ORCID Identifier"); other numbers are in the International Standard Name Identifier (ISNI) space.

## Existing projects

| Project | License | Runtime | Latest | Identity | JSON users | Ephemeral | Record API |
|---|---|---|---|---|---|---|---|
| ORCID's own mock | retired 2012 | | | | | | |
| navikt/mock-oauth2-server | MIT | Java | 6.0.2 (2026-08) | full OAuth and OpenID Connect (OIDC) | yes | container | no |
| axa-group/oauth2-mock-server | MIT | Node | 9.2.0 (2026-09) | full | programmatic | embedded | no |
| panva/node-oidc-provider | MIT | Node | 9.12 (2026-09) | certified OIDC | code | embedded | no |
| dexidp/dex | Apache-2.0 | Go | 2.45 (2026-03) | OIDC broker | YAML | binary | no |
| geigerzaehler/oidc-provider-mock | MIT | Python | 0.4.6 (2026-06) | discovery, code, userinfo | runtime API | container | no |
| Soluto/oidc-server-mock | Duende-licensed core | .NET | rolling | full | yes | container | no |
| WireMock, Prism | Apache-2.0 | Java, Node | rolling | none native | stubs, OpenAPI | container | hand-stubbed only |

No project mocks ORCID's identity layer and record API together.

## Prior art for the fixture and admin shape

- navikt: JSON-declared token callbacks with templated claims; issuer derived from `Host`, which breaks inside containers (their issue 312), so this project fixes `PUBLIC_BASE_URL`.
- WireMock: `POST /__admin/mappings/reset`, `GET /__admin/health`; the cleanest reset-and-health precedent.
- Mailpit: single static binary, in-memory, one-call delete-all; one fresh container per job.
- GitHub Actions: `services:` containers on the job network with `--health-cmd` gating; Linux runners only.

## Recommendation

Build in Bun and TypeScript on a portable `fetch` layer, reuse a `jose`-family library for RS256, imitate the fixture and admin conventions above, and keep everything in memory.
Adopting a generic identity server would still leave the whole ORCID-specific surface to write and would add a Java runtime, a .NET runtime, or a paid license.
