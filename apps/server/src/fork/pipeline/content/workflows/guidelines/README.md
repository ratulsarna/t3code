# Pipeline: Guidelines

What every role builds to and judges against: the lead when it plans or writes, the developer when it writes, the Oracle when it judges, and any reviewer whose prompt names it. This is Pipeline's own copy. Settings can point at another Markdown file on the Pipeline hub, with an optional `##` section; `t3 pipeline instructions guidelines` prints whichever applies.

- No repeated code. Before writing something general-purpose, look for the code that already owns the responsibility. Reuse it, or improve the ownership boundary so it can be reused properly. If nothing exists, build the new thing with a clear home and a shape that can grow, but do not invent a framework, extension points, or abstraction layers for an imaginary future.

- The best code is the code you don't write. The second best is the code that's obviously correct and to the point. Judge simplicity by how much a reader must trace and hold to understand the code after the change, not by the size of the diff. When a change doesn't fit the current shape, design it as if it had been there from day one, then deliver that in steps instead of bolting it on. Keep a new layer or abstraction only if deleting it would push complexity back into its callers.

- Know the blast radius: before, during, and after. No change is made in a vacuum. Before writing anything, sweep the codebase for everything that touches what you're about to change, directly or indirectly (callers, shared state, timing, contracts, things that merely assume the current behavior). Write the code with that radius in mind. When done, walk the radius again: does the change leak into anything it shouldn't? And is its scope right? Should it actually reach further than it does, or is it quietly degrading something outside the lines you were staring at?

- Comments only for what the code can't say. If reading the code tells you the same thing, the comment is redundant: leave it out. The few that stay point out a catch, a contradiction, a workaround, a reason outside our control, or something coming soon.

- No lame tests and no low-impact tests. A test that merely restates the implementation or checks only the obvious path is not enough (and often not needed for every little thing). Think like a QA engineer trying to break the promise the code makes: bad input, boundaries, empty and null states, partial failure, concurrency, and awkward transitions when they are real risks. Do not create a ceremonial test matrix; chase the failures that could actually embarrass us. A test must fail when the behavior it checks breaks, and keep passing when only the internals change.

- Put the shape in the structure, not in the branches. When the same fact is checked with an `if` in several places, the structure is missing: a sealed class, a table, a state machine. It costs more lines today than one more `if`, and that trade is worth it.

- No dead code. If the work makes something obsolete, delete it. Do not keep old paths, compatibility clutter, or "maybe later" code around out of nervousness. That is what version control is for. Do not use this as an excuse for unrelated cleanup.

- Whether planning, implementing, or reviewing, start with the biggest question: is the approach itself right, or is there a cleaner way to solve the actual problem? Apply this proactively while building and retroactively while reviewing.

  Then apply judgment where it matters:
  - Design: is it well shaped, or is there a cleaner architecture that stays within YAGNI?
  - Overengineering: is it more machinery than the task deserves?
  - DRY: Is the current code or pattern already existing in the codebase? Can it be re-used or extracted and then re-used?
  - Scope: does it solve the real task, or only the narrowest interpretation of it? Should the solution's blast radius expand to cover areas it currently misses?
  - Patterns: does it reuse the right existing patterns, or blindly propagate a bad one?
  - Risk: what could this break in the code or in the user experience?
  - Root cause: for a bug fix, does it fix the cause or merely quiet the symptom?

- Be careful about addressing nit-picks: unlikely failures with minor harm, and pure taste. A cleanup that leaves the code clearly simpler, cleaner or easier to read is not a nit, even when it changes no behavior. Not every review finding deserves a fix. If it's possible in code but improbable in real use and the harm is also minor, leave it alone, with no fix and no follow-up ticket. Money, lost data, a crash, or security are never skipped for being unlikely. Fixing nits at the cost of more machinery in code is a bad trade for the health of the code. This is about what we fix, never about what gets reported or investigated.
