---
name: pipeline
disable-model-invocation: true
description: "Work the pipeline board: add, import GitHub issues, start, list, show, move, pause, and resume tasks. Specify a machine; optionally choose the lead's model and reasoning. Upload attachments first."
---

# Pipeline: Board

Every task is a card on the pipeline board: a title, a note, a machine, attachments, and a column. The columns, in order: `backlog`, `todo`, `planning`, `plan_ready`, `implementing`, `reviewing`, `qa`, `pr`, `pr_ready`, `done`. Adding a card saves it in Backlog. Pass `--start` to place it in To do and launch its lead. A saved task creates no thread or queued message until explicitly started.

## Commands

- `t3 pipeline instructions [overview|plan|implement|debug|close-out] [--file <relative-path>] [--card <id>]` — read the workflow document or phase template when working on a Pipeline task.
- `t3 pipeline instructions kickoff --file <name.md> [--card <id>]` — read a kickoff template or shared prompt fragment.
- `t3 pipeline instructions guidelines [--card <id>]` — print the guidelines every role builds to: Pipeline's own, or the file and section chosen in Settings.

- `t3 pipeline add --title <t> --machine <id-or-name> [--start] [--body <text>] [--attachment <uploaded-path>]... [--mode <manual|auto|full-auto>] [--size <small|standard>] [--shape <on|off>] [--coordinator <thread-id|self>] [--project <id>]` — create a card on the explicitly chosen machine. `--project` defaults to the current project. Mode, size, shape review, and coordinator are the user's call; omit them unless the user names them. `--coordinator self` makes the calling thread, which must be top-level and not a Pipeline lead, the card's coordinator: the lead runs as its child and it answers the lead's gates for the user. Archiving or deleting the coordinator archives or deletes the lead too; run `t3 pipeline set <card-id> --coordinator none` first.
- `t3 pipeline start <card-id> [--machine <id-or-name>] [execution overrides]` — start the lead for a saved task using its stored machine, models, notes, and attachments; the flags accept the same machine and execution overrides as `add`. Repeated Start requests do not launch again; use Retry after a failed start.
- `t3 pipeline set-machine <card-id> --machine <id-or-name>` — assign a machine to a card that has none. An assigned machine cannot be changed.
- `t3 pipeline set <card-id> [--mode <manual|auto|full-auto>] [--size <small|standard>] [--shape <on|off>] [--coordinator <thread-id|self|none>]` — change a card's mode, size, shape review, or coordinator for the user. A new coordinator becomes the running lead's parent. A running lead is told and follows the new setting from its next stop or gate.
- `t3 pipeline list [--project <id>] [--all]` — the board's cards; `done` is hidden unless `--all`.
- `t3 pipeline issues [--project <id>] [--page <n>]` — the project's open GitHub issues assigned to the Pipeline hub's account, page by page, each with the card it is imported to, if any.
- `t3 pipeline import-issues <number>... [--project <id>]` — import issues as Backlog cards carrying the full issue snapshot; up to 50 per call, and an already-imported issue returns its existing card.
- `t3 pipeline show <card-id>` — the card, its history, and its threads.
- `t3 pipeline queue [--project <id>]` — running and waiting tasks by machine, including each wait reason and the selected next task.
- `t3 pipeline models` — the saved subagent and review models as JSON, read from the Pipeline hub.
- `t3 pipeline review set --review <full|light> --reason <text>` — record the plan's review depth, or upgrade light to full.
- `t3 pipeline review start --kind <full|fix-check|shape|comment> [--plan <path>] [--settled <text>]` — start the pass in the lead's environment; shape requires the plan path. A full review or fix check takes the settled list as text, or `none`, when the card's Implement instructions name `--settled`.
- `t3 pipeline review show [<pass>]` — review passes, outputs, open totals, waivers, and warnings.
- `t3 pipeline review settle <pass> --open <n> [--note <text>]` — record how many required items remain open in the ledger, including earlier findings.
- `t3 pipeline review out-of-scope add <line> --issue <number>` — record a filed, out-of-scope concern for later review prompts, on a card whose Implement instructions name this command. A card with a settled list passes such a concern in `--settled`.
- `t3 pipeline review waive --reason <text>` — record a permitted skip for the current clean commit.
- `t3 pipeline fix-plan check --plan <text>` — start a fresh checker on a fix plan, passed as text: `--plan "$(cat <file>)"`. Its report lists the holes it found; the lead decides what to take and sends the plan itself.
- `t3 pipeline report --stage <walkthrough|close-out>` — mark the stage and check review coverage; reporting QA checks it too.
- `t3 pipeline run-next <card-id>` — favor this waiting task when a slot opens on its project and machine.
- `t3 pipeline run-next <card-id> --clear` — clear that selection if it is still current.
- `t3 pipeline github-sync <card-id>` — refresh the linked PR, checks, and review status; retry an unknown review classification.
- `t3 pipeline review-wait [--card <id>] [--handled <batch-id>]` — hand off external review from the owning lead. It posts the project's request once per revision; an empty `reviewRequestComment` uses automatic reviews, and a project set to no external review posts nothing and goes straight to the user's merge decision. End the turn after the command succeeds.
- `t3 pipeline review-retry <card-id>` — retry a cancelled or failed review follow-up. Check the lead first if delivery was unconfirmed.
- `t3 pipeline retry <card-id>` — retry a failed or cancelled kickoff. A cancelled kickoff uses its existing thread and waits for capacity.
- `t3 pipeline pause <card-id>` — ask the lead to pause gracefully and hold new work.
- `t3 pipeline resume <card-id>` — continue a Paused task through the normal capacity gate.
- `t3 pipeline stop <card-id>` — hard-stop the task and occupied descendants; use when graceful pause cannot finish.
- `t3 pipeline move <card-id> <column>` — move a card by hand. Pipeline moves a started card to Planning itself once its lead starts.

