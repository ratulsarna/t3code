# Pipeline: Implement

## Dispatch

`t3 pipeline report --column implementing --working`

A worker whose job has a template under `templates/` starts from it: read the file with `t3 pipeline instructions implement --file templates/<name>.md` at dispatch time and fill only its `<<blanks>>`. The developer worker's is `templates/developer.md`. A statement about what the code does today ("X already does Y") carries the file:line you opened at dispatch. If you have not opened it, hand it to the worker as something to check, not as a fact.

- Size small: the lead writes the code, holding to the developer template's role, and is the owning worker every later step names.
- Work happens on a work branch off the base branch in `run.md`.
- Never run parallel workers over the same files.

## Execution

- Continue through implementation tasks and code review with short milestone updates.
- Workers own implementation decisions and tests. Answer their questions with the why, not just the answer. Check on a worker by reading its thread. Steer it only when it is going well off track, sparingly and with patience: a worker that is thinking is not stalled.
- A worker's "done" is a claim. Read the diff against the plan, and the evidence, before advancing to gates.
- Worker-raised questions resolve against the code and the plan. When the answer is a decision, put it to the Oracle session from planning; every objection ends in evidence that it does not hold or a change, and a reply without a read list is not a round. A worker's question goes to the user only for a choice (`t3 pipeline instructions overview`), or for an extra worth building. A problem a worker reports is a concern for the ledger and joint triage (`steps/assess.md`).

## Implementation ledger

The lead keeps `~/.ai/artifacts/<project>/YYYY-MM-DD-<topic>/implementation-ledger.md`, the one record of every concern and every deviation. Close-out reports from it; `run.md` links its entries and does not repeat their dispositions.

A deviation is a departure from the plan the lead agreed to, with why.

A concern is anything that may be wrong with the change, from any source: a review finding at any severity, a QA failure or inconclusive run, a worker's report, or a behavioral cost the lead knows of, including one left for QA to watch and one that predates the change. A concern matches an earlier one by behavior and cause, not by wording; a match joins the earlier entry. Each entry keeps:

```
C<n>: <the behavior and its cause, one line>
reports: <source, link, revision, and the original text quoted>, one per report
severity: <P1 | P2 | P3 | polish | shape>, from the scenario
attempts: <commit, what it changed, the verification run and what it showed>, one per attempt
evidence: <what the disposition rests on, and the revision it holds at>
disposition: open | fixed | disproved | out of scope | optional | accepted by the user | accepted by the coordinator
```

**The settled list** goes to every full review and fix check as `--settled "<text>"`. `--settled` carries every concern closed without a code fix, written out from the ledger now, one line each: `C<n> (<disposition>): <the narrow case the decision covers and what happens in it>. Basis: <the evidence at file:line, or the ruling quoted with who gave it and where>`, with its issue when one is filed; `none` when there are none. A disproof covers only what its evidence proves. A fixed or open concern is not settled, and neither is a valid P1 or P2 that awaits the user's decision. Reviewers report a settled concern only with something its line lacks. A concern found again reuses its settled disposition while the evidence that disposition rests on still holds at the current head; a change that touches that evidence reopens it and takes its line off the settled list.

## Change-level gates

Steps 1, 2 and 4 are worked from procedures. Read the procedure before the action.

| Before you | read with `t3 pipeline instructions implement --file` |
| --- | --- |
| start a shape, full or fix-check pass | `steps/review.md` |
| assess concerns from any source | `steps/assess.md` |
| write a fix plan | `steps/checked-fix.md` |
| run the comment pass, or advance to the walkthrough, QA or close-out | `steps/clear.md` |

After a resume or a compaction: read `run.md`, `requirements.md` and the implementation ledger, then `t3 pipeline review show` against the checkout's head and any worker or checker results, then the procedure for your next action.

One cycle over the landed change, where reviewers and QA see the whole picture:

1. **Required checks, size line, the shape pass when the card turns it on, the second look, then two stranger reviews.** Commit the work before each pass. Reviewers judge the code; the lead and QA judge it against `requirements.md`.
   Before starting reviews: `t3 pipeline report --column reviewing --working`
2. **Joint triage**, one batch per round. **Fix plan.** An executable fix for a finding from a bug review, a fix check, QA, or external review reaches the worker as a fix plan.

   Shape findings are triaged on their own terms. A shape finding taken is required work. A valid one rejected because its fix adds more than the problem it removes is set aside in the ledger with that reason. In manual, a shape finding whose fix adds files, a layer, or an indirection goes to the user before the batch goes to the Oracle. Outside manual, the lead decides it with the Oracle, and the implementation walkthrough names every shape finding taken; in full auto, the close-out report does.
