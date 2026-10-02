# Architecture Decision Records

Architecture Decision Records (ADRs) capture significant decisions that shape the project: choice of stack, structural patterns, trade-offs accepted, alternatives rejected. Tuck them all in here so they are easy to find later.

## Convention

- One file per decision: `NNNN-short-kebab-title.md`, zero-padded to four digits.
- `0000-template.md` is the template; copy it to start a new ADR. Do not edit `0000-template.md` itself.
- Number sequentially. The next ADR after `0007-...` is `0008-...`.
- Status flows `proposed` -> `accepted` -> (later) `superseded by ADR-NNNN`. Never delete an ADR; supersede it.
- Keep each ADR short. If it grows past two screens, you are probably writing a design doc, not a decision.

## When to write an ADR

Write one when a decision:
- Will be hard or expensive to reverse.
- Cuts off other reasonable paths a future contributor might wonder about.
- Has been argued about more than once.
- Embeds a constraint (legal, performance, schedule) that is not obvious from the code.

Do not write one for routine choices that are obvious from reading the code.

## Index

Add new entries here as you create ADRs:

- [ADR 0001](0001-build-in-bun-on-a-portable-fetch-layer.md): build the mock in Bun on a portable fetch layer, in memory
- [ADR 0002](0002-portable-layer.md): the portable layer's Web-APIs-only rule, its enforcement gates, and all state in the Store
- [ADR 0003](0003-fixture-schema-and-id-minting.md): Zod as the fixture schema source, the generated JSON Schema, and the `0009-9` mint block

- ADR 0000 - template (do not edit)
