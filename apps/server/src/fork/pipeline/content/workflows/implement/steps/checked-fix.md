# A fix plan

Fill `t3 pipeline instructions implement --file templates/fix-plan.md` from the code at the current head, opened now. Then run `t3 pipeline fix-plan check --plan "$(cat <file>)"`. Pipeline starts a fresh checker with the plan and the branch, and it reports the holes it finds: a place the mistake lives that the plan misses, a row the code does not bear out, a new way to fail, a change in what a user gets that the plan does not name.

The report is advice and the plan is yours. Take each hole into the plan, or put it under `left out` with one of that list's reasons. The read happens once per plan: answering its report does not earn another. A checker that cannot start or does not report does not hold the fix: archive its thread and say in the ledger that the plan went unread.

Then send the plan to the worker yourself, in the brief from `t3 pipeline instructions implement --file templates/fix.md`; on a size small card, build it yourself. The worker owns the how within the plan; a discovery that changes it comes back to joint triage.
