---
name: pair-review
description: Run code review passes on a diff, using two configured reviewers, each a fresh session that sees only the shared review prompt and the diff scope, plus shape and comment passes when a workflow asks for them. Use when a workflow or the user asks for a code review pass.
---

# Pair review

A full review is two independent passes, Reviewer 1 and Reviewer 2. A workflow may ask for one pass; then run only that one. A workflow may also ask for a shape pass, which uses Shape, and a comment pass, which uses Comment and judges only the comments the diff adds or changes. Every file named here sits in this skill's directory, written `<skill>` below.

On a Pipeline card whose instructions use `t3 pipeline review start`, use that command for each pass. Pipeline picks the models and scope, starts the threads, and records their results. If Git cannot be read or a reviewer cannot be spawned, use the standalone instructions below. After a spawn failure, first run `t3 pipeline review show`, use the results of threads that did start, and run only missing reviewers.

## The payload

Every bug pass gets the output of `bash <skill>/render-review-prompt '<diff scope>' --settled <settled file>` and nothing else: no ticket or plan. The settled file contains the card's concerns closed without a fix, one per line, or `none`. On a card whose pinned workflow uses an out-of-scope file, use `bash <skill>/render-review-prompt '<diff scope>' [<out-of-scope file>]`; that file names gaps moved into their own issues. A shape pass gets `bash <skill>/render-shape-prompt '<diff scope>' <plan path> '<ticket>' <guidelines path>` and nothing else. A comment pass gets `bash <skill>/render-comment-prompt '<diff scope>' <guidelines path>` and nothing else. Write each to its own file. Send it as written, as a plain prompt: never a harness's own review command, which brings its own review rules.

A fix plan check reads a plan for a fix before it is built, and runs only through `t3 pipeline fix-plan check`: Pipeline gives Reviewer 1 `fix-plan-prompt.txt`, the guidelines, the diff scope, and the plan. Its report is advice to the lead. It has no standalone form.

## The models

The Review models table in your instructions names each pass's harness, model, reasoning, and service tier when one is set. Pipeline adds it when a thread starts. Use it for the whole round. With no table, or a table that says the settings could not be read, stop and ask. Before launching, check the harness, the model, and a non-default service tier with `orchestrator_capabilities` on the environment where the reviewer will run. The listing names non-default tiers only, so a saved `default` tier needs no check. If one is missing, stop and ask. Never swap one in.

## Run each pass

    Call delegate_task in this thread with the chosen model selection, full access,
    title "<pass> review", and the rendered prompt as its brief. Omit the target
    environment to run on this machine.

The table's Reasoning cell reads `<level>` or `<level>, <tier> tier`. Pass the catalog’s reasoning and service tier options in the model selection. Every pass is a new thread, every round: never fork, and never send a pass to an earlier reviewer. T3 wakes this thread when a child finishes; read it with `t3_thread_read`.

## Independence

Keep the passes apart until all return. No reviewer sees another's findings.
