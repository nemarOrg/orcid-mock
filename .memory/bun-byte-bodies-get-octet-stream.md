---
name: bun-byte-bodies-get-octet-stream
description: Bun.serve adds a default Content-Type to string and byte bodies on the wire; a ReadableStream body gets none
type: observation
recorded: 2026-10-02
revalidate_after: 2027-01-02
---

The Open Researcher and Contributor ID (ORCID) service answers some errors (406, 405, unrouted 404 under `/v3.0`) with a JSON body and no `Content-Type` header.
In Bun 1.4.2, `Bun.serve` adds a default `Content-Type` when it writes a `Response` built from a string (`text/plain;charset=utf-8`) or bytes (`application/octet-stream`), although `response.headers.get("content-type")` is null before that, so the mock writes those bodies as a `ReadableStream`, which Bun leaves untyped (see `orcidApiError` in `src/errors.ts`).
Verified on 2026-10-02 with a three-case probe (string: `text/plain;charset=utf-8`; bytes: `application/octet-stream`; stream: none) and asserted by the record API tests; stale if Bun changes its default headers.
