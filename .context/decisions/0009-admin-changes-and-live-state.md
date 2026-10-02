# ADR 0009: The admin API guard, and what admin changes do to live state

**Status:** accepted
**Date:** 2026-10-02
**Owner:** Seyed Yahya Shirazi

## Context

The admin API of this mock of the Open Researcher and Contributor ID (ORCID) service has no authentication, by design: it listens on loopback, and every use of it is a test or a script on the same machine.
The cross-phase review of the MVP1 epic found two gaps.
The `Origin` rule that kept a web page from resetting or rewriting a mock did not stop a DNS-rebinding page, which the browser treats as same-origin and so sends no `Origin` on a `GET`: such a page could read every user.
And the admin API changes users and clients while codes, tokens, and sessions that refer to them are live, with no stated rule for what happens next.
A token kept working for a user who was deleted and then created again with the same iD, a locked user could still exchange a code and refresh, and a client demoted from member kept its limited reads.

## Decision

**The guard has two rules, and both are orcid-mock's own.**
A request to `/__admin/*` whose `Origin` is not the origin of `PUBLIC_BASE_URL` is `403 {"error":"forbidden_origin"}`, as before.
A request whose `Host` hostname is neither a loopback name (`localhost`, `127.0.0.1`, `::1`, `[::1]`, any case, any port) nor the hostname of `PUBLIC_BASE_URL` is `403 {"error":"forbidden_host"}`.
A missing or malformed `Host` is refused too.
`GET /__admin/health` alone is exempt from the `Host` rule, because it reveals only two counts and an orchestrator's probe sends `Host: <pod-ip>:9700`; the `Origin` rule still applies to it.
`PUBLIC_BASE_URL` is how a caller on another host, such as another container, is let in: it names the address that caller uses.
This is the one place the mock reads `Host`, and only to refuse; every URL still derives from `PUBLIC_BASE_URL` (ADR 0001), and the path and query are read from the text of the request URL, so a `Host` that does not parse no longer turns a valid request into a 500, and when Bun cannot build a URL from `Host` at all (empty, absent, or holding a space, `/`, `@`, `?`, or `#`) `src/server.ts` rebuilds the request under the origin of `PUBLIC_BASE_URL` with its raw target, so routing never depends on `Host` while the admin guard still reads the original header.

**Deleting a user revokes everything issued to their iD.**
`Store.deleteUser` also removes every authorization code, access and refresh token, and session for that iD, in the same atomic step, whether or not the user existed.
A user created later with the same iD starts clean: no old token authenticates them, and no old session signs them in.
This changes `MemoryStore`'s behavior and the store contract suite, not any signature.

**Replacing a user keeps their tokens.**
`PUT /__admin/users/{iD}` is an edit of the same person, so codes, tokens, and sessions stay, and a token reads the edited record at once.

**Locking or deactivating a user stops every use of what they hold, without revoking it.**
Sign-in already refused such a user.
The authorization-code exchange and the refresh grant are now `400 invalid_grant` with a description that names the state (`iD <iD> is locked and cannot receive a token`), userinfo is ORCID's `403 access_denied`, and the record API keeps its `409`.
The tokens are not revoked, so unlocking the user lets a client carry on, and a refresh refused for this reason does not spend its refresh token.

**A client that loses its membership loses limited reads.**
A `/read-limited` token is served `limited` items only if its client is a member when the read happens (the store is asked each time, so a `PUT /__admin/clients/{id}` takes effect at once).
Otherwise the reader gets the public view, as for any token that fails a test, not an error.
The scope is refused to a client that is not a member at every step that could grant it: authorize (as before), the code exchange, and refresh are `400 invalid_scope` (authorize redirects `#error=invalid_scope`), so a client demoted between authorize and the exchange gets no token.
A refresh can still ask for a narrower `scope`, and a refusal revokes nothing.
Membership is therefore not stored on a token: the `member` field of `TokenRecord` is removed, an interface change to the `Store` made before 1.0, and the store contract suite no longer sets it.

**Also decided in the same review.**
A request body above 8 MiB is refused (413, or a closed connection for chunked uploads) by the socket before the app sees it (Bun's default is 128 MiB).
The sign-in errors of `login_as` and the consent form put `error_description` first, like the other `invalid_request` errors of `/oauth/authorize`, and stay UTF-8 because they echo the iD the caller sent, which ISO-8859-1 cannot carry.

## Consequences

- A caller that reaches the admin API under a name that is neither loopback nor the host of `PUBLIC_BASE_URL` gets a 403 and must set `PUBLIC_BASE_URL` to that name.
  This includes a client helper that connects with `ORCID_MOCK_URL` to an address that differs from the mock's own `PUBLIC_BASE_URL`, and a reverse proxy that rewrites `Host`.
- A test that deletes a user to simulate an outage and then restores the same iD now needs a new sign-in; it should use `locked` for an outage that ends.
- Lock, deactivate, and demote are reversible without losing a session, which is what a test of an interrupted flow wants; deletion is the way to end one.
- A client that is promoted again gets its old limited tokens back, since nothing about membership is stored on them.
- The sign-in page at `/oauth/authorize` still lists every fixture user, so a DNS-rebinding page can read their names and iDs; this is accepted because the data is fictional.
- A Durable Object `Store` must make `deleteUser` clear the user and everything issued to the iD in one transaction, which the contract suite now checks.

## Alternatives considered

- **Authenticating the admin API with a secret:** closes both holes, but every test, script, and helper would need to be given and to send it, and the mock's value is that it needs no configuration; the `Host` and `Origin` rules cover the browser, the only caller that is not already inside the trust boundary of the machine.
- **An `ALLOWED_HOSTS` setting beside `PUBLIC_BASE_URL`:** more flexible, but a second setting that must agree with the first, where `PUBLIC_BASE_URL` already names the host callers use.
- **Leaving tokens when a user is deleted, and treating them as unusable while the user is missing (the previous behavior):** simple, but a user created again with the same iD, by a test or by a person, inherited the old tokens and sessions.
- **Revoking tokens on every `PUT`:** also clean, but editing a user mid-session is the common case, and an edit must not sign the person out.
- **Revoking tokens when a user is locked:** a `PUT` cannot say why it changed a record, and a test that locks a user to check the refusal, then unlocks, would have to sign in again.
  Leaving the tokens working was also rejected: the record API already answers 409 for such a user, so the other surfaces would disagree with it.
- **Trusting the `member` flag stored on the token alone:** a demoted client would keep limited reads until its tokens expired in twenty years.
- **Dropping `/read-limited` silently from the token a refresh issues to a demoted client:** RFC 6749 permits a narrower grant, but the client would learn it only by a missing scope; a 400 matches what authorize does.

## Receipts

- `src/routes/admin.ts`, `src/request-target.ts`, `src/store/memory.ts`, `src/store/types.ts`, `src/oauth/account-state.ts`, `src/oauth/token.ts`, `src/oidc/userinfo.ts`, `src/record/viewer.ts`, and `src/server.ts` implement this decision.
- `tests/admin.test.ts` (DNS-rebinding protection), `tests/host-header.test.ts`, `tests/live-state.test.ts`, `tests/helpers/store-contract.ts`, and `tests/request-size.test.ts` check it.
- DNS rebinding, which a `Host` check stops because the attacker's page keeps its own hostname: https://en.wikipedia.org/wiki/DNS_rebinding
- A refresh may ask for a narrower scope, and RFC 6749 section 6 says it may not widen one: https://datatracker.ietf.org/doc/html/rfc6749#section-6
