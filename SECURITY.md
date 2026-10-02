# Security policy

## Reporting a vulnerability

Report a vulnerability privately through GitHub's private vulnerability reporting:
open [the repository's Security tab](https://github.com/nemarOrg/orcid-mock/security) and choose "Report a vulnerability",
or go straight to [the report form](https://github.com/nemarOrg/orcid-mock/security/advisories/new).
Please do not open a public issue or pull request for a vulnerability.

Say which version or image tag you ran, what you did, what you expected, and what happened.
Security fixes go to the latest release.

## Threat model

orcid-mock is a test tool: its admin API has no authentication, so anyone who can reach it can read every fixture user and client secret and reset or rewrite all state.
It is meant for loopback or an isolated continuous integration (CI) network, never for an address that untrusted callers can reach.
A web page in a browser on the same machine cannot use it: the admin API refuses a foreign `Origin` and any `Host` that is neither a loopback name nor the host of `PUBLIC_BASE_URL`, which stops cross-origin pages and Domain Name System (DNS) rebinding pages alike ([ADR 0009](.context/decisions/0009-admin-changes-and-live-state.md)); only `GET /__admin/health` answers any `Host`.