3. **Step back**, before any fix goes out, when any of these fire: round 2 returns accepted P1 or P2 findings; the same finding across two rounds contests the approach; a reviewer cites how sibling code handles the same concern; the size line shows more than `Asked` needs (`steps/review.md`); two substantive fix attempts fail the same concern.

   Between the agents: stop fixing. The lead rethinks, which choice the findings trace back to, whether the approach is wrong, what shape the problem needs, and on the size line which of the change is `Asked` built to the guidelines and which is extras, and writes that down as a short note with the round history. A fresh Oracle session from `t3 pipeline instructions implement --file templates/oracle.md` gets the note, the plan, the diff, and the history, and one question: is this diagnosis right, and is that the shape the problem needs. Act on the answer once the user has released the rethink (below). The rethought change gets the shape pass when the card turns it on, then a full review; the round count carries on. One rethink of the change per loop, and one per concern. Rewording a symptom does not reset its concern's history.

   Asked of the user, work waits: the rethink, before the rethought change is built, with what the rounds found, what the fresh Oracle said, and what changes. A concern whose rethought fix still fails, with the failure, the attempts, and the alternatives; autonomous rework on it stops. A choice made to satisfy a requirement, contested by two reviewers or across two rounds: whether the requirement stands, with what keeping it costs and a recommendation.
4. **Full re-review.** Fixes route to the owning worker through the fix plan (step 2).

   Every round with an executable change is a full review, as in `steps/review.md`: Reviewer 1 and Reviewer 2, fresh, with the full-branch diff scope from the merge base to the current head. Fix commits are recorded in the ledger and never become a full review's scope. Only a change to docs or comments, or one shown to have no executable effect, skips the pass; the lead reads that delta instead. Calling a change a typo or a string does not earn the skip. Fixes from QA and from external review follow the same rule, and the gates clear only on a completed full review of the final executable patch. The shape pass is not a full review; its own repeat rule is in `steps/review.md`.

   A light review, set in the plan, changes this: the first full review is the only one, later fixes need only a clean fix check, and the gates clear on a clean fix check of the final executable patch. A light review becomes full for the rest of the run when the diff reaches a risk-list area (`t3 pipeline instructions plan`) the plan did not name, the size line shows more than `Asked` needs (`steps/review.md`), round 1 has an accepted P1, a step back fires, or a fix check fails twice on one concern. Record why with `t3 pipeline review set --review full --reason "<why>"` and tell the user; work goes on. It never goes back to light. A plan that names no review depth gets full.

   Once five full reviews are done, required work that would need another full review, from any phase, stops for the user first: give the commit the last review covered, the required work left at it, the attempts, and one bounded next step to approve, a named fix batch with its full review and QA, or accepting the named risks. The round count alone asks nothing of the user before then. Pipeline counts full reviews across phases; reaching five never declares the patch clean.
   When findings send it back to the worker: `t3 pipeline report --column implementing --working`
5. **Implementation walkthrough — the user's review.** In manual, once the review rounds and the comment pass clear, stop for the user before QA. In auto, QA (step 6) runs first; this walkthrough follows once QA clears, before close-out. In full auto, skip this step: once QA clears, go to acceptance.

   Prepare from the actual reviewed diff, the approved plan, and the implementation ledger. Plan at most eight steps, usually five to eight. A small change may need only one. Step 1 opens with the four lines the close-out report opens with (`t3 pipeline instructions close-out`). Explain the resulting behavior, important code paths and responsibilities, and every meaningful deviation from the plan: what changed, why, and its consequences. Distinguish verified behavior from what still awaits QA.

   Start with step 1 in the same user-facing chat reply that announces the implementation is ready to walk through. Use `/show-me` at each step: focused code snippets, diagrams, or other visuals where they aid understanding. Present one step per chat turn, then wait for the user's reply in the thread. Answer questions within the current step; never dump the remaining steps or advance on silence.

   `t3 pipeline report --column reviewing --stage walkthrough --needs-you "implementation walkthrough; step N of M"`

   Keep the step outline, current step, reviewed commit, and approval status in `run.md`; after a context reset, resume from that record. Only an explicit go after the final step releases this gate. Earlier permission to implement or to advance one step does not approve the remainder.

   Requested changes return to the owning worker (`t3 pipeline report --column implementing --working`) and the review gates above; in auto, changes to behavior re-run QA too. Once clear, revisit the affected walkthrough steps and obtain approval for the updated result. Later QA or PR-review fixes that materially change behavior, design, scope, or an explained deviation also reopen the affected steps before proceeding to close-out; unchanged steps need not repeat.
6. **QA worker** from `t3 pipeline instructions implement --file templates/qa.md`, after the user approves the implementation walkthrough; outside manual, once the review gates clear. Give it the flows as the plan named them, not implementation reasoning or what the developer saw when it ran them. It designs its own steps within that and exercises real behavior, with whatever real-system tools are reachable. Findings and inconclusive runs are concerns for joint triage (`steps/assess.md`). A required one is blocking: the owning worker fixes from a fix plan (step 2), step 4's review runs on the fix, and the same QA session re-runs; QA never changes code. A pass with any criterion not reached is partial, not clear: the unreached criteria run again after the blocker is fixed, or the user waives them, recorded in `run.md`.
   Before starting QA: `t3 pipeline report --column qa --working`
   When QA sends it back: `t3 pipeline report --column implementing --working`
7. **Acceptance.** The lead maps the verified behavior back to `requirements.md`; code review and walkthrough approval do not substitute for this judgment. Read QA's captures and logs against its claims; resolve contradictory observations and retain original failures when a rerun changes the inputs.

**Exit:** all gates clear → `t3 pipeline instructions close-out`.
