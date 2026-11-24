---
name: issue-descriptions
description: Apply whenever writing or editing an issue or ticket on any tracker. Keeps it to what the task must do for the user, like a product ticket.
---

# Issue descriptions

An issue defines one problem, written like a product ticket: what the user needs and why. Whoever builds it reads the code and owns how, and how far the work reaches. Short lines, only the parts that apply:

- `Asked`, when you write the issue for someone else: their own words, quoted, with the proposal those words answered and where they were said.
- The problem or the goal, and who it affects.
- The user flow: where the user starts, what they do, and where they end up.
- The decisions already made, each as the rule its maker gave and with who made it. What you or a helper would add is put to them first, and stays out until they take it.
- The failure and edge cases that matter, and what the user sees in each.
- A neighbouring problem that has its own issue, as a link, when a reader would otherwise take it for part of this one.
- Links to the PRD, Figma, screenshots, or the parent issue. Reference them; do not restate them.

A bug says what is expected, what happens instead, and where. Say what "fixed" looks like when it is not obvious. Steps to reproduce help when known.

A parent issue holds the shared context and links, and lists its sub-issues. A sub-issue that needs another one first says `Blocked by #<n>`.

Leave out implementation and what a reading of the code found: files, classes, libraries, how many places a change touches and which, or how to structure the fix. Those belong to whoever builds it, who reads the code afresh.

Follow `no-ghosts`: the issue reads as written once, with no history of how it was worked out.

For example:

```
Riders can't see why a pass renewal failed.

Today a failed renewal shows a generic "Something went wrong" and returns to Home.
The rider should land back on the renewal screen with the reason and a retry.
- Payment declined: show the bank's reason when we have it.
- Pass no longer sold in the city: say so, and offer the passes that are.
Refunds for renewals charged twice are #812.
Design: <Figma link>
```

If a section header feels needed, the task should be split.
