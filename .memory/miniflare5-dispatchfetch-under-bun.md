---
name: miniflare5-dispatchfetch-under-bun
description: Miniflare 5 alpha's dispatchFetch fails under Bun; the Worker test pins Wrangler 4.116.0 and stable Miniflare 4
type: observation
recorded: 2026-10-02
revalidate_after: 2026-12-02
---

`tests/worker.test.ts` runs the bundled Worker in workerd through Miniflare.
Wrangler 4.117 and later pin the Miniflare 5 alpha, whose `dispatchFetch` does not work under Bun 1.4.2; the repository therefore pins Wrangler 4.116.0 and Miniflare 4.20260730.0, whose `dispatchFetch` works under Bun (see the header comment in `tests/worker.test.ts`).
Bumping Wrangler past 4.116.0 moves the Worker test onto the Miniflare 5 alpha.
Observed by the phase 5 implementer of epic #1 and recorded in the test's header comment; not reproduced independently.
