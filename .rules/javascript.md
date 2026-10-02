# JavaScript/TypeScript Development Standards

Project-written for orcid-mock; it has no template counterpart, and the template's choices of formatter, command-line framework, and HTTP client do not apply here.

## Runtime & Environment
- **Runtime:** Bun, for everything, with native TypeScript.
  The Node helper ships compiled JavaScript and also runs on Node 22 and 24.
- **TypeScript:** Strict mode, plus `noUncheckedIndexedAccess`, `noImplicitOverride`, and `verbatimModuleSyntax` (see `tsconfig.json`).
- **Package manager:** bun, never npm or npx.
  Installed dependency versions in `package.json` are exact, and `bunfig.toml` refuses a package released in the last seven days.

## Code Style
- **Lint and format:** Biome only (`bun run lint` is `biome ci .`, and `bun run format` writes the fixes).
  No ESLint and no Prettier.
- **Line length:** 100 characters, two-space indent, double quotes, semicolons.
- **Imports:** Organized by Biome, ES modules only.

## Project Structure (this repository)
```
orcid-mock/
├── src/
│   ├── app.ts          # the Hono app, portable layer
│   ├── bootstrap.ts    # composition root: a users file in, an app and its store out
│   ├── oauth/ oidc/ record/ routes/ store/ fixtures/
│   ├── main.ts         # command-line entry, Bun only
│   ├── server.ts       # Bun.serve binding, Bun only
│   └── worker.ts       # Cloudflare Worker entry, a portability smoke test
├── tests/              # bun:test against the real server
├── conformance/        # one suite for the mock and ORCID's sandbox
├── scripts/            # binary build, floating tags, starter file writer
├── fixtures/           # users JSON Schema and the starter users
├── clients/node/       # the Node helper: its own package.json, lockfile, and Biome
├── clients/python/     # the Python helper: uv, Ruff, Ty, pytest
├── package.json        # server manifest
├── tsconfig.json       # type checking
├── tsconfig.portable.json  # the portable layer, Web APIs only
└── biome.json          # lint and format
```

## Portable Layer
- Everything under `src/` except `main.ts` and `server.ts` uses Web APIs only (ADR 0002): no `Bun`, `process`, `Buffer`, `require`, or `node:` and `bun:` imports.
- Biome (`noRestrictedImports`, `noRestrictedGlobals`) and `tsconfig.portable.json` enforce it, so a violation fails lint and type checking.

## Command Line and HTTP
- **Arguments:** `node:util` `parseArgs` (`src/main.ts`); no Commander.js and no Yargs.
  There are no interactive prompts.
- **Server:** Hono on the standard `fetch` interface.
- **HTTP clients:** Native `fetch` (the Node helper uses `node:http` where it must ignore proxy variables); no Axios.
- **Validation:** Zod, which is also the source of the generated JSON Schema (`bun run schema`).

## Common Patterns
- **Async/Await:** For all async operations
- **Error Handling:** Typed error classes where code throws (`ConfigError`, `FixtureError`), and ORCID-shaped bodies built in `src/errors.ts` where a route answers; no stack trace or exception message ever reaches a response body
- **Configuration:** Environment variables and flags, a flag winning
- **Logging:** One JSON object per line on stderr, with levels

## Testing (with bun:test)
```typescript
import { test, expect, describe } from "bun:test";

describe("myFunction", () => {
  test("handles valid input", () => {
    const result = myFunction(validInput);
    expect(result).toBe(expected);
  });
});
```

## Type Safety
```typescript
// Always define explicit types for public APIs
interface Config {
  apiKey: string;
  baseUrl: string;
  timeout?: number;
}

// Use type guards for runtime validation
function isValidConfig(obj: unknown): obj is Config {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "apiKey" in obj &&
    "baseUrl" in obj
  );
}
```

---
*Use bun for development. Real tests only. Strict TypeScript.*
