# orcid-mock: development instructions

Tool-agnostic instructions for any coding agent. Claude Code reads this through `@AGENTS.md` in `CLAUDE.md`.

## Tooling

- Bun for everything JavaScript and TypeScript (never npm or npx); Biome for lint and format.
- The HTTP layer is portable (Hono on `fetch`), so the same code runs as a Bun binary, a container, and a Cloudflare Worker.
- JWT signing and verification use a maintained `jose`-family library on Web Crypto; never hand-roll them.
- Storage sits behind one interface: in-memory for tests and CI, Durable Objects with a time-to-live for the hosted mode.

## Rules

- Semantic line breaks in prose (one sentence per line), American English, no em-dashes.
- Spell out "Open Researcher and Contributor ID (ORCID)" on first use in any document.
- Fidelity over convenience: when in doubt, do what real ORCID does (error shapes, visibility, put-codes), and cite ORCID's documentation in the commit or the comment.
- Tests drive the real server over HTTP; a test never imports a handler to skip the wire.
- Fixture iDs must pass the checksum; the generator is the only way to mint one.

## Where things are

- `.context/plan.md`: the roadmap, phases, and open questions.
- `.context/research.md`: what NEMAR consumes from ORCID today and what exists elsewhere.
- `.context/ideas.md`: later ideas, not commitments.
- `fixtures/users.example.json`: the fixture shape.
