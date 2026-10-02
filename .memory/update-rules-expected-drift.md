---
name: update-rules-expected-drift
description: What project-diff-rules reports here that is intended, so an update-rules run can skip it
type: observation
recorded: 2026-10-02
revalidate_after: 2026-11-01
---

Running `project-diff-rules project` from the research-skills 0.10.0 project plugin reports seven items here that are intended and need no action:

- `RULE_CHANGED=testing.md`: the only difference is the six-line preamble at the top.
  It explains that this project is itself a test double for the Open Researcher and Contributor ID (ORCID) service, yet its own tests still drive the real server over HTTP,
  names the exceptions, and names `bun:test` and pytest as this project's frameworks in place of the template's `vitest` or `jest`.
  The template body below it is unchanged; the template has no preamble, so accepting it wholesale removes it.
- `RULE_CHANGED=documentation.md` and `RULE_CHANGED=self_improve.md`: each has a one-line project note after its title and is otherwise the template.
  The first says this repository has no docs site (the README and `.context/` are the documentation), and the second says learnings go to `.memory/` and the decision records, not to `.context/scratch_history.md`.
  Accepting the template drops the notes, and the rest of each file then contradicts this project again.
- `RULE_CUSTOM=javascript.md`: project-written, with no template counterpart (Biome only, this repository's tree, `parseArgs`, `fetch`).
- `RULE_MISSING=python.md`: not adopted although the repository now has Python, the Python helper under `clients/python`.
  Its tooling is in `AGENTS.md` and its own `pyproject.toml`, and the template's rule would contradict it on the line length (88 against 100).
  Adopt the template with that one override if more Python arrives.
- `RULE_MISSING=serena_mcp.md`: not adopted on 2026-10-01; the Serena Model Context Protocol (MCP) server is not part of the workflow here.
- `MEMORY_FILE_CHANGED=INDEX.md`: the index lists this repository's entries, so it differs from the empty template by design.
  The template INDEX has no rows, so accepting it would drop every entry.

`.memory/README.md` is a verbatim template copy and reports `MEMORY_FILE_CURRENT`,
which is why it keeps the template's hard wrapping instead of this repository's semantic line breaks;
reflowing it would make the tool report it as changed.
The `AGENTS.md` comparison always lists template sections that file does not have (Architecture Map, Quick Commands, and others);
`AGENTS.md` here is deliberately condensed, and only the "Project memory" section was adopted.

Verified by running the script on 2026-10-02.
Stale when the plugin version changes or when any of these files is edited.
