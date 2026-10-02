# ADR 0007: Record API fidelity and deviations

**Status:** accepted
**Date:** 2026-10-01
**Owner:** Seyed Yahya Shirazi

## Context

A client written against the Open Researcher and Contributor ID (ORCID) public API at `pub.orcid.org/v3.0` must work unchanged against this mock, so the record API copies what ORCID's source and live responses show, down to key order, `null` versus empty, and the type of `display-index`.
Some of ORCID's behavior cannot be copied: it answers XML to a missing or wildcard `Accept` header and orcid-mock has no XML yet; it writes `orcid.org` into every URI where this project derives every absolute URL from `PUBLIC_BASE_URL` (ADR 0001); and it serves `/read-limited` reads from a member host (`api.orcid.org`) that was not observed.
Where ORCID's rule is a `HashSet` order or an unobserved case, the mock needs a stated rule.

## Decision

**JSON only, and a 406 where ORCID would answer XML.**
`application/json` is compact, and `application/orcid+json` and `application/vnd.orcid+json` are Jackson-pretty-printed, each echoed in `Content-Type` as the client wrote it.
A missing `Accept` header, a wildcard, an XML type, or a q-value that prefers XML answers 406 / 9001 with a developer message that says orcid-mock serves JSON only and what to send, so a client that depends on ORCID's default fails here instead of receiving a body it cannot parse.
Every other unsupported type is ORCID's own 406 / 9001 with no `Content-Type`.

**Every URI comes from `PUBLIC_BASE_URL`; every item is self-asserted.**
`orcid-identifier.uri` is `PUBLIC_BASE_URL/<iD>` and `host` is that URL's host, port included; a deprecated record's `Location` and its 9007 text use the same base.
`source` has all six keys with the user as `source-orcid`, a null client, and the user's public display name.

**A `/read-limited` token sees `limited` items only on its own record.**
The token must carry `/read-limited`, have been issued to a member client, and name the record's iD; any other valid token, a public client's, or a client-credentials token is the public view, not an error.
A token that is not valid is a 401 on every `/v3.0` path.
`private` is never served.

**Ordering follows ORCID's source where it was read.**
Person-level items and fundings are ordered by `displayIndex desc, dateCreated asc`, works and affiliations by ORCID's comparators and date strings, and peer reviews by completion date, newest first; the brief's suggestion to reuse the works rule for fundings and peer reviews gave way to the source.
Grouping is among visible items only, by ORCID's group id, merged transitively.

**Normalization is minimal.**
Work, affiliation, and peer-review ids carry `{ value, transient: true }`; only DOIs are changed (lowercased, reduced to the `10.<registrant>/<suffix>` part, with ORCID's 8001 error when that fails); funding ids carry null, as observed.

## Consequences

- A client that reads JSON works unchanged except for the host in a URI; a client that sends no `Accept` must be fixed once, and the 406 says how.
- A fixture's behavior does not depend on when the server started: an unclaimed record is always 409 / 9036, though ORCID blocks it only for a ten-day wait period.
- The member host's reads, the XML representation, search, and the unversioned redirects are not served; adding them later changes none of the shapes here.
- The `limited` view for another iD's token is the mock's choice and may differ from the member API.

## Alternatives considered

- **Answering XML for a wildcard `Accept`:** faithful, but needs an XML writer for every shape; the 406 is the honest stand-in until MVP2.
- **Answering JSON for a wildcard `Accept`:** hides a client bug that real ORCID would expose as unparseable XML.
- **`orcid.org` in every URI:** matches the wire, but breaks the rule that nothing absolute is hard-coded and gives a client under test no way to follow a link back to the mock.
- **403 for a token on another iD:** unobserved; the public view is the safer reading of "limited is visible only to the record's own member".

## Receipts

- `src/record/` and `src/routes/record/` implement this decision; each ORCID behavior has a permalink in its comment, and each choice is marked "orcid-mock choice".
- ORCID's source at ORCID-Source `b34bb7b` (`PublicV3ApiServiceDelegatorImpl`, `PublicAPISecurityManagerV3Impl`, `OrcidSecurityManagerImpl.checkProfile`, `WorkManagerReadOnlyImpl`), and live anonymous reads of `pub.orcid.org/v3.0` on 2026-10-01.
