# Ideas

Not commitments. Move an item into plan.md when it is decided.

- A `login_as` picker that also offers "deny" and "error" outcomes so consumers can test refusals without special fixtures.
- Per-user latency and failure injection (`fail_next: 1`, `delay_ms`) for retry-logic tests.
- A Playwright fixture package that boots the server and exposes `signInAs(iD)`.
- A Python client for pytest users (nemar-tools), thin wrapper over the admin API.
- Record the exact real-ORCID responses used as fixtures in a `conformance/` directory and diff the mock against them in CI.
- Import a real public ORCID record (public API, no auth) into the fixture format with one command.
- Hosted mode: a tenant per GitHub Actions run created by an action step, deleted at the end.
