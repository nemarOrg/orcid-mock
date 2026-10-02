# ADR 0002: Portable layer, enforcement gates, and state in the Store

**Status:** accepted
**Date:** 2026-10-01
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0001 commits to one codebase that runs as a Bun process, a container, a Cloudflare Worker, and later a hosted multi-tenant service.
Workers expose Web APIs, not Node's.
Without the `nodejs_compat` flag a `node:*` import fails at deploy time, and a Worker may not draw random values, make requests, or generate code from strings (`eval`, `new Function`) while a module is being evaluated.
The hosted mode also needs a tenant boundary that does not force a rewrite of the routes.

## Decision

**A portable layer, Web APIs only.**
The portable layer is `src/app.ts` and everything it imports, including `src/bootstrap.ts`, the composition root that turns a users file into an app and its store.
It uses the standard `fetch` types, `crypto`, `structuredClone`, and `URL`, and never `Bun`, `process`, `Buffer`, `require`, `__dirname`, or a `node:*` or `bun:*` import.
We do not turn on `nodejs_compat`.
Bun-only code is `src/server.ts` and `src/main.ts`, which bind the socket, read files, parse the command line, and handle signals.

**Three gates enforce it, all in CI.**
`tsconfig.portable.json` type-checks every file under `src/` except those two with `types: []` and `lib: ["ES2023", "WebWorker"]`, so any Bun or Node name is a compile error, and a new portable file is covered the day it is added.
Biome's `noRestrictedImports` and `noRestrictedGlobals` forbid the same names across `src/**` except the two Bun files.
A tripwire test replaces `crypto.getRandomValues`, `crypto.randomUUID`, `fetch`, and `Function` with versions that throw, imports every portable module in a child process, and fails on any call, which is what Workers do at module scope; a second case proves the trap is armed.
A `bun build --target=browser` gate was checked and rejected: it silently stubs `node:fs` and passes `Bun.*` through, so it passes code that Workers would reject.
A real-runtime smoke test (a Worker entry, `wrangler deploy --dry-run`, one Miniflare request) is phase 5's job.

**All mutable state lives in the `Store`, and one `Store` is one tenant.**
No module or process variable holds state, and no `Store` method takes a tenant id.
In the hosted mode the Hono app runs inside the tenant's Durable Object, and the Worker only routes.
Every check-then-write is one `Store` method (`consumeCode`, `rotateRefresh`, `putSigningKeyIfAbsent`) so that a second implementation can make it atomic, and a contract suite (`tests/helpers/store-contract.ts`) lets any implementation prove it.

## Consequences

- One build serves every channel, and a Node or Bun call that sneaks into the portable layer fails lint and type checking before it fails in production.
- A failure that none of the gates sees (a Web API Workers lacks, say) still waits for the phase 5 smoke test.
- A router mounted at the root (`oidcRoutes()`) must declare full paths and never use wildcard middleware, or that middleware would run for the record API too; a comment on the router and on the mounts says so.
- The hosted mode needs a second `Store` and a tenant router, and nothing else in the routes changes.

## Alternatives considered

- **Enabling `nodejs_compat` and policing nothing:** couples the Worker build to a compatibility flag and lets Node-only code accumulate unnoticed until a Worker feature is missing.
- **`bun build --target=browser` as the portability gate:** passes code that uses `Bun.*` and stubs `node:fs` instead of failing, so it proves nothing.
- **State in module variables with a tenant map:** simple at first, but every route would have to look up its tenant, and the Durable Object model already gives one object per tenant.

## Receipts

- `tsconfig.portable.json`, `biome.json`, `tests/portable-tripwire.test.ts`, `src/bootstrap.ts`, and `src/store/types.ts` implement this decision.
- The type and lint gates were proven locally by importing `node:fs` and using `Bun`, `process`, and `Buffer` in a portable module, which failed both.
