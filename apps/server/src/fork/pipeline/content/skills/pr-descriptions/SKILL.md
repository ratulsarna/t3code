---
name: pr-descriptions
description: Apply whenever writing or editing a PR title or description. Keeps them short and reviewer-facing.
---

# PR descriptions

A PR description tells a reviewer what the diff does and why, in under ~15
lines. It is not a project report.

Write one short line per point, never a paragraph block:

- Why the change exists (link the issue).
- What changed in behavior.
- How it was verified: command and result.

A non-obvious decision earns one line only if the reviewer would otherwise
ask about it in the diff.

For example:

```
Fixes #482 - drop the duplicate wallet cache write

The reclaim path wrote the wallet cache twice on fresh installs.
Repro'd with the app-reclaim test; single write now.
```

Never include: review rounds, bot verdicts, findings fixed along the way,
rejected alternatives, implementation ledgers, residual-risk essays, or
per-commit archaeology. That's the story of the work, not the change.

If a section header feels needed, the description is too long.
