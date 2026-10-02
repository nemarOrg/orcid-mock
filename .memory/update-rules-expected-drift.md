---
name: update-rules-expected-drift
description: What project-diff-rules reports here that is intended, so an update-rules run can skip it
type: observation
recorded: 2026-10-01
revalidate_after: 2026-11-01
---

Running `project-diff-rules project` from the research-skills 0.10.0 project plugin reports five items here that are intended and need no action:

- `RULE_CHANGED=testing.md`: the only difference is the three-line preamble at the top,
  explaining that this project is itself a test double for the Open Researcher and Contributor ID (ORCID) service,
  yet its own tests still drive the real server over HTTP.
  The template body below it is unchanged; the template has no preamble, so accepting it wholesale removes it.
- `RULE_CUSTOM=javascript.md`: project-written, with no template counterpart.
- `RULE_MISSING=python.md`: the repository is Bun and TypeScript only.
- `RULE_MISSING=serena_mcp.md`: not adopted on 2026-10-01; the Serena MCP server is not part of the workflow here.
- `MEMORY_FILE_CHANGED=INDEX.md`: the index lists this repository's entries, so it differs from the empty template by design.
  The template INDEX has no rows, so accepting it would drop every entry.

`.memory/README.md` is a verbatim template copy and reports `MEMORY_FILE_CURRENT`,
which is why it keeps the template's hard wrapping instead of this repository's semantic line breaks;
reflowing it would make the tool report it as changed.
The `AGENTS.md` comparison always lists template sections that file does not have (Architecture Map, Quick Commands, and others);
`AGENTS.md` here is deliberately condensed, and only the "Project memory" section was adopted.

Verified by running the script on 2026-10-01.
Stale when the plugin version changes or when any of these files is edited.
