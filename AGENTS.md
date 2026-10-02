# orcid-mock: development instructions

Tool-agnostic instructions for any coding agent (Codex, Cursor, Copilot, Claude Code).
Claude Code reads this through `@AGENTS.md` in `CLAUDE.md`.

## Project context

An ephemeral mock of the Open Researcher and Contributor ID (ORCID) service for tests and continuous integration (CI):
the OAuth 2.0 authorization-code flow, OpenID Connect, and the public record API, with users defined in JSON and all state in memory.
It exists so that a brand-new ORCID sign-up can be driven from an automated test, first for the Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) and then for anyone, and so that the same code can be run locally, in a CI service container, self-hosted on Cloudflare, or as a hosted multi-tenant service.
Status: the first minimum viable product (MVP1) is complete (epic #1); [`RELEASING.md`](RELEASING.md) describes how a release is cut and what the owner sets up by hand.
Repository: public under nemarOrg, MIT.

## Tooling

- Bun for everything JavaScript and TypeScript (never npm or npx); Biome for lint and format.
- Python only in the helper under `clients/python`: uv (never pip, conda, or virtualenv), Ruff for lint and format, Ty for type checking, pytest with coverage.
  `git config core.hooksPath .githooks` once per clone enables the pre-commit hook that runs Ruff on staged Python files.
- The Node helper is its own package under `clients/node`, with its own manifest and lockfile (Bun, Biome, `bun:test`).
- Hono on the standard `fetch` interface, so one build runs as a Bun binary, a container, and a Cloudflare Worker (Architecture Decision Record (ADR) 0001).
- JSON Web Token (JWT) signing and verification through a maintained `jose`-family library on Web Crypto; never hand-rolled.
- Storage behind one `Store` interface: in-memory for tests and CI, Durable Objects with a time-to-live for the hosted mode.
- Workflows pin every third-party action by full commit SHA with a version comment; `actionlint` and zizmor check them (README, Contributing).

## Rules

`.rules/` holds the standards: [`javascript.md`](.rules/javascript.md) (Bun, Biome, TypeScript style),
[`git.md`](.rules/git.md) (atomic commits, no emojis, no co-author trailers),
[`testing.md`](.rules/testing.md) (no mocks: this project's own tests start the real server and drive it over HTTP),
[`code_review.md`](.rules/code_review.md),
[`documentation.md`](.rules/documentation.md) (this repository documents itself in README and `.context/`, not a docs site),
[`ci_cd.md`](.rules/ci_cd.md), and [`self_improve.md`](.rules/self_improve.md).

Project-specific rules:

- Fidelity over convenience: when in doubt, do what real ORCID does (error shapes, visibility, put-codes, `Accept` negotiation) and cite ORCID's documentation in the commit or the comment.
- Fixture iDs must pass the ISO 7064 MOD 11-2 checksum; the generator is the only way to mint one.
- Every absolute URL derives from `PUBLIC_BASE_URL`, never from the `Host` header.
- `conformance/` is one suite that runs unchanged against the mock and ORCID's sandbox (README, Conformance): when you change what the mock answers, run it against a local mock, and when it disagrees with the sandbox, fix the mock or the assertion, never weaken a check to pass.
- Semantic line breaks in prose (one sentence per line), American English, no em-dashes; spell out every abbreviation on first use in every document, ORCID included.

## Context

`.context/` holds the working documents:
[`plan.md`](.context/plan.md) (goal, decisions, MVP1 phases, the second minimum viable product (MVP2), distribution channels, open questions),
[`research.md`](.context/research.md) (what NEMAR consumes from ORCID, ORCID's real surface, the projects surveyed, the build-over-adopt verdict),
[`ideas.md`](.context/ideas.md) (later ideas, not commitments), and
[`decisions/`](.context/decisions/README.md) (ADRs; copy `0000-template.md` to add one and index it in the README; never delete an ADR, supersede it).

[`RELEASING.md`](RELEASING.md) holds the release procedure, the pins that are bumped by hand, and the owner's checklist for 1.0.0.
[`SECURITY.md`](SECURITY.md) holds the reporting policy and the threat model.

`fixtures/users.schema.json` is the fixture's JSON Schema, generated from `src/fixtures/schema.ts` by `bun run schema` (a test fails when it is stale), and `fixtures/users.example.json` is the bundled starter from `src/fixtures/starter.ts`, which `orcid-mock fixture` writes (regenerate the file with `bun run example`).

## Project memory

`.memory/` is the tracked, cross-agent store for durable operational observations:
what cost someone time and will cost the next agent the same unless written down.
Keep one fact per Markdown file with `name`, `description`, `type`, and `recorded` frontmatter,
plus `revalidate_after` when the fact depends on a changing surface,
and add a row (entry link, type, revalidate-after date, one-line hook) to the table in [`.memory/INDEX.md`](.memory/INDEX.md).
[`.memory/README.md`](.memory/README.md) has the format;
it is a verbatim template copy and keeps its hard wrapping so `update-rules` reports it current.

- `.context/decisions/` is binding, the rest of `.context/` is non-binding analysis and plans,
  and `.memory/` is non-binding observation.
  Promote a memory to an ADR when it encodes a choice; never cite a memory as policy.
- Correct or delete a memory when it becomes false.
- Never store secrets, tokens, credentials, private transcripts, customer data, personal data, or anything about a named individual.

## Reading the shared documentation, and what to do when you cannot

`docs.nemar.org` is the canonical surface for anything about the NEMAR platform rather than about this repository (nemar-cli ADR 0057).
Public pages need nothing; fetch the URL.
**Every page also has a Markdown mirror at the same path plus `.md`**, which is what to fetch if you are a program,
and `https://docs.nemar.org/llms.txt` indexes them.

```bash
curl -s https://docs.nemar.org/platform/hosts-and-routes.md
```

Pages under `/admin/` are gated: `nemarOrg/docs` is private at source and the gate admits the `admin` and `owner` roles only.
An admin holding a NEMAR command-line interface (CLI) key reads one without a browser:

```bash
nemar admin docs admin/operations/systems-inventory
```

**If you cannot read something you need, open the issue anyway.**
Losing read access must not cost you the ability to report a problem.
File it on the relevant repository, say plainly what you could not read and what you were trying to do, and tag **`@nemarOrg/admins`**.
Someone with access will either answer or open the page for you.

Escalation replaces read access.
**Silence does not.**
A blocked agent that stops without saying so is the failure mode this instruction exists to prevent.

## Workflow

Multi-phase work runs as an epic: one tracking issue (the MVP1 epic is #1) and one long-lived epic branch (`feature/issue-1-epic-mvp1`), with a child issue per phase.
Each phase gets its own git worktree and branch, and is planned, implemented, and reviewed by a separate pass before it is squash-merged into the epic branch.
When the epic is complete, the epic branch is merged into `main` with a regular merge, which keeps the phase history.
The `epic-dev` command (`/project:epic-dev` in Claude Code) automates these steps; it comes from the maintainers' Claude Code plugin and is not part of this repository, so without it, follow the same steps by hand.

Single-phase changes go through a feature branch and a pull request.
Record a decision as an ADR in the same pull request that settles it.
