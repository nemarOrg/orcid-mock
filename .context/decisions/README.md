# Architecture Decision Records

Architecture Decision Records (ADRs) capture significant decisions that shape the project: choice of stack, structural patterns, trade-offs accepted, alternatives rejected.
The project is orcid-mock, an ephemeral mock of the Open Researcher and Contributor ID (ORCID) service.
Tuck them all in here so they are easy to find later.

## Convention

- One file per decision: `NNNN-short-kebab-title.md`, zero-padded to four digits.
- `0000-template.md` is the template; copy it to start a new ADR, and expand the title to `# Architecture Decision Record (ADR) NNNN: Short decision title` so the abbreviation is spelled out where it is first used.
  Do not edit `0000-template.md` itself.
- Number sequentially: a new ADR takes the number after the highest one in the index below.
- Status flows `proposed` -> `accepted` -> (later) `superseded by ADR NNNN`.
  Never delete an ADR; supersede it.
- A later ADR that changes part of an accepted one is named in the earlier one's status line (`accepted; amended by ADR NNNN`), with one sentence on what changed.
- Keep each ADR short.
  If it grows past two screens, you are probably writing a design doc, not a decision.

## When to write an ADR

Write one when a decision:
- Will be hard or expensive to reverse.
- Cuts off other reasonable paths a future contributor might wonder about.
- Has been argued about more than once.
- Embeds a constraint (legal, performance, schedule) that is not obvious from the code.

Do not write one for routine choices that are obvious from reading the code.

## Index

Add new entries here as you create ADRs:

- [ADR 0001](0001-build-in-bun-on-a-portable-fetch-layer.md): build the mock in Bun on a portable fetch layer, in memory
- [ADR 0002](0002-portable-layer.md): the portable layer's Web-APIs-only rule, its enforcement gates, and all state in the Store
- [ADR 0003](0003-fixture-schema-and-id-minting.md): Zod as the fixture schema source, the generated JSON Schema, and the `0009-9` mint block
- [ADR 0004](0004-oauth-surface-and-orcid-mock-choices.md): the OAuth surface, fragment error redirects, passwordless sign-in, redirect matching, lifetimes, and revoke edge cases
- [ADR 0005](0005-distribution-and-release.md): four channels at one version, distroless image, cross-compiled binaries, release order, forward-only floating tags, and `bun publish` without provenance (amended by ADR 0008)
- [ADR 0006](0006-openid-connect-choices.md): the OpenID Connect choices: the 24-hour ID token, ORCID's cross-domain filter, the userinfo scope and token sources, the advertised implicit flow, and the signing key
- [ADR 0007](0007-record-api-fidelity-and-deviations.md): the record API's JSON-only 406 for Extensible Markup Language (XML), URIs from `PUBLIC_BASE_URL`, the limited view, ordering from source, and minimal normalization
- [ADR 0008](0008-client-helpers.md): the Node and Python client helpers, released in lockstep with the server, the start rules, `ORCID_MOCK_URL`, compiled JavaScript for the Node helper, and proxy variables ignored
- [ADR 0009](0009-admin-changes-and-live-state.md): the admin API's `Origin` and `Host` guard, and what admin changes do to live state: delete revokes, replace keeps tokens, lock and deactivate stop exchanges and refresh, and a client that loses membership loses limited reads

- ADR 0000 - template (do not edit)
