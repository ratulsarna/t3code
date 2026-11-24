# Pipeline: Plan

## Ground

Create `run.md` per `t3 pipeline instructions overview` first. Then learn how the relevant behavior works today, where responsibility lives, and which existing patterns fit. Spawn as many workers in parallel as the task needs, wide or deep, each returning evidence with file:line. A worker's summary is a pointer; the lead reads what it points at before planning on it. Once you know the files the change touches, list the open PRs that touch any of them: `gh pr list --state open --limit 200 --json number,title,author,files`.

## Understand, with the user

`t3 pipeline report --column planning --working`

Run `/in-your-own-words` (Codex: `$in-your-own-words`) for the user, checked against what your research found, and say what research could not settle: a technical call that needs human judgment, a business rule that is unclear, or a design preference that changes how it gets built. Open questions go to `/grill-me` (Codex: `$grill-me`). If the user corrects you, verify the correction yourself before moving on. Fold every answer into `requirements.md`. No plan until the user says the picture is right.

A ticket written with `/explore` carries the problem and the user's decisions, so the user is not asked for them again: write them to `requirements.md` as `Asked`, and bring the user where your reading of the problem differs from `Asked` and what is still unclear after your research, direction-level build questions included. Where the ticket is otherwise wrong about the code, go by the code. With none, go on to Shape.

`t3 pipeline report --needs-you "<short waiting reason>"`

Outside manual, the lead settles the picture from its research, writes it to `requirements.md`, and takes it into Shape. A ticket too unclear to plan from is the exception: grill the user on it as in manual. What only the user can decide goes to the user.

## Shape

Lay out the real ways to build it; your first idea and the ticket's suggested approach are each one of them, not the default; setting aside an approach the user asked for goes to the user. For each, name the extras it carries beyond `Asked`. Open the Oracle session with the brief in `t3 pipeline instructions plan --file templates/oracle.md`; it stays up for the whole run, and from there it is a conversation. Then a blind Oracle round: the ticket and `requirements.md`, nothing of yours, and the question: how would you build this. From there, work it out as a duo: put your ways next to its approach, challenge each other's assumptions, and hash out the best-designed solution together. Every claim either side makes ends in evidence from the repo or a change of mind; a reply without a read list is not a round. A premise whose failure would change the approach is checked against the actual dependency, source revision, service response or target runtime, and the result goes beside the decision in the plan. The lead has the final say. If the design work shows that what you and the user agreed the task to be was wrong, go back to the user before going on.

The lead writes `plan.md` as the design settles; the Oracle reads and challenges each draft. Shape ends when the Oracle has no objection left to the written plan that is not answered with evidence, taken into the plan, or ruled on by the lead.

The plan contract. Written for the worker who builds from it; go as deep as the change needs, down to code where code says it best:

- how the relevant behavior works today, with file:line;
- open PRs that touch the same files, and how this change relates to each, or none;
- `Asked`, as `requirements.md` has it;
- the approach and why, and the ways set aside and why;
- exact scope and task breakdown: what `Asked` needs, then each extra beyond it with who wanted it, what it adds, and the user's yes;
- what is out of scope;
- the choices (`t3 pipeline instructions overview`): each one with the way taken and the ways set aside, or none;
- files or seams to touch;
- where the design surface is real, a design sketch in code blocks: types, signatures, call flow, and the code itself where the code is the decision;
- for each promise the change could break: the check that would expose a break, including interruption or overlap where ownership changes, the real boundary it runs against (the real dependency, the published command, the supported platforms), and its exact command;
- for each manual check: what it runs against, the data or account it needs, what you observed that shows its entry path and data exist, or else the setup it needs or its verification limit, and the source it is judged against: `Asked` and the design, spec, screenshot or PR it points at, not the plan's restatement of it. Cover consequential user states and real user entry paths through the resulting effect and exit, not just arrival at a screen;
- acceptance-criteria mapping back to the spec;
- risk notes; rollback where relevant;
- review depth: full or light, against the risk list below, and why.

Every item resolved; "TBD" or "handle later" is a gap the worker fills by guessing. Plans describe the change, never the process: gates, review, and delivery live in the workflow documents, and a worker given process in a plan follows the plan.

Artifact: `plan.md` at `~/.ai/artifacts/<project>/YYYY-MM-DD-<topic>/`.

The risk list: migrations; auth, login and sessions; data-loss surfaces; money; production access or secrets; shared tooling other tasks run; a change to how existing code behaves where other features already run it; anything hard to roll back. A change that reaches any of them has real blast radius: its plan gets one independent read by a fresh worker that saw none of the design work, and its review is full. Risk, not habit, buys it; take the read's findings back into Shape by evidence and severity. Any other change gets a light review, as `t3 pipeline instructions implement` describes.

## The first look

Show the user the plan's choices as the first look (`t3 pipeline instructions overview`). In manual it is step 1 of the walkthrough.

## Walkthrough — the user's review

Manual only. Otherwise, go to the exit once the first look is released.

`t3 pipeline report --column plan_ready --needs-you "plan ready; walkthrough step 1 of M"`

Start with step 1 in the same chat reply that announces the plan is ready. Walk the user through it one step at a time, up to five or six steps: what we are solving and how, what path we are taking, with visuals and code snippets where they help. Use `/show-me` for each step. Present one step per chat turn and wait for the user's reply there; never all the steps at once. The card records only the stage and waiting reason. An objection at any step goes back to Shape, with the Oracle still up.

`t3 pipeline report --needs-you "walkthrough step N of M"`

**Exit:** the user gives the go after the last step, or the first look is released outside manual → read `t3 pipeline instructions implement` and continue in this thread.
