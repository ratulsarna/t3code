---
name: explore
description: "Settle what a feature, task or bug needs with the user, then write it up as GitHub issues and Pipeline cards."
---

# Explore

Settle the problem with the user: the requirements, the product decisions, the user flows, and the failure and edge cases that matter. How to build it belongs to each card's lead, who reads the code afresh; an issue hands the lead the problem and the user's decisions; it sets no scope and nothing to build to the letter.

## 1. Say it back

Run `/in-your-own-words` (Codex: `$in-your-own-words`) and name the project whose code it touches (`t3 project list`). Ask first only what you cannot research without.

## 2. Read what exists

Read what the task already has: the code, and any Figma, screenshots, team PRDs, tickets or other resources the user points to. Read to understand the problem; how many places a change would touch, and which, is the lead's to find in the code. Split the reading into questions and send them to child threads in parallel:

- the code: how the relevant behavior works today, with file:line;
- outside: how other apps behave for the user and what the platform expects, from primary sources with links. Run these workers on a harness that can search the web.

Workers return facts with their sources. A worker's summary is a pointer: read what it points at before you build on it. Keep the facts with their sources in `~/.ai/artifacts/<project>/YYYY-MM-DD-<topic>/explore.md`.

## 3. Grill

Settle the requirements and product decisions with `/grill-me` (Codex: `$grill-me`): what the user does, what they see, and what happens when things fail. A question puts a choice to the user as a rule about the problem, without tallies of places in the code, and a fact goes in it only where it changes the decision. A decision is kept as the rule the user gave; what that rule covers in the code is for the lead to find. When a finding changes the task itself, reframe it with the user before the next round.

What goes beyond what the user asked, such as a case or a rule that you or a helper thought of, in the grilling or in a check of the drafts, is an extra. Put each one to the user in one line: what it adds, what it costs, and your recommendation. One the user does not take stays out of the issue.

Grilling also settles the split. A small task or a bug is one issue. A larger task is a parent issue with the shared context and links to the PRD and Figma, and one sub-issue per piece that can ship on its own, each named by the part of the problem it solves; how far a piece reaches in the code is its lead's to set. A piece that needs another one first says `Blocked by #<n>`.

## 4. Issues

Write each issue with `issue-descriptions`, opening with `Asked`, and show the drafts. Once the user approves them, create them in the project's GitHub repository, assigned to the Pipeline hub's GitHub account so Pipeline can import them, and attach each sub-issue to its parent. Write no issue when the user says not to; their cards carry the same text as notes.

## 5. Cards

Ask for the machine (`t3_environment_links`), the mode (manual, auto, or full auto), the size (small or standard), and whether to start now. Import the issues and set each card's mode and size. Start only the cards nobody is blocked on; the rest wait in Backlog.

```sh
t3 pipeline import-issues <number>... --project <project-id>
t3 pipeline set <card-id> --mode <mode> --size <size>
t3 pipeline start <card-id> --machine <machine>
```

When `explore.md` holds outside sources a lead would otherwise look up again, post them as a comment on the issue; the card's snapshot carries comments to the lead. What you read in the code stays in `explore.md`. Without issues, add each card with `t3 pipeline add`, the issue text as `--body`, and those sources as an attachment.