Use `add` to capture a task for later. Start it before moving stages, pausing, stopping, or resuming; saved tasks can be removed without starting. Start puts the task in To do; a started task cannot return to Backlog. The UI offers **Save** and **Save and start**, and a saved card can be dragged to To do to start it.

An interrupted Start recovers an existing lead thread when found, or exposes Retry. Use `retry` on that card instead of adding another task.

The machine must be explicitly specified for every new card; never infer it from the current thread or choose the first available machine. Use `t3_environment_links` to find machine IDs and names, and ask the user when their target is unknown. The project must have a checkout on that machine. The lead and its retries use the card's stored machine, each launch in its own managed worktree from that checkout. A missing checkout is recoverable with `t3 pipeline retry <card-id>`.

### Lead choices

`add` accepts optional `--lead-provider <id>`, `--lead-model <id>`, and `--lead-reasoning <level>`.

For providers that support service tiers, use `--lead-service-tier <default|fast>`.

Omit these unless the user requests a change. Omitted fields use Pipeline's remembered settings, shared with the New task UI. An accepted task remembers the resolved choices for the next task when `rememberExecution` is enabled (the default). Each card saves its own choice for its lead and retries; changing defaults does not change existing cards. `show` includes the saved selection.

Discover providers and their models on the chosen machine with `orchestrator_capabilities` scoped to that environment before choosing new IDs or reasoning levels. Specify the matching model when switching providers.

```sh
t3 pipeline add --title "Improve startup" --machine <id-or-name> \
  --lead-provider codex --lead-model gpt-5.6-sol --lead-reasoning high
```

When spawning workers for a card, use `--parent-self` so they belong to the task, and use its existing environment or explicitly select its stored machine for a new environment.

### Imported issues

An imported card works from a GitHub issue the user picked. The card carries the full snapshot (title, body, labels, comments) and the source link. The issue is read-only input: change it only when the user asks, and ask before each change. Mode and size live on the card.

Start behaves like any card: an imported card missing a machine or lead choice asks for them before launching. The snapshot refreshes on import, at start, and through **Refresh issue** in task details; `github-sync` stays PR-only and issues are not polled in the background. A closed or reassigned source keeps its card and shows its state.

Two Pipeline tasks can run at once per project and machine. A card's lead and its children share one slot until their running work, tracked background work, and active autonomous goals stop. Further starts, replies, and retries queue automatically when both slots are occupied. Use `t3 pipeline queue` to read the occupants and wait reasons before choosing a card with `run-next`. The saved choice applies only to that project and machine, replaces an earlier choice there, and does not interrupt running work. It clears when the task starts. A nominee blocked for another reason does not prevent eligible work from running. `list` and `show` expose `queued`, `waitingReasons`, and `runNext` with `--json`. Send now cannot bypass the limit. Ordinary BB threads are outside it.

```sh
t3 pipeline queue --project <project-id>
t3 pipeline run-next <card-id>
t3 pipeline run-next <card-id> --clear
```

