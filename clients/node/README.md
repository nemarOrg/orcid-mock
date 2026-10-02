# @nemarorg/orcid-mock-testing

Test helpers for [orcid-mock](https://github.com/nemarOrg/orcid-mock), an ephemeral mock of the Open Researcher and Contributor ID (ORCID) service:
a typed client for its admin API, a Testcontainers module, and Playwright fixtures.
The [main README](https://github.com/nemarOrg/orcid-mock#test-helpers) has the guide, copy-pasteable examples, and the rules for `ORCID_MOCK_URL` and `ORCID_MOCK_IMAGE`.

## Install

The package ships compiled JavaScript (ES modules) with declarations, so it loads under Node 22 or later and under Bun 1.4 or later.
Both peer dependencies are optional, and each is needed only by the entry point that uses it.

```bash
bun add -d @nemarorg/orcid-mock-testing
bun add -d testcontainers      # ./testcontainers, and the Playwright fixture's containers
bun add -d @playwright/test    # ./playwright
```

## Entry points

| Import | Provides |
|---|---|
| `@nemarorg/orcid-mock-testing/client` | `OrcidMockClient(baseUrl)`: `health`, `reset`, `users`, `user`, `createUser`, `putUser`, `deleteUser`, `putClient`, `advanceClock`, `publicBaseUrl`, and `signIn`, the headless sign-in that returns the token response; it ignores proxy variables |
| `@nemarorg/orcid-mock-testing/testcontainers` | `OrcidMockContainer` (`withUsers`, `withImage`, `start()` returning a container with `baseUrl` and a ready `client`), `OrcidMockStartError`, and `startOrConnect()`, which uses `ORCID_MOCK_URL` when it is set and starts a container otherwise |
| `@nemarorg/orcid-mock-testing/playwright` | the `test` and `expect` of a fixture set for `@playwright/test` (`orcidMock`, `signInAs`), and `signInAs(page, iD, { baseUrl })` for any Playwright `Page` |

The default image is `ghcr.io/nemarorg/orcid-mock:<this package's version>`, because the helpers are released in lockstep with the server.
