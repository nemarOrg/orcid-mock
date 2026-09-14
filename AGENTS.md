# orcid-mock: development instructions

Tool-agnostic instructions for any coding agent (Codex, Cursor, Copilot, Claude Code).
Claude Code reads this through `@AGENTS.md` in `CLAUDE.md`.

## Project context

An ephemeral mock of the Open Researcher and Contributor ID (ORCID) service for tests and continuous integration:
the OAuth 2.0 authorization-code flow, OpenID Connect, and the public record API, with users defined in JSON and all state in memory.
It exists so that a brand-new ORCID sign-up can be driven from an automated test, first for NEMAR and then for anyone, and so that the same code can be run locally, in a CI service container, self-hosted on Cloudflare, or as a hosted multi-tenant service.
Status: charter only; the MVP1 epic is issue #1. Repository: private under nemarOrg, MIT.

## Tooling

- Bun for everything JavaScript and TypeScript (never npm or npx); Biome for lint and format.
- Hono on the standard `fetch` interface, so one build runs as a Bun binary, a container, and a Cloudflare Worker (ADR 0001).
- JWT signing and verification through a maintained `jose`-family library on Web Crypto; never hand-rolled.
- Storage behind one `Store` interface: in-memory for tests and CI, Durable Objects with a time-to-live for the hosted mode.

## Rules

`.rules/` holds the standards: [`javascript.md`](.rules/javascript.md) (Bun, Biome, TypeScript style),
[`git.md`](.rules/git.md) (atomic commits, no emojis, no co-author trailers),
[`testing.md`](.rules/testing.md) (no mocks: this project's own tests start the real server and drive it over HTTP),
[`code_review.md`](.rules/code_review.md), [`documentation.md`](.rules/documentation.md) (this repository documents itself in README and `.context/`, not a docs site),
[`ci_cd.md`](.rules/ci_cd.md), and [`self_improve.md`](.rules/self_improve.md).

Project-specific rules:

- Fidelity over convenience: when in doubt, do what real ORCID does (error shapes, visibility, put-codes, `Accept` negotiation) and cite ORCID's documentation in the commit or the comment.
- Fixture iDs must pass the ISO 7064 MOD 11-2 checksum; the generator is the only way to mint one.
- Every absolute URL derives from `PUBLIC_BASE_URL`, never from the `Host` header.
- Semantic line breaks in prose (one sentence per line), American English, no em-dashes; spell out ORCID on first use in every document.

## Context

`.context/` holds the working documents:
[`plan.md`](.context/plan.md) (goal, decisions, MVP1 phases, MVP2, distribution channels, open questions),
[`research.md`](.context/research.md) (what NEMAR consumes from ORCID, ORCID's real surface, the projects surveyed, the build-over-adopt verdict),
[`ideas.md`](.context/ideas.md) (later ideas, not commitments), and
[`decisions/`](.context/decisions/README.md) (Architecture Decision Records; copy `0000-template.md` to add one and index it in the README; never delete an ADR, supersede it).

`fixtures/users.example.json` shows the fixture shape until the JSON Schema lands.

## Reading the shared documentation, and what to do when you cannot

`docs.nemar.org` is the canonical surface for anything about the NEMAR platform rather than about
this repository (nemar-cli ADR 0057). Public pages need nothing; fetch the URL. **Every page also
has a Markdown mirror at the same path plus `.md`**, which is what to fetch if you are a program,
and `https://docs.nemar.org/llms.txt` indexes them.

```bash
curl -s https://docs.nemar.org/platform/hosts-and-routes.md
```

Pages under `/admin/` are gated: `nemarOrg/docs` is private at source and the gate admits the
`admin` and `owner` roles only. An admin holding a NEMAR CLI key reads one without a browser:

```bash
nemar admin docs admin/operations/systems-inventory
```

**If you cannot read something you need, open the issue anyway.** Losing read access must not
cost you the ability to report a problem. File it on the relevant repository, say plainly what
you could not read and what you were trying to do, and tag **`@nemarOrg/admins`**. Someone with
access will either answer or open the page for you.

Escalation replaces read access. **Silence does not.** A blocked agent that stops without saying
so is the failure mode this instruction exists to prevent.

## Workflow

Multi-phase work runs through the epic workflow (`/project:epic-dev` in Claude Code) from the MVP1 epic issue:
one worktree, plan, implementation, and review per phase, squash-merged into the epic branch, then a regular merge into `main`.
Single-phase changes go through a feature branch and a PR.
Record a decision as an ADR in the same PR that settles it.
