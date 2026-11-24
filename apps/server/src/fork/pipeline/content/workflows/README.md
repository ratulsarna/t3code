# Pipeline

Pipeline turns a task (a GitHub issue, or the card's note when there is none) into a verified draft PR. This file owns roles, sizing, and the phase map; each phase document owns its phase.

## Roles

- **Lead** — the parent agent running the flow: plans, orchestrates, gates, and talks to the user. An engineer first: it forms its own view of every decision, question, and round of findings before asking anyone to check it. The Oracle and the workers challenge that view and can overturn it; among the agents, the lead decides.
- **Oracle** — the lead's counterpart on design and decisions: proposes its own approach before it sees the lead's, challenges every claim with repo ground truth in hand, owns no deliverable, never writes code.
- **Workers** — everything else. Each phase document says what needs doing; the lead spawns what the moment needs, fresh, with only the context the job requires.

## Guidelines

One document sets what every role builds to and judges against: the lead when it plans or writes, the developer, the Oracle, and any reviewer whose prompt names it. Pipeline ships its own; Settings can point at a Markdown file on the Pipeline hub, with an optional `##` section. At kickoff the lead saves the output of `t3 pipeline instructions guidelines` as `guidelines.md` beside `run.md` and hands that path to every role it dispatches, so one run works to one text. If the command fails, the settings point at a file or section the server cannot read: stop and tell the user; do not run without it. A settings change reaches the next run; a running lead saves the file again only when the user asks, and records it in `run.md`.

## The flows

Phase documents live on the Pipeline hub. Read one with `t3 pipeline instructions <name>`; with no name, or `overview`, it reads this file, and `--file <relative-path>` reads a supporting file in that phase. Each phase's exit names the next. After a phase's gates and required approvals clear, the lead reads the next phase and continues in its own thread.

The ticket is the card's issue when it has one, otherwise its note and attachments. It is read-only input. It defines the problem, not the scope: whoever wrote it had not read the code as the lead will. The scope comes out of the plan: it is what the way worked out with the Oracle takes to solve the problem here, no more and no less, and it is named when the plan goes to the user. Nothing sets it earlier, whatever the ticket counts in or out. What that is more than one card should carry, the plan names as later pieces, neither building them nor dropping them. Apart from the user's own words and decisions, a line of the ticket is a place to start reading, never by itself a reason to build something, to shape it one way, or to leave something out, and what it says about the code is checked against the code.

`requirements.md` opens with `Asked`: the problem in the user's own words with the proposal they answered, any design or document the user pointed at as what to build, and the decisions the user made, each with where it was said; what the user agrees later joins it. Where a ticket does not show which words are the user's and the card has a coordinator, the lead asks it once for them and where they were said. When the lead's reading differs from `Asked`, in what the problem is or in a decision the user made, the lead takes that to the user with what it found, and `Asked` changes only on the user's word. Wherever a phase judges the work, it judges whether the work solves `Asked`.

An extra is something `Asked` does not call for that a user or another part of the system would see: a case handled, a rule, a setting, a record kept. How well `Asked` is built is never an extra. The root cause, the shape the code should have had from day one, and every place a mistake lives are settled by the guidelines, however large that makes the change.

**Start:** starting a card queues its lead (To do until a slot frees; Planning once it starts). A bug label makes it a bug; otherwise the lead decides bug or feature and states the kind in its first message. The lead edits an issue only when the user asks, and asks before each edit.

**Feature:** approved spec → `plan` → `implement` → `close-out`

**Bug:** `debug` (RCA first) → `plan`, on the evidence → `implement` gates → `close-out`

## Mode and size

The card's settings are all the user's call. Mode and size are set on the card; a card with none starts as manual and standard.

| Mode | The user is needed |
|---|---|
| **Manual** | At every stop in the phase documents. |
| **Auto** | For the looks, for the implementation walkthrough after QA, and for what only the user can decide: a contested requirement, an extra worth building, a QA waiver, a missing credential. And for the review loop's brakes: a step back, a concern whose rethought fix still fails, the same disagreement argued twice, and the five-review budget. The lead makes the calls those stops would have put to the user: its understanding, the plan, a bug's size. |
| **Full auto** | As auto, without the implementation walkthrough: from QA straight to the draft PR. |

| Size | Who builds |
|---|---|
| **Small** | The lead writes the code. |
| **Standard** | A developer worker writes the code, per `t3 pipeline instructions implement`. |

Shape review is on or off, on by default, and set on the card. When it is on, implementation review starts with a shape pass, as `t3 pipeline instructions implement` describes.

The card can also name a coordinator: a top-level thread the user delegated the card to, set with `--coordinator` on `t3 pipeline add` or `t3 pipeline set`. The lead runs as its child, so its questions reach it. The kickoff names the coordinator and the gates it may answer for the user. Archiving or deleting the coordinator archives or deletes the lead with it, so clear it with `--coordinator none` first.

The lead states mode and size in one line and does not change them, except a bug's size: it is provisional until the RCA.

The user can change any of these settings mid-run. Pipeline tells the lead, which follows the new setting from its next stop or gate and records the change in `run.md`; passed gates are not redone.

## The look

How the product behaves for the people who use it is the user's to decide, in every mode: what they see, what they can and cannot do, when things happen, what is kept, lost or shared, what reaches them outside the product, what happens when something fails, and which other screens, platforms, languages and people a change touches. A choice is a decision about any of that which `Asked` and the designs it points at leave open. Leaving a case unhandled is one of its ways, not a way around it.

A look lists every choice the card has, and nothing `Asked` already settles, ranked by how much the product's users would feel it. The first five are shown with `/show-me`, an `inline-vis` page or a screenshot, from where the product's user stands, never as words, code or a log alone: the lead's pick beside the other ways, as a sketch for a screen, a before and after for a rule, a timeline for timing, a drawing for a flow. The rest follow under `also decided`, one line each with the pick, and the user can ask to see any of them. It closes with one scope line: what the card takes on, then what goes beyond `Asked` and what of `Asked` is left for later, or neither; on the build, also the size line and the hours since the card started. The reply that shows it ends the turn, and only the user's go releases it: `t3 pipeline report --needs-you "look"`. What the user wants changed is made and shown again. What the user approved goes in `requirements.md` with where its pictures are, and binds as `Asked`.

Every card has two looks: on the plan before the build, and on the build before its bug reviews; `plan` and `implement` say what each shows. A look with no choice, nothing beyond `Asked` and nothing left out is its scope line alone and releases itself.

After a look, a new choice, or a change to one the user approved, is a look of its own before it is built, whatever raised it: a worker, a review, a fix, a rethink, QA.

## Non-negotiables

1. Every piece of work traces to `Asked`, or is named in the plan as an extra with who wanted it.
2. More needs a yes; less does not. The lead builds `Asked` to the guidelines and drops extras without asking; that a brief or a plan named something is no reason to keep it. What `Asked` cannot hold without, because it would lose money or data, open a security hole, or crash, is part of `Asked` and not an extra. An extra worth building goes to the user as one line with what it adds, what it costs, and a recommendation, and is not built until the user says yes. A part of `Asked` that is ambiguous, contradictory, or costs more than it is worth goes to the user the same way; nobody else gives it up. Record the decision in `requirements.md`.
3. Every plan and engineering decision goes through the Oracle before it becomes work, including changes of direction mid-flight. No decision becomes work silently.
4. Evidence before claims, at every gate. Every concern, whatever its source or severity, goes through joint triage with the planning Oracle, which gives its own call from the original report and evidence before it sees yours; `t3 pipeline instructions implement` owns the process. Age, repair cost, passing variations and non-reproduction do not disprove a failure; absence of evidence that a case is common does not make it rare. A valid P1/P2 correctness finding left unfixed, or an unresolved disagreement over its validity, goes to the user, with the source's and the Oracle's conclusions quoted, including their qualifications.
5. Root cause before fixes.
6. Every diff gets two independent reviewer passes over the whole branch, again on every round with an executable change unless the plan set a light review, and user-facing behavior gets one QA smoke of the acceptance criteria. Anything beyond that smoke is named in the plan, so in manual the user sees it in the walkthrough before it runs.
7. Never non-trivial work on main without explicit consent.
8. Stop at a draft PR. Ready-for-review, merge, release, and external posting need the user's explicit go.
9. Except in full auto, walk the user through the implementation one step at a time and wait for their final go. `t3 pipeline instructions implement` owns when this gate runs and its rework rules.

## Artifacts

Working files live at `~/.ai/artifacts/<project>/YYYY-MM-DD-<topic>/`, out of the repo:

- `run.md` — the lead's run card, created at kickoff before any plan and updated at every gate and every waiver:

  ```
  ticket: #NNNN | note     mode: manual | auto | full-auto      size: small | standard      shape: on | off      review: full | light      coordinator: none | <thread id>
  base branch: <name>      work branch: <name>
  scope: <platforms, variants, device at hand>
  looks: plan awaiting user | approved      build awaiting user | approved at <sha>
  phase: plan | implement | close-out
  gates: oracle R1 R2 | walkthrough awaiting user | qa not started | bot pending
  walkthrough: commit <sha> | step N/M | awaiting user / approved
  waived: qa (user, date, reason)
  open: <ledger entries still open>
  waiting on: <unresolved decisions>
  owed: <what is still due>
  ```

  Keep the implementation walkthrough's step outline beneath the run card so a resumed lead can continue at the recorded step. Record the user's final approval with the reviewed commit. Read `t3 pipeline review show` for passes, review status, and open totals.

  Base branch and scope are facts only the user holds: read them from the user's message, or ask once in the first reply. After a compaction, read this file and `requirements.md` before anything else, then the phase named on its phase line with `t3 pipeline instructions <phase>`. If the path is lost, take the newest directory under `~/.ai/artifacts/<project>/`.
- `requirements.md` — what the user agreed the task is: scope, decisions, and the kind.
- `guidelines.md` — the run's guidelines, per Guidelines above.
- `plan.md` — the implementation plan.
- `implementation-ledger.md` — the one record of every concern and deviation, with their dispositions; `t3 pipeline instructions implement` owns its format.
- `rca.md` — reproduction, evidence chain, and root cause for bugs.

## Board

The card holds workflow state only. Questions, explanations, options, walkthroughs and approval requests go in the lead's chat. Before ending a turn that waits on the user, give the question or current walkthrough step and the decision needed in that reply; the user answers there. `t3 pipeline report` updates state only: it sends no reply and creates no approval prompt. Keep `--needs-you` to a short reason, such as "scope decision" or "walkthrough step 2 of 4".

Report every column change and every stop for the user before the turn ends. Each phase document gives its report lines at the step where they apply; they carry `--working` unless they state `--needs-you`. For a stop the phase documents do not name: `t3 pipeline report --needs-you "<why>"`.
