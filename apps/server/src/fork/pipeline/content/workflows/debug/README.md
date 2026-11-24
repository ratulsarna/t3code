# Pipeline: Debug

A root cause can arrive pre-done: a ticket already carrying reproduction, evidence, and cause satisfies the gate once spot-checked against the current code. Apply the rules in `templates/debugger.md` during that check.

If the ticket lacks the symptoms (what happens, what was expected, where), ask the user for them first, in every mode: `t3 pipeline report --needs-you "bug symptoms"`.

## Process

1. **Create `run.md`** per `t3 pipeline instructions overview`, then **dispatch a worker** from `t3 pipeline instructions debug --file templates/debugger.md`. Give it symptoms, where the bug surfaces, and what's been tried.
2. **The deliverable is the root cause, not a fix**, written to `rca.md` in the artifact directory: an evidence-backed root cause the lead can follow and verify. Reproduction is preferred when practical; when it is not, the strongest available evidence, with the remaining uncertainty stated.
3. **Tell the user** the root cause, key evidence and proposed fix. Include any signal the debugger proposed. Explain how a regression would be caught: a test that fails before the fix and passes after where that buys real coverage, otherwise the strongest check with captured evidence. In manual, stop there; the user sizes the fix.
   `t3 pipeline report --needs-you "root cause found; size the fix"`
   Outside manual, size the fix yourself, include the size in that account, and continue.

**Exit:** once the fix is sized, run `t3 pipeline report --size <s> --working`, then read `t3 pipeline instructions plan` and continue in this thread.
