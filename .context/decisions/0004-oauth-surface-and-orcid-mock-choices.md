# Architecture Decision Record (ADR) 0004: OAuth surface and orcid-mock choices

**Status:** accepted
**Date:** 2026-10-01
**Owner:** Seyed Yahya Shirazi

## Context

Open Researcher and Contributor ID (ORCID) serves `/oauth/authorize` as a single-page app, proxies `/oauth/token` and `/oauth/revoke` to a new authorization server whose source is not public, and documents some behavior only through old tutorials and a removed Spring implementation.
Where an observation, the current source, or the documentation settles a behavior, the mock copies it; where none does, it needs a rule and a record of why.

## Decision

**Errors follow the current front end.**
An unknown or missing `client_id`, a missing `response_type`, and an unregistered `redirect_uri` are 400 JSON bodies and never redirect, because ORCID cannot trust the redirect target.
After that, `unsupported_response_type` and `invalid_scope` go back to the client as `redirect_uri#error=<code>` (a fragment, no description, no state), which is what the current front end does, rather than the query-string form of the older documentation.
`prompt=none` with `openid` and no session redirects to `redirect_uri#login_required` for the same reason.

**Sign-in is orcid-mock's own.**
`login_as=<iD>` skips the page for headless drivers, and a page lists every user as a button, passwordless, with Deny.
A locked or deactivated user cannot sign in by either route (real ORCID would refuse the sign-in); `login_as` is ignored under `prompt=none`, which takes the session's user.
The fixture `password` field was removed rather than left unused.

**Redirect matching follows ORCID's resolver, stricter in two places.**
Scheme, userinfo, host (case-sensitive), and port must equal a registered URI's, and the cleaned path must start with the registered path; query and fragment are ignored for matching and kept when redirecting.
A URI with a character a header cannot carry never matches, and `%2e` counts as a dot segment, because a browser resolves it as one and the prefix test would otherwise be bypassed.

**Lifetimes and the rest are choices.**
A code lives ten minutes and a session 24 hours of server time, both measured on the admin clock so a test can expire them; tokens last 631138519 seconds, as ORCID's do.
Revoke: a missing `token` is 400, an unknown token is 200, and another client's token is 400 `unauthorized_client` and left alone.
The `state` parameter is returned as sent and its length is not limited.
Error codes for the two documented code-exchange messages are `invalid_grant`, an inference.

## Consequences

- A driver gets deterministic sign-in without a browser, and a browser-driven test sees a plain page it can click.
- A client that depends on a behavior in the "choices" list can see in the source (each is marked "orcid-mock choice") and in the README that ORCID was not observed to do it.
- Changing the fragment form, the lifetimes, or the revoke rules changes what tests see, so each is a breaking change for consumers that assert on them.
- The stricter redirect rules could reject a URI that real ORCID accepts; such a client must percent-encode it.

## Alternatives considered

- **Query-string error redirects (`?error=login_required`) as the older guide says:** the current front end uses fragments, and a client that works against production ORCID must handle those.
- **A password prompt on the page:** adds nothing a test can use, since the page is already a choice among fictional users.
- **Matching redirect URIs with `new URL`:** lowercases the host and resolves dot segments, which would accept what ORCID's case-sensitive rule rejects.
- **No lifetimes:** ORCID documents none, but a code that never expires lets a stale test pass.

## Receipts

- Current front end, error fragments: https://github.com/ORCID/orcid-angular/blob/005a02798b4b5e04aedf51b88087bedc783201d3/src/app/core/oauth/oauth.service.ts#L42-L47
- Current front end, `login_required`: https://github.com/ORCID/orcid-angular/blob/005a02798b4b5e04aedf51b88087bedc783201d3/src/app/guards/authorize.guard.ts#L115-L127
- ORCID's redirect URI rules: https://info.orcid.org/ufaqs/how-do-redirect-uris-work/
- The resolver, legacy implementation removed upstream: https://github.com/ORCID/ORCID-Source/blob/7eeb1e7709760f328f5d3f72ebf2629f0a5d54c9/orcid-core/src/main/java/org/orcid/core/oauth/security/OrcidOauthRedirectResolver.java#L79-L83
- ORCID's error documentation: https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-web/tutorial/api_errors.md#L35-L37
- `src/oauth/`, `tests/oauth-authorize.test.ts`, `tests/oauth-token.test.ts`, and `tests/oauth-revoke.test.ts` implement this decision.
