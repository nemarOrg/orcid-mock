---
name: pkill-by-pattern-kills-other-worktrees
description: Parallel worktrees run their own orcid-mock servers, so a cleanup by name or pattern also kills other worktrees' test servers
type: observation
recorded: 2026-10-02
revalidate_after: 2027-04-02
---

During epic #1 up to three phase worktrees ran test suites at once, each spawning `bun src/main.ts serve` and Docker containers.
One cleanup with `pkill -f src/main.ts` killed another worktree's server mid-run and produced a one-off failure there.
The harness and the helpers record the process IDs and container IDs they start, so a cleanup by those IDs leaves other worktrees alone.
