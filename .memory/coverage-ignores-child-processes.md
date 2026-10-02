---
name: coverage-ignores-child-processes
description: bun test --coverage only measures the test process, so code run in a spawned server reads as uncovered
type: observation
recorded: 2026-10-02
revalidate_after: 2027-01-02
---

`bun test --coverage` (Bun 1.4.2) instruments only the test runner's own process.
Code that runs inside a child process (the command-line tests start `bun src/main.ts` through `spawnMain` in `tests/harness.ts`) is never counted: `src/main.ts` does not appear in the report at all, and `src/server.ts` and `src/log.ts` read as partly covered although tests exercise them.
That is why route tests start the real server in-process through `tests/harness.ts` (`startServer({ port: 0 })`), and only the command-line tests spawn the binary.
Verified while building phase 1 of epic #1; stale if a Bun release adds child-process coverage.
