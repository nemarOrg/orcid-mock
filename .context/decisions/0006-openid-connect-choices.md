# ADR 0006: OpenID Connect choices

**Status:** accepted
**Date:** 2026-10-01
**Owner:** Seyed Yahya Shirazi

## Context

Open Researcher and Contributor ID (ORCID) documents its OpenID Connect layer with examples from 2017 to 2020, its server moved to a new authorization server in April 2026, and no success response of that server could be captured without a registered client.
Where a capture or the source settles a behavior (the discovery document, the JSON Web Key Set (JWKS), the userinfo 403, the cross-domain filter), the mock copies it; where the sources disagree or are silent, it needs a rule and a record of why.

## Decision

**The ID token lasts 24 hours.**
The sources give three lifetimes: the 2017 token-response example decodes to 600 seconds, the 2019 token-delegation example to 631138519 seconds (about twenty years, an access token's life), and the 2020 documentation's claim set and the removed legacy implementation to 86400 seconds.
A day outlasts any test run and is still a finite lifetime.
`iat`, `exp`, and `auth_time` are wall-clock seconds, never shifted by the admin clock.

**Cross-origin headers follow ORCID's filter, on three paths.**
Discovery, the JWKS, and userinfo (its 403 and the preflight included) echo the request's `Origin` in `Access-Control-Allow-Origin`, send none when the request has none, and always send `Access-Control-Allow-Credentials: true`, with no `Vary`.
ORCID's filter does exactly that, and its captures agree.
The header is set per route, never as middleware, because the OpenID Connect router is mounted at the root and a wildcard would reach the record API.
A preflight (`OPTIONS` with `Access-Control-Request-Method`) answers an empty 200 with ORCID's allowed methods and headers; what ORCID answers to any other `OPTIONS` request was not observed, so it is a 404 here.

**Userinfo takes a token from `/authenticate` or `openid` only.**
ORCID asks whether a token's scope "has" `/authenticate`, which is membership in the scope's combined set, and only `/authenticate` and `openid` combine it among the scopes the mock serves; a `/read-limited` or `/read-public` token gets the 403.
A POST reads `access_token` as a servlet's `getParameter` does, the query string before a form body, and falls through to the `Authorization` header when that parameter gives no answer, so a bad parameter does not hide a good header.
A GET reads the header alone.
Every failure is one 403 with the hyphenated `error-description` key.

**The document advertises the implicit flow, which is not implemented.**
Discovery lists the `id_token` and `id_token token` response types and the `implicit` grant, as ORCID's does, and the authorize endpoint answers those response types with `unsupported_response_type`.
Fidelity of the document wins over consistency with what the mock serves, since a client that configures itself from it should see what it would see against ORCID.

**One signing key per store, kept across a reset.**
The key is an RSA 2048-bit RS256 pair generated on first use and stored through `putSigningKeyIfAbsent`, so concurrent first uses agree on a winner and a client that cached the JWKS stays valid; a new process has a new key.
The `kid` is `orcid-mock-` and 32 lowercase alphanumerics, in the pattern of ORCID's `<env>-orcid-org-<32>`.
The JWKS has no `alg` member, as the production one has none.

## Consequences

- A test that reads the ID token's expiry sees a day, which ORCID may not issue; a client that assumes a short or a twenty-year lifetime should not depend on it.
- A browser app on another origin can call the three routes with credentials, as against ORCID, and cannot call the OAuth or admin routes.
- A client that follows the discovery document into the implicit flow gets a redirect error, not a token.
- A relying party must pin `RS256` itself, since the JWKS does not bind its key to an algorithm.
- A refresh and a client-credentials grant never carry an ID token, so a test that wants one signs in again.

## Alternatives considered

- **A 600-second or a twenty-year ID token:** each has one example behind it, and the first would fail a slow test while the second would make expiry untestable.
- **`Access-Control-Allow-Origin: *`:** simpler, but it is not what ORCID sends, and a credentialed request cannot use it.
- **Removing the implicit flow from discovery:** consistent with the mock, but then a client could not tell ORCID's document from the mock's.
- **A key per process in a module variable:** violates ADR 0002 (all state in the Store) and could not survive the hosted mode's tenant objects.

## Receipts

- The discovery document and the JWKS, captured on orcid.org on 2026-10-01; the userinfo 403, captured on sandbox.orcid.org on 2026-10-01.
- Discovery, userinfo, and the access-denied body: https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/src/main/java/org/orcid/frontend/web/controllers/OpenIDController.java
- The cross-domain filter: https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/web/filters/CorsFilterWeb.java#L38-L47
- The ID token's claims and 24-hour lifetime, legacy and removed upstream: https://github.com/ORCID/ORCID-Source/blob/7eeb1e7709760f328f5d3f72ebf2629f0a5d54c9/orcid-core/src/main/java/org/orcid/core/oauth/openid/OpenIDConnectTokenEnhancer.java#L90-L135
- The three example lifetimes: https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/ORCID_AUTH_WITH_OPENID_CONNECT.md#L45 (2017, 600 s), https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/ORCID_AUTH_WITH_OPENID_CONNECT.md#L89 (2020, 24 h), https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-web/tutorial/token_delegation.md#L42 (2019, about twenty years)
- The scope hierarchy: https://github.com/ORCID/orcid-model/blob/9592e2d3bde21a1edf703f26f8bc304448f886fb/src/main/java/org/orcid/jaxb/model/message/ScopePathType.java#L322-L324
- `src/oidc/`, `src/oauth/token-response.ts`, `tests/oidc.test.ts`, `tests/signing-key.test.ts`, and `tests/oidc-corrupt-key.test.ts` implement this decision.