Run next is a preference, not a start-order guarantee: concurrent queue claims can let another task start first. Priority waits are bounded so a blocked nominee cannot stall the queue.

The card tracks state only. Put questions, explanations, options, walkthroughs, and approval requests in the lead's user-facing chat, where the user replies. `t3 pipeline report --needs-you <reason>` records a short waiting reason and sends an alert through Notify when attention begins; it does not post a chat message or collect an answer. Use `--working` when that blocker clears. Repeated attention reports do not resend the alert. Notify must be installed and enabled; its foreground and sound preferences apply. Pipeline also alerts for confirmed lead attention, failures, and pending questions or approvals on the lead's thread. Do not send an extra notification for the same blocker.

## External PR review

Link one PR with `report --pr <url>`. Pipeline reads GitHub status and uses Jev to classify new review text from bots or humans. A feedback batch is delivered to the existing lead through T3’s queue, respecting capacity and pause. Read `t3 pipeline instructions close-out` and follow its feedback process when handling it. Acknowledge the exact batch with `review-wait --handled <batch-id>` after triage; every executable fix returns through the review loop, and material changes reopen the walkthrough and QA.

Awaiting review is an expected idle state. End the turn and pause or finish any autonomous goal instead of polling GitHub. Clean or answered review surfaces the user's merge decision. CI is displayed but is not a handoff requirement. Sync marks merged tasks Done; other GitHub changes do not move stages or reopen completed tasks. Remaining runtime work retains its capacity slot and can be stopped from task details.

## Graceful pause

When you receive a Pipeline pause instruction, follow its request ID. Start no new task work. Bring running commands and existing workers to a safe stopping point, preserve files, and leave a concise handoff in the owning conversation. Use your provider's goal controls to pause any active autonomous goal. Existing task threads may coordinate shutdown while the card is Pause requested; new worker starts are held.

Once safe, the lead must run `t3 pipeline report --paused <request-id>` as its last action and end its turn. Workers cannot acknowledge for the lead. Do not report working or continue task work until the user resumes it. Pipeline checks the token and waits for all real task activity to end before showing Paused; acknowledgement alone does not free its capacity slot.

A pending question or offline machine can delay the instruction. Keep the task Pause requested rather than claiming it stopped. Stop now is available to the user as a fallback. Queued messages survive pause and stop; Resume releases them through the capacity gate and continues from the handoff. Task controls preserve the card's stage. Resume before moving or retrying a held card. Remove works in any state without resuming: it stops the task's threads, closes their background-job terminals, deletes its queued messages, and removes the card. Pipeline attention notifications are suppressed while held and for saved or Done cards.

## Attachments

Upload each file first, then pass the returned path to `t3 pipeline add --attachment`:

```
bb project attachment upload <projectId> --client-file <path>
```

## Settings

**Instructions** edits phase documents, role templates, kickoff wording, and Pipeline’s guidelines. Save or restore each document independently. Tasks pin their instructions before kickoff; saved edits apply to new tasks. `instructions` reads the owning task’s snapshot, or the current defaults and overrides outside a task; pass `--card <id>` to select a task explicitly.

The **Review models** section edits the `pair-review` harness, model, reasoning, and optional service tier choices for Reviewer 1, Reviewer 2, Shape, and Comment. Use its own Save button. It writes `~/.config/agent-models/config.json` on the Pipeline hub, respecting `XDG_CONFIG_HOME` and `AGENT_MODELS_CONFIG`. Pipeline adds the saved choices to every thread's instructions when the thread starts; missing files use shared defaults, and invalid files stop the review. These choices are stored separately from Pipeline’s settings.

Open Settings in the Pipeline header. `taskLimit` sets concurrent tasks per project and machine (1–32, default 2); lowering it holds new starts without stopping current work. `rememberExecution=false` keeps fixed lead defaults. `reviewRequestComment` is the review trigger text; an empty value uses automatic reviews. A project can override it in Settings (External reviews → Per project), including no external review. `guidelinesFile` (a `.md` file on the Pipeline hub, absolute or starting with `~/`) and `guidelinesSection` (a `##` heading) choose what `t3 pipeline instructions guidelines` prints; both empty means Pipeline's own document. `autoReviewFollowup=false` holds findings for user triage; Send to lead or `review-retry` explicitly releases a batch. Notifications are controlled by `notificationsEnabled`, `notifyQuestions`, `notifyFailures`, and `notifyReview`; Notify owns destinations and sound.
