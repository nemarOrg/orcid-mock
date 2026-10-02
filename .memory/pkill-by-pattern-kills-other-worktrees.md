---
name: never-pkill-by-pattern
description: Parallel worktrees run their own orcid-mock servers; killing by name or pattern breaks other agents' test runs
type: observation
recorded: 2026-10-02
revalidate_after: 2027-04-02
---

During epic #1 up to three phase worktrees ran test suites at once, each spawning `bun src/main.ts serve` and Docker containers.
One cleanup with `pkill -f src/main.ts` killed another worktree's server mid-run and produced a one-off failure there.
Stop only the process IDs and container IDs your own run started (the harness and the helpers already track them).
