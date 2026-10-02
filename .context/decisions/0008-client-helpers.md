# ADR 0008: Client helpers, released in lockstep

**Status:** accepted
**Date:** 2026-10-01
**Owner:** Seyed Yahya Shirazi

## Context

A test that needs an Open Researcher and Contributor ID (ORCID) mock should not have to know the admin API, the headless sign-in sequence, or how to start the image with the right address.
Phase 7 ships that as a Node package (an admin client, a Testcontainers module, Playwright fixtures) and a Python package (the same client and module, and a pytest plugin).
Three constraints shape them.
The mock never derives its address from the request, so its `PUBLIC_BASE_URL` must be known before it starts.
The admin API has no authentication, so a helper must not publish it on every interface.
The server ships TypeScript source (ADR 0005), and the project rule is Bun for JavaScript and `uv` for Python.

## Decision

**Lockstep versions.**
The helpers live in this repository under `clients/` as separate packages with their own manifests and lockfiles, and carry the server's version: `@nemarorg/orcid-mock-testing` on npm and `orcid-mock-testing` on the Python Package Index (PyPI).
A helper's default image is `ghcr.io/nemarorg/orcid-mock:<its own version>`, so the release workflow refuses a tag that differs from either helper's version, and publishes them only after the image tag exists.
A prerelease must be written `-alpha.N`, `-beta.N`, or `-rc.N`, the forms that Python Enhancement Proposal (PEP) 440 can spell (`1.2.3-rc.1` is `1.2.3rc1` on PyPI, and the Python helper maps it back to the image tag).

**Start rules, the same in both languages.**
The helper picks a free host port first, binds container port 9700 to it on `127.0.0.1` only, and sets `PUBLIC_BASE_URL=http://localhost:<port>` and `HOST=0.0.0.0`.
A lost port race (Docker refusing a port that was free a moment earlier) is retried with a new port, up to three times.
The users file is copied into the container with mode 0644, not bind-mounted: a bind mount must be readable by the image's `nonroot` user, and fails on a remote daemon.
A failed start throws with the tail of the container's output, which is where the server says why it exited.
The image is the explicit option, else `ORCID_MOCK_IMAGE`, else the default.

**`ORCID_MOCK_URL` means connect.**
`startOrConnect` (Node), the Playwright fixture, and the pytest fixture use the running instance that `ORCID_MOCK_URL` names, never stop it, and refuse a `users` option, since a running instance's users cannot be set from outside.
The container classes themselves always start a container.

**The Node package ships TypeScript source, as the server does.**
It needs Bun to consume.
Playwright's runner loads it under Bun (`bun --bun x playwright test`), and loads the repository's copy under Node too, but Node refuses to strip types from a file under `node_modules`, so an installed copy does not load under Node.
The source avoids Bun-only APIs so that a compiled build stays possible.

**Python is published through trusted publishing**, from a job that holds the PyPI identity and only uploads the files an earlier, credential-free job built.

## Consequences

- One version number covers five artifacts (the npm server package, the image, the binaries, and the two helpers), and a release that forgets a helper's version stops before anything is public.
- A change to the admin API or the fixture schema can break a helper in the same pull request, and the `clients` job in continuous integration catches it, since it runs the helpers against an image built from that commit.
- The Node helper's types for users are a minimal copy, since the server package exports none; `clients/node/tests/types.ts` fails the type check if the server's fixture type stops being assignable to it.
- The Node helper does not serve Node-only projects until it is compiled; a build step, a `dist/` directory, and an exports map with `types` would fix that.
- A Docker daemon on another machine does not work, because the base URL says `localhost`.
- The first release needs the owner to create the PyPI project and its trusted publisher (the README's "Releasing" section lists the steps), and an npm token that may publish a second package.

## Alternatives considered

- **Independent helper versions:** the natural fit for packages with their own changes, but then every helper would need a compatibility table against the server, and the default image tag would be a guess.
- **Bind-mounting the users file, as the Action does:** the Action runs on a Linux runner where the file's owner and mode are under the workflow's control; a helper runs on any developer machine and cannot assume either.
- **Letting Docker pick the host port:** removes the race, but the mock's address is its issuer, and it has to be known before the container starts.
- **Publishing compiled JavaScript from the first release:** works for Node projects today, at the cost of a build step and a second thing to test; the brief and ADR 0005 chose source.
- **A PyPI token in the `release` environment:** simpler to set up than trusted publishing, but a long-lived secret that PyPI itself recommends against.

## Receipts

- Trusted publishing on PyPI: https://docs.pypi.org/trusted-publishers/
- Node's refusal to strip types under `node_modules`: https://nodejs.org/api/typescript.html#type-stripping-in-dependencies
- PEP 440 version normalization: https://peps.python.org/pep-0440/#normalization
- `clients/node`, `clients/python`, `.github/workflows/ci.yml` (the `clients` job), and `.github/workflows/release.yml` (`pypi-dist`, `npm`, `pypi`) implement this decision.
