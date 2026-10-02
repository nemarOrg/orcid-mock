# Project Memory Index

List each durable observation here so an agent can discover the relevant entry
without loading every file. Keep the hook to one line and update it when the
entry changes.

| Entry | Type | Revalidate after | Hook |
| --- | --- | --- | --- |
| [bun-byte-bodies-get-octet-stream](bun-byte-bodies-get-octet-stream.md) | observation | 2027-01-02 | Bun adds Content-Type application/octet-stream to byte bodies; a ReadableStream body sends none |
| [coverage-ignores-child-processes](coverage-ignores-child-processes.md) | observation | 2027-01-02 | bun test --coverage only measures the test process, so code run in a spawned server reads as uncovered |
| [miniflare5-dispatchfetch-under-bun](miniflare5-dispatchfetch-under-bun.md) | observation | 2026-12-02 | Miniflare 5 alpha's dispatchFetch fails under Bun; the Worker test pins Wrangler 4.116.0 and stable Miniflare 4 |
| [never-pkill-by-pattern](never-pkill-by-pattern.md) | observation | 2027-04-02 | Parallel worktrees run their own orcid-mock servers; killing by name or pattern breaks other agents' test runs |
| [playwright-runner-and-ts-packages](playwright-runner-and-ts-packages.md) | observation | 2027-01-02 | Playwright's runner works under Bun, but Node cannot load TypeScript from node_modules, so the Node helper ships compiled JavaScript |
| [update-rules-expected-drift](update-rules-expected-drift.md) | observation | 2026-11-01 | What project-diff-rules reports here that is intended, so an update-rules run can skip it |
