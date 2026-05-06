# Tide

CLI that runs a queue of **agent** **iterations** against a PRD-rooted workplan, tracked in Linear, with code/PRs on GitHub. Built on **sandcastle**, which owns the **sandbox** / **host** / **iteration** primitives.

## Inherited from sandcastle

These terms come from [sandcastle's CONTEXT.md](https://github.com/ai-hero/sandcastle) and apply unchanged in tide. Definitions live there; this section names what tide relies on so the rest of this glossary can build on it.

- **Sandbox**, **Host**, **Agent** — the core triplet. Tide is the **host**-side orchestrator; one **agent** runs inside one **sandbox** per **iteration**.
- **Iteration** — a single `sandbox.run(...)` call. `tide run` chains many.
- **Sandbox provider** / **Bind-mount sandbox provider** — tide uses sandcastle's Docker bind-mount provider; no other providers are wired up.
- **Branch strategy** — tide uses the `branch` strategy with the **PRD**'s Linear-auto-generated `branchName` (see ADR 0006).
- **Worktree** — git worktree on the **host**, mounted into the **sandbox**.
- **Prompt template**, **Prompt argument**, **Shell expression** — tide's working-agent prompt at `.tide/prompt.md` is a sandcastle **prompt template**; values are passed via `promptArgs`.
- **Completion signal** — sandcastle's `<promise>…</promise>` termination marker. Tide overrides sandcastle's default `COMPLETE` payload; see **DONE signal** and **BLOCKED signal** below.
- **Backlog manager** — sandcastle's role for "pluggable task source". Linear plays this role for tide; the role is not actually pluggable in tide.
- **Log-to-file mode** — tide forces `logging: { type: 'file' }`; logs land under `.tide/logs/` and the summarizer reads the working agent's transcript from there.

## Language

**PRD**:
The top-level Linear issue describing a unit of work tide will run end-to-end. Marked with both `prd` and `ready-for-agent` labels. Authored by a human in Linear's UI; tide never creates one.
_Avoid_: parent issue (in the GitHub-tree sense), top-level ticket.

**Sub-issue**:
A _direct_ Linear child of a **PRD**, marked with `ready-for-agent` only (no `prd`). One unit of work the agent runs in a single iteration. Grandchildren are not flattened into the queue.

**`prd` label** (lowercase):
The Linear-team-scoped marker that an issue is a tide-runnable **PRD**. Distinct from the older capital-`PRD` marker (see Flagged ambiguities).

**`ready-for-agent` label**:
The Linear-team-scoped marker that an issue is in scope for the next `tide run`. Removing it pauses an issue without losing its **PRD** identity.

**Standalone PRD**:
A **PRD** with no `ready-for-agent` children. Tide treats the **PRD** itself as the single unit of work.

## Relationships

- A **PRD** has zero or more **Sub-issues** as Linear children.
- A **Sub-issue** belongs to exactly one **PRD**.
- A **PRD** carries both `prd` and `ready-for-agent`; a **Sub-issue** carries only `ready-for-agent`.

**DONE signal**:
A sandcastle **completion signal** with the payload `DONE`. The **agent** emits `<promise>DONE</promise>` to declare a **Sub-issue** complete; the **host** then transitions the **Sub-issue** to Linear's _Done_ state. Overrides sandcastle's default `COMPLETE` payload.

**BLOCKED signal**:
A sandcastle **completion signal** with the payload `BLOCKED`. The **agent** emits `<promise>BLOCKED</promise>` to declare it can't finish. The **host** then spawns a follow-up **summarizer agent** that writes a few-sentence reason; the **host** posts that reason as a Linear comment on the **Sub-issue**, swaps the **Sub-issue**'s label from `ready-for-agent` to `ready-for-human`, and continues to the next queued **Sub-issue**. The **Sub-issue**'s Linear workflow state stays at _In Progress_. Overrides sandcastle's default `COMPLETE` payload.

**`ready-for-human` label**:
Tide's signal that a **Sub-issue** needs a human before it's queueable again. Set by tide on BLOCKED and on agent-driven FAIL; the human resolves the cause, swaps the label back to `ready-for-agent`, and re-runs.

**Working agent**:
The primary role tide plays the **agent** in: doing the engineering work for one **Sub-issue** in one **iteration**. Driven by the **prompt template** at `.tide/prompt.md`. Always runs first; emits the **DONE signal** or **BLOCKED signal**.

**Summarizer agent**:
A second **agent** invocation, with its own prompt, that runs after a BLOCKED or agent-driven FAIL exit. Runs in the _same_ **reusable sandbox** as the **working agent** (via `createSandbox` + multiple `sandbox.run(...)` calls). Receives the **working agent**'s transcript plus the **Sub-issue** and **PRD** Linear bodies as prompt context. Its concise final assistant message becomes a Linear comment on the **Sub-issue**. Different prompt per trigger (`blocked-summary` vs `fail-summary`).

**Reusable sandbox**:
A single docker container, created once at the start of `tide run` via sandcastle's `createSandbox`, and reused across every working-agent iteration _and_ every summarizer invocation in the queue. Replaces today's pattern of one fresh container per `run()` call.

**Commit reference**:
Every commit the agent makes on the feature branch is prefixed with the non-closing Linear magic word `ref <linear-id>` (e.g. `ref MEC-123`). This links the commit to the **Sub-issue** in Linear's UI without transitioning state.

**PR body**:
Keeps the existing six-section emoji template (🚩 Problem / 💡 Solution / 🏗 Interface Movements / 📦 Package Breakdowns / 🧹 Housekeeping). Tide emits no closing magic words — neither GitHub `Closes #NN` nor Linear `Fixes MEC-X` — to avoid double-driving the **PRD** transition and to remove all GitHub-issue dependency. Linear-PRD identifier + URL appear in the body for human readers only.

**Branch-name linkage**:
The feature branch's name comes verbatim from the **PRD**'s Linear-auto-generated `branchName`. Linear's GitHub integration uses this match to connect the PR to the **PRD** and auto-transition the **PRD** to _Done_ when the PR merges. Tide does not write any `Fixes MEC-PRD` magic word into the PR body — the branch name is the entire link. If no PR is created (or the PR is closed without merging), the **PRD** stays at _In Progress_ until the user transitions it manually; tide warns about this at end-of-run.

## Flagged ambiguities

- Old `PRD` label (capital, per ADR 0002) meant "tide-created mirror of a GitHub parent". New `prd` (lowercase) means "user-declared tide-runnable PRD". Different semantics — ADR 0002 will be superseded.
- Sandcastle's default **completion signal** payload is `COMPLETE` (single binary). Tide replaces it with two payloads — `DONE` (success) and `BLOCKED` (graceful abort) — riding the same `<promise>…</promise>` mechanism. Reading sandcastle docs, "completion" maps to either of tide's signals.
- Branch placeholders in prompts use sandcastle's built-in names `{{SOURCE_BRANCH}}` / `{{TARGET_BRANCH}}`, not legacy `{{BRANCH}}` / `{{BASE_BRANCH}}`. Sandcastle injects them automatically from the `branch` / `baseBranch` passed to `createSandbox`, and rejects any attempt to override them via `promptArgs`. Old user prompts referencing `{{BRANCH}}` will fail to substitute after upgrade.
