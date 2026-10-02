---
name: playwright-runner-and-ts-packages
description: Playwright's runner works under Bun, but Node cannot load TypeScript from node_modules, so the Node helper ships compiled JavaScript
type: observation
recorded: 2026-10-02
revalidate_after: 2027-01-02
---

`@playwright/test` 1.63 runs under Bun 1.4.2 with `bun --bun x playwright test`, and under Node for test files inside a repository.
Node refuses to strip types from files under `node_modules`, so a published package that ships `.ts` sources (as the server package does, for Bun) cannot be loaded by a Node-run Playwright suite.
That is why `@nemarorg/orcid-mock-testing` builds JavaScript and declarations before publishing, and why a test loads the packed package under Node.
