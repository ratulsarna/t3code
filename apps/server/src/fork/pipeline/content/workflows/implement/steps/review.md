# Starting a review pass

Read this before each shape, full or fix-check pass, on the commit the pass will review. Use the part that fits: the first review cycle, or fixes after the first full review, whatever their source. The last part holds for every pass. The settled list is defined in the manual, under the ledger.

## The first review cycle

- First, the repository's required checks pass on the landed change, with their output in hand. The developer's captured gate output counts when it covers the current tree; otherwise run them. A failing check goes back to the owning worker, and no reviewer starts until it passes. A check that says it is not set up on this machine and skips itself counts as passed, recorded as skipped.
- Then one size line from `git diff --stat` against the base: files, lines added and removed, production lines against test lines, new types or files. It goes in the close-out report. A change much larger than `Asked` and the extras the user said yes to need, or tests that outweigh the code they cover, is a step 3 trigger, whether or not the plan expected it.
- Set the review depth from the plan with `t3 pipeline review set --review full|light --reason "<why>"`. Check the T3 worktree’s base against the task’s base and correct it through T3’s worktree controls when needed.
- The kickoff names whether shape review is on; a later settings note updates it. `t3 pipeline show <card>` also shows `shapeReview`. When it is on, run `t3 pipeline review start --kind shape --plan <plan-path>`. Triage its findings (`steps/assess.md`) as their own batch, and have the owning worker make the required changes before the bug reviews. Redo the required checks and size line on the reshaped tree. Repeat shape only after a step 3 rethink, or when the setting turns on after bug review began.
- Then the second look (`t3 pipeline instructions overview`): one page of the choices the first look showed, as built, each as its screenshot, or as its picture redrawn from what a run showed; then anything that came out different from what the user approved, the `also decided` lines included. The developer's captures and runs count when they are of the current tree.
- Run `t3 pipeline review start --kind full --settled "<text>"` for the two independent bug reviews. Pipeline starts the configured reviewers with the pinned prompt and full-branch scope.

## Fixes after the first full review: the full re-review

Another round starts only when every required concern has a substantive fix attempt with relevant verification, or a completed disposition with its evidence. Inspect each attempt yourself against its plan: open every place, see that it does what its row says, and record what you saw for each mistake in the ledger's `attempts`. A worker's "fixed" is a claim, and a diff that matches the plan's wording is not the mistake gone. A round never reruns on unchanged code. Take the size line again first.

On a full review, the round is the full review, started as in the first review cycle. On a light review, it is a fix check: `t3 pipeline review start --kind fix-check --settled "<text>"`. A required finding goes to joint triage and a fix plan, and the new fix gets its own fix check. Fix checks do not count toward the five. A change that skips the full review skips the fix check too.

## Every pass

Keep passes independent until all return.
If `review start` fails because a reviewer cannot be spawned, run `t3 pipeline review show` to recover any threads that started. Use their results and run only missing reviewers by hand with `pair-review`. If Git cannot be read, use `pair-review` by hand. Keep the failure and manual results in the ledger. Pipeline cannot record the manual pass, so later checks warn that it has no recorded review. For Pipeline passes, read results with `t3 pipeline review show [<pass>]`.

Results, from a Pipeline pass or from reviewers run by hand, are assessed from `t3 pipeline instructions implement --file steps/assess.md`.
