# ADR 0001: Build the mock in Bun on a portable fetch layer, in memory

**Status:** accepted
**Date:** 2026-09-08
**Owner:** Seyed Yahya Shirazi

## Context

NEMAR needs to drive a brand-new Open Researcher and Contributor ID (ORCID) sign-up from automated tests, and other ORCID integrators have the same gap.
ORCID's sandbox is shared, cannot be reset from an API, and needs real accounts.
No open-source project mocks ORCID's identity layer and its record API together; the generic OAuth and OpenID Connect mocks that exist (navikt/mock-oauth2-server, axa-group/oauth2-mock-server, panva/node-oidc-provider, Dex, Keycloak, Soluto/oidc-server-mock) would still leave the ORCID-specific surface to write and would add a JVM, a .NET runtime, or a Duende license.
The same code must run as a local process, a CI service container, a self-hosted Cloudflare Worker, and a multi-tenant hosted service.

## Decision

Write the server in Bun and TypeScript with Hono on the standard `fetch` interface, reuse a `jose`-family library for RS256 signing on Web Crypto, keep all state behind one `Store` interface whose first implementation is in memory (Durable Objects later for the hosted mode), and fix the issuer with `PUBLIC_BASE_URL` rather than the `Host` header.

## Consequences

- One codebase and one build produce the binary, the container image, and the Worker; adoption channels are packaging, not new code.
- Ephemeral by construction: a process or container per job, a reset endpoint, no database.
- Fidelity is our responsibility: every ORCID behavior (token fields, error shapes, visibility, put-codes, checksum) is implemented here with a citation, and cannot be inherited from a framework.
- The hosted multi-tenant mode needs a second `Store` and tenant isolation before it can exist; the interface is decided now so that work does not force a rewrite.

## Alternatives considered

- Adopt a generic OIDC mock and stub the record API beside it: two runtimes or two processes, ORCID's non-standard token fields still hand-built, issuer derived from `Host` in at least one of them.
- Prism or WireMock fed ORCID's swagger: static examples with no OAuth semantics and no visibility rules.
- Use the real ORCID sandbox in CI: shared state, no reset, mail only to one throwaway provider, and real accounts per run.
