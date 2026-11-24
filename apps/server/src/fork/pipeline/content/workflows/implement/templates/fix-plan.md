# Fix plan at <<current head commit>>

<<One section per underlying mistake. Findings with one cause share a section. Write it from the code you open now, at the current head, not from memory of it.>>

## M<<n>>: <<the mistake in one sentence: the rule the code breaks, at least as wide as every finding below, not the one case a reviewer hit>>

findings:
<<each finding this section resolves: its concern id and the original text quoted, as the ledger has it>>

| place (file:line) | today | after the fix |
| --- | --- | --- |
<<one row per place the mistake lives: every state, entry point, direction, retry, restart, error path and early exit you found by searching the branch and tracing its callers.>>

left out:
<<each place where the mistake lives that this fix does not change, with its reason: the lines show it is not this mistake; the guidelines let it wait (unlikely and minor harm, never money, lost data, security or a crash); or the user accepted it, quoted with where it was said. "none" when there are none.>>

a user gets:
<<how the product behaves differently for the people who use it once this fix is built, or "nothing". Where that is a new choice, or changes one the user approved, it is a look before the fix goes out (`t3 pipeline instructions overview`).>>
