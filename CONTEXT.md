# Tide

CLI that runs a queue of **agent** **iterations** against a Linear-rooted workplan, tracked in Linear, with code/PRs on GitHub. The work-unit at the root of the queue is either a **PRD** (context-only parent whose **Sub-issues** are queued) or a **Standalone Issue** (queued directly, one iteration). Built on **sandcastle**, which owns the **sandbox** / **host** / **iteration** primitives.

## Inherited from sandcastle

These terms come from [sandcastle's CONTEXT.md](https://github.com/ai-hero/sandcastle) and apply unchanged in tide. Definitions live there; this section names what tide relies on so the rest of this glossary can build on it.

- **Sandbox**, **Host**, **Agent** — the core triplet. Tide is the **host**-side orchestrator; one **agent** runs inside one **sandbox** per **iteration**.
- **Iteration** — a single sandcastle `run({ branchStrategy: 'merge-to-head', ... })` call (one **working agent** invocation). `tide run` chains many. The summarizer's invocation is a separate sandcastle `run(...)` call when triggered by BLOCKED / agent-FAIL — not part of the iteration.
- **Sandbox provider** / **Bind-mount sandbox provider** — tide uses sandcastle's Docker bind-mount provider; no other providers are wired up.
- **Branch strategy** — tide uses two strategies, one per worktree layer: the **Feature worktree** uses `branch` (with the **PRD**'s or **Standalone Issue**'s Linear-auto-generated `branchName`, or a user-overridden branch — see **Feature worktree**), and each per-**iteration** **Iteration worktree** uses `merge-to-head` (sandcastle creates a temp branch, the agent commits there, sandcastle merges those commits into the **Feature worktree**'s feature branch on sandbox close, then deletes the temp branch). Replaces the prior single-strategy model — see ADR 0006 and the new branch-strategy ADR.
- **Worktree** — git worktree on the **host**. Tide now operates two layers: a tide-owned **Feature worktree** on the feature branch, and a sandcastle-owned **Iteration worktree** beneath it per **iteration**. The **sandbox** bind-mounts the **Iteration worktree**, not the **Feature worktree** directly.
- **Prompt template**, **Prompt argument**, **Shell expression** — tide's working-agent prompt at `.tide/prompt.md` is a sandcastle **prompt template**; values are passed via `promptArgs`.
- **Completion signal** — sandcastle's `<promise>…</promise>` termination marker. Tide overrides sandcastle's default `COMPLETE` payload; see **DONE signal** and **BLOCKED signal** below.
- **Backlog manager** — sandcastle's role for "pluggable task source". Linear plays this role for tide; the role is not actually pluggable in tide.
- **Log-to-file mode** — tide forces `logging: { type: 'file' }`; logs land under `.tide/logs/` and the summarizer reads the working agent's transcript from there.

## Language

**Backlog manager (Linear)**:
The sandcastle-role tide hard-wires to Linear: source of the workplan, owner of unit-of-work identity (**PRD** + **Sub-issue**), keeper of the state machine (workflow states + label vocabulary). Not pluggable in tide — swapping it for another tracker would require code, not config. Source-of-truth-ness is captured in ADR 0004; the host-driven state writes are ADR 0005.
_Avoid_: "issue tracker" (too generic), "task source" (sandcastle's term — fine to use, but `backlog manager` is the role name).

**PRD**:
A top-level Linear issue describing a body of work as **context** for its **Sub-issues**. Marked with the `prd` label. Authored by a human in Linear's UI; tide never creates one. PRDs are **never executed** by the agent — they exist solely to provide context to their **Sub-issues**' prompts.
_Avoid_: parent issue (in the GitHub-tree sense), top-level ticket.

**Sub-issue**:
A _direct_ Linear child of a **PRD**, marked with `ready-for-agent`. One unit of work the agent runs in a single iteration. Grandchildren are not flattened into the queue.

**Standalone Issue**:
A Linear issue marked with `ready-for-agent` and no `prd` label, with no Linear parent. One unit of work the agent runs in a single iteration. Functionally identical to a **Sub-issue**, but selected directly from the picker rather than via a **PRD**. A non-PRD issue with children is invalid (tide errors on selection).

**`prd` label** (lowercase):
The Linear-team-scoped marker that an issue is a context-only **PRD**. Issues carrying `prd` are never executed directly by the agent; their **Sub-issues** are queued instead. Distinct from the older capital-`PRD` marker (see Flagged ambiguities).

**`ready-for-agent` label**:
The Linear-team-scoped marker that an issue is in scope for the next `tide run` _as the agent's unit of work_. Applied to **Sub-issues** and **Standalone Issues** only — never to PRDs. Removing it pauses the issue without losing its Linear identity.

**Standalone PRD**:
A **PRD** with no **Sub-issues** yet — i.e., a PRD still awaiting human triage/breakdown. Not selectable in `tide run` (nothing to execute); becomes selectable once the user adds at least one `ready-for-agent` **Sub-issue** under it.

## Relationships

- A **PRD** has zero or more **Sub-issues** as Linear children.
- A **Sub-issue** belongs to exactly one **PRD** (its Linear parent).
- A **Standalone Issue** has no Linear parent and no children.
- A **PRD** carries the `prd` label only; **Sub-issues** and **Standalone Issues** carry `ready-for-agent` (never `prd`).

**DONE signal**:
A sandcastle **completion signal** with the payload `DONE`. The **agent** emits `<promise>DONE</promise>` to declare its unit of work complete. Host translation depends on the unit's kind: for a **Sub-issue** (queued under a **PRD**), the host transitions it to Linear's _Done_ state immediately, so each iteration's progress shows in real time. For a **Standalone Issue**, the host leaves the workflow state at _In Progress_ — the CLI orchestration layer's post-submission hook later transitions it to _In Review_ once a PR is opened, so the parent never claims Done before review (see ADR-0009). Overrides sandcastle's default `COMPLETE` payload.

**BLOCKED signal**:
A sandcastle **completion signal** with the payload `BLOCKED`. The **agent** emits `<promise>BLOCKED</promise>` to declare it can't finish. The **host** then spawns a follow-up **summarizer agent** that writes a few-sentence reason; the **host** posts that reason as a Linear comment on the **Sub-issue**, swaps the **Sub-issue**'s label from `ready-for-agent` to `ready-for-human`, and continues to the next queued **Sub-issue**. The **Sub-issue**'s Linear workflow state stays at _In Progress_. Overrides sandcastle's default `COMPLETE` payload.

**`ready-for-human` label**:
Tide's signal that a **Sub-issue** needs a human before it's queueable again. Set by tide on BLOCKED and on agent-driven FAIL; the human resolves the cause, swaps the label back to `ready-for-agent`, and re-runs.

**Working agent**:
The primary role tide plays the **agent** in: doing the engineering work for one **Sub-issue** in one **iteration**. Driven by the **prompt template** at `.tide/prompt.md`. Always runs first; emits the **DONE signal** or **BLOCKED signal**.

**Summarizer agent**:
A second **agent** invocation, with its own prompt, that runs after a BLOCKED or agent-driven FAIL exit. Runs as a **separate** sandcastle `run(...)` call with its own short-lived **sandbox** (no shared state with the **working agent**'s sandbox). Receives the **working agent**'s transcript (read host-side from the prior call's `logFilePath` under `.tide/logs/`) plus the **Sub-issue** and **PRD** Linear bodies as prompt context. Its concise final assistant message becomes a Linear comment on the **Sub-issue**. Different prompt per trigger (`blocked-summary` vs `fail-summary`). The branch strategy used by the summarizer's sandcastle `run(...)` does not matter for correctness (the summarizer produces no commits) — `merge-to-head` is fine; `head` would also work.

**Commit reference**:
Every commit the agent makes on the feature branch is prefixed with the non-closing Linear magic word `ref <linear-id>` (e.g. `ref MEC-123`). This links the commit to the **Sub-issue** in Linear's UI without transitioning state.

**PR title**:
The exact form `[<linear-id>] <root-title>`, where `<linear-id>` is the **PRD** or **Standalone Issue** identifier (e.g. `PER-76`) and `<root-title>` is that root's Linear title with the leading **Repo prefix** stripped. Computed host-side as a pure function and passed into the PR-submission prompt as `{{PR_TITLE}}` — the agent does not author it. Survives a squash-merge into `master`, where the PR title becomes the merge-commit subject and is the only place a Linear identifier remains in `git log` (the per-commit `ref <linear-id>` prefixes from **Commit reference** are discarded by squash). Replaces the prior agent-authored Conventional Commits format.
_Avoid_: "PR subject" (collides with email-thread vocabulary), conflating with the **Repo prefix** (different prefix, different surface — Linear titles vs GitHub PR titles).

**PR body**:
Keeps the existing six-section emoji template (🚩 Problem / 💡 Solution / 🏗 Interface Movements / 📦 Package Breakdowns / 🧹 Housekeeping). Tide emits no closing magic words — neither GitHub `Closes #NN` nor Linear `Fixes MEC-X` — to avoid double-driving the **PRD** transition and to remove all GitHub-issue dependency. Linear-PRD identifier + URL appear in the body for human readers only.

**Branch-name linkage**:
The feature branch's name comes verbatim from the **PRD**'s (or **Standalone Issue**'s) Linear-auto-generated `branchName`. Linear's GitHub integration uses this match to connect the PR to the parent and auto-transition it to _Done_ when the PR merges, completing the four-step parent lifecycle: **Triage → In Progress → In Review → Done**. The first three transitions are host-driven by tide — selector pick → _In Progress_ at run start, then a clean queue plus a successfully opened PR → _In Review_ post-submission (see ADR-0009); the final _In Review_ → _Done_ comes from Linear's GitHub integration on merge. Tide writes no `Fixes MEC-PRD` magic word into the PR body — the branch name is the entire link. If the In Review hand-off is skipped (no PR opened, or queue had aborts/flips) or the PR is closed without merging, the parent stays where tide left it — _In Progress_ or _In Review_ — until the user transitions it manually; tide warns about this at end-of-run.

**Iteration boundary**:
The moment between **iteration** N and **iteration** N+1 in a single `tide run`. Locus of host-side housekeeping: iteration N's sandcastle `run(...)` call has already returned (which fires sandcastle's `merge-to-head` merge of the **Iteration worktree**'s commits onto the **Feature worktree**'s feature branch and tears down the per-iteration **sandbox**), the **summarizer agent**'s separate `run(...)` call has also returned if it fired (BLOCKED / agent-FAIL only), iteration N's Linear writes (transition to _Done_ or label flip + comment) settle, the host-side branch push fires (ADR-0007), the **queue rebuild** runs, and the next candidate **Sub-issue** is selected. Only meaningful under a **PRD** root — **Standalone Issue** roots are one-iteration loops with no boundary.

**Queue rebuild**:
The act of re-fetching the picked **PRD**'s direct children from Linear at every **iteration boundary**, excluding identifiers tide has already handled this run (transitioned to _Done_ or flipped to `ready-for-human`), and feeding the rest through the existing pure `buildOrderedQueue` to produce a fresh topo order. Absorbs new **Sub-issues** the human added in Linear's UI mid-run, and naturally drops queued-but-not-yet-run ones whose `ready-for-agent` label was removed mid-run. See ADR-0010.
_Avoid_: "re-poll" (a sub-step — only the network call), "re-queue" (overloads the verb).

**Processed Sub-issue**:
A **Sub-issue** the runner ran an iteration on during this `tide run` — including absorbed ones picked up by a **queue rebuild**, in the order tide ran them. Distinguished from the pre-flight queue (which is the snapshot at run start). The PR body's "Sub-issues addressed" block enumerates **processed Sub-issues**, not the pre-flight queue.

**Sandcastle bridge**:
The runtime symlink `<repoRoot>/.sandcastle` → **config directory** (`.tide/`) that redirects sandcastle's hardcoded `.sandcastle/{worktrees,logs}/` writes into tide's convention. Considered "intact" only when present and pointing at `.tide/`; any other on-disk shape (missing, broken target, real directory, regular file) is a broken **sandcastle bridge** and silently breaks subsequent `tide run` invocations at the worktree-collision check. Repaired by `tide setup`, detected by `tide doctor`. Removable once sandcastle exposes a config-directory override (see CONTEXT.md Flagged ambiguities).
_Avoid_: "sandcastle symlink" (implementation-leaky), "config-dir bridge" (collides with **config directory**).

**Feature worktree**:
The host-side git worktree tide creates and owns for the picked **PRD** or **Standalone Issue**, on the Linear-auto-generated feature branch (default) or on the user's currently-checked-out branch when they take the **Branch override** at `tide run` time. Persists across `tide run` invocations: re-running on the same root reuses an existing **Feature worktree** rather than recreating it. Sandcastle's per-**iteration** **Iteration worktree** is created beneath it (sandcastle's `cwd` for every iteration points at the **Feature worktree**, not the user's repo root), and sandcastle's `merge-to-head` merges each iteration's commits onto the **Feature worktree**'s feature branch on sandbox close. Replaces today's "tide hands `branch`+`baseBranch` to `createSandbox` and lets sandcastle own the only worktree".
_Avoid_: "main worktree" (collides with git's term for the original checkout), "PRD worktree" (excludes Standalone Issues), "root worktree" (collides with **PRD** / **Standalone Issue** as run roots).

**Branch override**:
The post-pick prompt that fires when the user's current branch (the one they ran `tide run` from) differs from the picked **PRD**'s or **Standalone Issue**'s Linear-auto-generated `branchName`. Rendered as a clack `select` between two options — Linear's `branchName` (default) and the user's current branch — and chooses which branch the **Feature worktree** is created on. No prompt fires when current branch == Linear's `branchName` (silent reuse). No `tide.config.ts` notion of "base branches"; the prompt is the user's only escape hatch for branches that don't match Linear. Replaces today's hard pre-flight gate that errored out when current branch == Linear `branchName` (`src/cli/run.ts`).

When the user takes the override, the eventual PR's head branch is _not_ the Linear-auto-generated `branchName`, so Linear's GitHub integration cannot match the PR back to the root and the **In Review → Done** transition (ADR-0009) does not fire on merge. Tide preserves the no-closing-magic-word stance (ADR-0006 / ADR-0009) on the override path — no `Fixes <linear-id>` is added to the PR body — and accepts the cost: the user transitions the root manually in Linear after merge. Tide warns about this at end-of-run alongside its existing no-merge warning. Tide's host-driven _Triage_ → _In Progress_ → _In Review_ chain (ADR-0009) is unaffected by the override — those transitions are branch-name-independent.
_Avoid_: "branch picker" (collides with the **PRD** / **Standalone Issue** picker), "feature-branch override" (the override is about which branch the **Feature worktree** rides — branch and feature are the same noun-pair).

**Iteration worktree**:
The ephemeral, per-**iteration** git worktree sandcastle creates beneath the **Feature worktree** under the `merge-to-head` **branch strategy**. The **working agent** (and, on BLOCKED / agent-FAIL, the **summarizer agent**) commits inside it on a sandcastle-generated temp branch; on sandbox close, sandcastle merges those commits into the **Feature worktree**'s feature branch and deletes the temp branch. Disposed per-iteration — never reused across **iterations**.
_Avoid_: "sandbox worktree" (conflates with **Sandbox**), "temp worktree" (the temp-branch detail leaks the strategy name), "agent worktree" (the agent's environment is the **Sandbox**, not the worktree).

**Repo prefix**:
The `[<repo>] ` token (open-bracket, repo name, close-bracket, single space) at the start of every Linear issue title that tide will see. `<repo>` is the GitHub repo name returned by `gh repo view --json name` for the working tree (same source as the rest of tide's repo identity per `src/gh-identity/index.ts`). Lets one Linear team back multiple repos: tide filters every Linear list query by `title: { startsWith: "[<repo>] " }`, so wrong-repo and unprefixed issues are invisible to the picker, the queue build, and the **queue rebuild**. The skills `linear-triage`, `linear-to-prd`, and `linear-to-issues` are responsible for writing the prefix at issue-creation time; tide is responsible for filtering on it at every fetch.
_Avoid_: "repo tag" (collides with git tags), "repo bracket" (form, not function).

## Flagged ambiguities

- Old `PRD` label (capital, per ADR 0002) meant "tide-created mirror of a GitHub parent". New `prd` (lowercase) means "user-declared tide-runnable PRD". Different semantics — ADR 0002 will be superseded.
- Sandcastle's default **completion signal** payload is `COMPLETE` (single binary). Tide replaces it with two payloads — `DONE` (success) and `BLOCKED` (graceful abort) — riding the same `<promise>…</promise>` mechanism. Reading sandcastle docs, "completion" maps to either of tide's signals.
- Branch placeholders in tide-owned prompts are tide-supplied custom keys: `{{FEATURE_BRANCH}}` (the **Feature worktree**'s branch — Linear's `branchName` by default, or the user's branch on the **Branch override** path) and `{{BASE_BRANCH}}` (the user's PR target, captured at `tide run` startup). Sandcastle's built-in `{{SOURCE_BRANCH}}` / `{{TARGET_BRANCH}}` are not referenced anywhere in tide-owned prompts — their meanings flip between the `branch` and `merge-to-head` strategies and using them invites silent miscommunication. See ADR-0014.
- `.tide/` is tide's **config directory** (sandcastle's term). Sandcastle hardcodes `.sandcastle/` for its own worktrees + logs; tide bridges with a runtime symlink (`.sandcastle` → `.tide`) so both land in the same place. Plan: move everything under `.tide/` and drop the symlink once sandcastle exposes a config-directory override.
- "Branch strategy" in tide used to be a single value (`branch`, per ADR-0006). It is now a pair: `branch` for the **Feature worktree** (long-lived, on the feature branch) + `merge-to-head` for each **Iteration worktree** (ephemeral, per-iteration). Reading older docs/ADRs that say "tide uses the `branch` strategy" — they describe the **Feature worktree** layer only.
- "Reusable sandbox" was the term for tide's pre-merge-to-head runtime (one sandbox shared across all **working agent** + **summarizer agent** calls in a `tide run`, via `createSandbox` + repeated `sandbox.run(...)`; per ADR-0005). It is **gone**: tide now invokes sandcastle's top-level `run(...)` per agent invocation, so each **iteration** gets its own short-lived **sandbox**, and the summarizer (when it fires) gets a second one. The "host-driven Linear writes" half of ADR-0005 still holds.
