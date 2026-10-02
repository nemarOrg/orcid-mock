# orcid-mock-testing

Test helpers for [orcid-mock](https://github.com/nemarOrg/orcid-mock), an ephemeral mock of the Open Researcher and Contributor ID (ORCID) service:
a client for its admin API, a Testcontainers module, and a pytest plugin.
The [main README](https://github.com/nemarOrg/orcid-mock#test-helpers) has the guide, copy-pasteable examples, and the rules for `ORCID_MOCK_URL` and `ORCID_MOCK_IMAGE`.

```bash
uv add --dev orcid-mock-testing
```

Python 3.11 or later, and a Docker daemon on the machine that runs the tests (unless `ORCID_MOCK_URL` names a running instance).
The import name is `orcid_mock`.

| Import | Provides |
|---|---|
| `orcid_mock.client.OrcidMockClient(base_url)` | `health`, `reset`, `users`, `user`, `create_user`, `put_user`, `delete_user`, `put_client`, `advance_clock`, and `sign_in`, the headless sign-in that returns the token response |
| `orcid_mock.container.OrcidMockContainer(image=None, *, users=None)` | a `testcontainers` `DockerContainer` that publishes the mock on a port chosen up front; `with_users`, and after `start()` a `base_url` and a ready `client` |
| `orcid_mock.pytest_plugin` | registered with pytest on install: the session-scoped `orcid_mock` fixture, the function-scoped `orcid_mock_reset` fixture, and the options `--orcid-mock-image` and `--orcid-mock-users` |

The default image is `ghcr.io/nemarorg/orcid-mock:<this package's version>`, because the helpers are released in lockstep with the server.
