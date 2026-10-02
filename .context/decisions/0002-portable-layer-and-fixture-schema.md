# ADR 0002: Portable layer and fixture schema

**Status:** accepted
**Date:** 2026-10-01
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0001 commits to one codebase that runs as a Bun process, a container, a Cloudflare Worker, and later a hosted multi-tenant service.
Workers expose Web APIs, not Node's.
Without the `nodejs_compat` flag a `node:*` import fails at deploy time, and a Worker may not draw random values or do I/O at module scope or generate code from strings (`eval`, `new Function`).
The mock also needs a users-file format that editors can validate, a way to give fixture users Open Researcher and Contributor ID (ORCID) iDs that are checksum-valid, and a rule for where state lives, so that a tenant boundary can be added later without rewriting routes.

## Decision

**A portable layer, Web APIs only.**
The portable layer is `src/app.ts` and everything it imports.
It uses the standard `fetch` types, `crypto`, `structuredClone`, and `URL`, and never `Bun`, `process`, `Buffer`, `require`, `__dirname`, or a `node:*` or `bun:*` import.
We do not turn on `nodejs_compat`.
Bun-only code is `src/server.ts` and `src/main.ts`, which bind the socket, read files, parse the command line, and handle signals.

**Two gates enforce it, both in CI.**
`tsconfig.portable.json` type-checks `src/app.ts` and its imports with `types: []` and `lib: ["ES2023", "WebWorker"]`, so any Bun or Node name is a compile error.
Biome's `noRestrictedImports` and `noRestrictedGlobals` forbid the same names across `src/**` except the two Bun files.
A `bun build --target=browser` gate was checked and rejected: it silently stubs `node:fs` and passes `Bun.*` through, so it passes code that Workers would reject.
A real-runtime smoke test (a Worker entry, `wrangler deploy --dry-run`, one Miniflare request) is phase 5's job.

**All mutable state lives in the `Store`, and one `Store` is one tenant.**
No module or process variable holds state, and no `Store` method takes a tenant id.
In the hosted mode the Hono app runs inside the tenant's Durable Object, and the Worker only routes.

**Zod is the schema source, with `jitless`.**
The users file is described once, in Zod, with strict objects and no transforms, and `z.config({ jitless: true })` is the first statement in the schema module.
Zod would otherwise compile its parsers with `new Function`, and Ajv, the usual JSON Schema validator, always does, which Workers forbid.
`fixtures/users.schema.json` is generated from the Zod source with `io: "input"` and committed, and a test fails when it is stale.
Rules a JSON Schema cannot express (checksums, duplicates, exactly one primary email, a public email being verified) are refinements that run when the file loads, each failing with a dotted path such as `users[1].emails[0].visibility`.

**Minted iDs live in the `0009-9` block.**
`MINT_PREFIX` is `00099`, so a minted iD reads `0009-9ddd-dddd-ddd` plus the check character.
ORCID assigns iDs at random from 0000-0001-5000-0007 to 0000-0003-5000-0001 and from 0009-0000-0000-0000 to 0009-0010-0000-0000, and numbers outside those ranges are International Standard Name Identifier (ISNI) space.
`0009-9...` is inside the `0009` prefix ORCID uses, which keeps it out of ISNI space, and above ORCID's documented range, so today it cannot be a real person's iD.
Minting is deterministic: a 53-bit synchronous hash (cyrb53) of the user's primary email and names, with the attempt number bumped on collision, so adding a user never changes anyone else's iD.
Runtime creates through the admin API hash `seq:<n>` from the store's counter instead.
Fixture iDs from any block are accepted, as long as the checksum is right.

## Consequences

- One build serves every channel, and a Node or Bun call that sneaks into the portable layer fails lint and type checking before it fails in production.
- A real-runtime failure that neither gate sees (for example a Web API Workers lacks) still waits for the phase 5 smoke test.
- Zod's parsers run interpreted, which costs some speed on a file of a few users and nothing a test would notice.
- The JSON Schema is looser than the loader (it cannot express the refinements), so an editor can accept a file that fails to load; the load error says why and where.
- Two sources of truth are avoided, but a generated file is committed and has to be regenerated with `bun run schema` whenever the Zod source changes.
- A minted iD might collide with a real one if ORCID extends its `0009` assignments beyond 0009-0010-0000-0000, and a client that enforces ORCID's exact ranges would reject a minted iD; no such client is known, and fixture iDs can use any block.
- The `0009-9` prefix makes a mock iD recognizable at a glance, which is useful when one leaks into a log.

## Alternatives considered

- **Ajv with a hand-written JSON Schema as the source:** compiles validators with `new Function`, which Workers forbid, and leaves two descriptions to keep in step.
- **`bun build --target=browser` as the portability gate:** passes code that uses `Bun.*` and stubs `node:fs` instead of failing, so it proves nothing.
- **Enabling `nodejs_compat` and policing nothing:** couples the Worker build to a compatibility flag and lets Node-only code accumulate unnoticed until a Worker feature is missing.
- **Minting inside ORCID's live block (0000-0001-5000-0007 to 0000-0003-5000-0001):** collides with real people's iDs, which is the failure a mock must avoid.
- **Minting in ISNI space outside the `0009` prefix:** ISNI assigns those numbers to real identities, so they can belong to a real person today.
- **Random minting with `crypto.getRandomValues`:** a Worker may not draw random values at module scope, and a fixture would get different iDs on every load, which breaks tests that assert on them.

## Receipts

- ORCID, "Structure of the ORCID Identifier" (the ranges and the check-character algorithm): https://support.orcid.org/hc/en-us/articles/360006897674-Structure-of-the-ORCID-Identifier
- cyrb53, public domain, by bryc: https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js
- `src/orcid-id.ts`, `src/fixtures/schema.ts`, `tsconfig.portable.json`, and `biome.json` implement this decision; the portability gate was proven locally by importing `node:fs` and using `Bun`, `process`, and `Buffer` in a portable module, which failed both Biome and the portable type check.
