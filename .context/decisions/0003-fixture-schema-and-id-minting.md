# ADR 0003: Fixture schema and iD minting

**Status:** accepted
**Date:** 2026-10-01
**Owner:** Seyed Yahya Shirazi

## Context

The mock needs a users-file format that editors can validate, and fixture users need Open Researcher and Contributor ID (ORCID) iDs that pass the checksum without ever being a real person's.
The schema has to be usable inside a Cloudflare Worker (see ADR 0002), which forbids code generation from strings.
ORCID's support page says it assigns iDs at random from 0000-0001-5000-0007 to 0000-0003-5000-0001 and from 0009-0000-0000-0000 to 0009-0010-0000-0000, from blocks "that will not conflict with ISNI-formatted numbers assigned in other ways" (International Standard Name Identifier).
It says nothing more about who else holds numbers outside those blocks.

## Decision

**Zod is the schema source, with `jitless`.**
The users file is described once, in Zod, with strict objects and no transforms, and `z.config({ jitless: true })` is the first statement in the schema module.
Zod would otherwise compile its parsers with `new Function`, and Ajv, the usual JSON Schema validator, always does.
`fixtures/users.schema.json` is generated from the Zod source with `io: "input"`, committed, and checked by a test that fails when it is stale; shapes used in several places carry an `id` so they appear once under `$defs`.
Rules a JSON Schema cannot express (checksums, duplicates, exactly one primary email, a public or limited email being verified, deprecation cycles) are refinements that run when the file loads, each failing with a dotted path such as `users[1].emails[0].visibility`.

**Minted iDs live in the `0009-9` block.**
`MINT_PREFIX` is `00099`, so a minted iD reads `0009-9ddd-dddd-ddd` plus the check character.
That is above the `0009` range ORCID documents, and inside the `0009` prefix ORCID uses.
Whether ISNI or ORCID has allocated anything in `0009-9...` is unknown, so the mock cannot promise that a minted iD is nobody's; the residual collision risk is accepted for a test tool, and the `0009-9` prefix makes a mock iD recognizable at a glance.
Minting is deterministic: a 53-bit synchronous hash (cyrb53) of the user's primary email and names, with the attempt number bumped on collision, so adding a user never changes anyone else's iD.
Runtime creates through the admin API hash `seq:<n>` from the store's counter instead.
Fixture iDs from any block are accepted, as long as the checksum is right.
The minted iDs of the starter users, and the first runtime mint, are pinned in tests, because consumers hardcode them.

## Consequences

- Zod's parsers run interpreted, which costs some speed on a file of a few users and nothing a test would notice.
- The JSON Schema is looser than the loader, so an editor can accept a file that fails to load; the load error says why and where.
- The generated schema is committed and must be regenerated with `bun run schema` whenever the Zod source changes.
- A client that enforces ORCID's exact ranges would reject a minted iD; none is known, and fixture iDs can use any block.
- Changing the hash, the seed format, or the block is a breaking change for every consumer that hardcodes an iD.

## Alternatives considered

- **Ajv with a hand-written JSON Schema as the source:** compiles validators with `new Function`, which Workers forbid, and leaves two descriptions to keep in step.
- **Minting inside ORCID's live block (0000-0001-5000-0007 to 0000-0003-5000-0001):** collides with real people's iDs by construction.
- **Minting in ISNI space outside the `0009` prefix:** ISNI assigns those numbers to real identities, so they can belong to a real person today.
- **Random minting with `crypto.getRandomValues`:** a Worker may not draw random values at module scope, and a fixture would get different iDs on every load, which breaks tests that assert on them.

## Receipts

- ORCID, "Structure of the ORCID Identifier" (the ranges, the statement about ISNI, and the check-character algorithm): https://support.orcid.org/hc/en-us/articles/360006897674-Structure-of-the-ORCID-Identifier
- cyrb53, public domain, by bryc: https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js
- `src/orcid-id.ts`, `src/fixtures/schema.ts`, and `src/fixtures/load.ts` implement this decision.
