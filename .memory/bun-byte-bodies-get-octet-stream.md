---
name: bun-byte-bodies-get-octet-stream
description: Bun adds Content-Type application/octet-stream to byte bodies; a ReadableStream body sends none
type: observation
recorded: 2026-10-02
revalidate_after: 2027-01-02
---

ORCID answers some errors (406, 405, unrouted 404 under `/v3.0`) with a JSON body and no `Content-Type` header.
In Bun 1.4.2 a `Response` built from a string or bytes gets a default `Content-Type` (`text/plain;charset=utf-8` or `application/octet-stream`) even when none is set, so the mock writes those bodies as a `ReadableStream`, which Bun leaves untyped (see `orcidApiError` in `src/errors.ts`).
Verified on 2026-10-02 with a three-case probe (string: `text/plain;charset=utf-8`; bytes: `application/octet-stream`; stream: none) and asserted by the record API tests; stale if Bun changes its default headers.
