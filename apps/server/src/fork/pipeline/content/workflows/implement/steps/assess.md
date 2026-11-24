# Assessing concerns

Read this before assessing concerns from any source: a review pass, reviewers run by hand, QA, a worker, external review. One batch at a time: a review round's findings, or what one source has just reported.

Enter every concern from the round in the ledger, then send the planning Oracle the original reports and evidence, without your classifications. It gives its own call on each: valid or not, severity, fix or decline, and the fix direction. It may raise concerns nobody reported and challenge the plan itself. Form your own view before you read its call; then exchange once, and settle each disagreement with current evidence or changed work. Agreement is not the measure. The lead decides among the agents, except where non-negotiable 4 sends the user a valid P1 or P2 left unfixed, or an unresolved dispute over validity. Severity follows from the scenario; it never decides whether a concern is assessed. If a reviewer misreads intent, make the code's names and structure say it.

Do not let repeated review result in scope creep. It is your job to fight to keep the scope limited.

A concern closes only for one of these reasons, recorded with its evidence:
- fixed: evidence that the original failure is addressed at the current head;
- disproved: a production guard prevents it, or its premise is false;
- out of scope: unchanged behavior outside this change's promise;
- valid but optional: a P3 or polish not worth its cost, or a bug the guidelines let wait;
- valid and accepted by the user, or by the coordinator in its own name when the failure gives up no part of `Asked`, who was shown this concern's own failure case. An earlier ruling or a general rule that seems to cover a concern is not acceptance of it: the concern is fixed, closed under another disposition on its own evidence, or taken to the user with its scenario and the ruling quoted.

Passing neighboring runs and failed reproductions support a disposition; they never close a concern on their own. P3 and polish are batched, judged together on whether each fix is worth its cost in code, and the ones worth taking ride along with required fixes in at most one round; a P3 alone never buys a round.

A report that brings nothing its settled line lacks is neither a contest nor a disagreement argued again. A revised diagnosis updates the same entry and keeps its attempts. A concern found again and validly settled never needs the user. The same disagreement argued twice goes to the user; that caps circular argument and never delays what non-negotiable 4 requires.

Triage also agrees each fix's direction and any consequential ownership, synchronization, lifecycle, or behavioral decision. A fix addresses one underlying concern and names every ledger entry it resolves; related findings may share one root-cause fix. A shape finding, or a change with no executable effect, goes to the worker directly.

After triage of a completed Pipeline pass, run `t3 pipeline review settle <pass> --open <n> [--note <text>]`, counting every required item still open in the ledger, including earlier findings.
