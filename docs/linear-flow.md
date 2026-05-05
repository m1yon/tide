# Tide flow (Linear-native)

End-to-end user flow for `tide run` once issue tracking lives entirely in Linear. Code and PRs still live on GitHub; everything else (PRD, sub-issues, blockers, lifecycle states) is Linear. See ADR-0004 for the source-of-truth decision, ADR-0005 for the host-driven Linear writes boundary, and ADR-0006 for the branch-name PR↔PRD link.

## One-time setup

Run `tide setup` once per Linear team. It idempotently creates the three labels tide reads from and writes to (`prd`, `ready-for-agent`, `ready-for-human`) on the team configured in `.tide/config.ts`. Re-running on a fully provisioned team is a no-op.

## Authoring (in Linear, before running)

1. Create the **PRD** — a parent Linear issue with the high-level requirements. Apply labels `prd` + `ready-for-agent`. Put it in a non-terminal state.
2. Create **sub-issues** under the PRD, one per unit of work. Apply `ready-for-agent` to each. Use Linear's `blockedBy` relations to express ordering.

## Run

3. From your **base branch** in the code repo (`main` / `dev` / whatever you'll PR against), run `tide run`. Tide creates the feature-branch worktree itself; you don't switch branches first. If you invoke `tide run` from the feature branch by mistake, tide errors out — the feature branch must not also be the PR base.
4. Pick the PRD from the selector (lists every Linear issue on your team with `prd` + `ready-for-agent` in a non-terminal state, most-recently-updated first). Each option shows its `ready-for-agent` and `ready-for-human` sub-issue counts so you can see at a glance which PRDs have work queued vs. blocked.
5. Tide shows the pre-flight: feature-branch name (from the PRD's auto-generated `branchName`), the topo-sorted queue of in-scope sub-issues (only direct Linear children of the picked PRD), and a count of any children excluded for missing the label or being in a terminal state.
6. Confirm "Run N issue(s)?" Y/n. Then confirm "Create a PR at end?" Y/n.
7. On confirm, the **PRD transitions to In Progress** in Linear and the queue starts.

## Per sub-issue (visible in Linear's UI as it runs)

8. Sub-issue transitions to **In Progress** when its turn starts.
9. The agent works in the sandbox, committing to the shared feature branch. Each commit is prefixed with `ref <linear-id>` (a non-closing Linear magic word) so it surfaces on the sub-issue's timeline without forcing a state transition.
10. **DONE** signal from the agent → host transitions the sub-issue to **Done**.
11. **BLOCKED** signal (the agent decided it's gracefully stuck) → host runs a summarizer agent that posts a concise comment on the sub-issue explaining why, then flips the sub-issue's label from `ready-for-agent` to `ready-for-human`. The queue continues to the next sub-issue.
12. **Agent-FAIL** (no commits, no signal — the working agent silently gave up) → same as BLOCKED with a different summarizer prompt. Comment posted, label flipped, queue continues.
13. **Infra FAIL** (sandcastle threw, fetch failed, etc.) → no label flip; the queue aborts so transient docker/network errors don't cascade. Re-run `tide run` to resume from the same base branch.

## Tail (if you said yes to the PR)

14. After the queue completes, tide pushes the feature branch to GitHub and opens a PR against the base branch you started from. The PR body references the PRD by Linear identifier and URL for the reviewer's benefit but emits **no closing magic words** (`Fixes`, `Closes`, etc.).
15. The PR↔PRD link is the **branch name**, taken verbatim from Linear's auto-generated `branchName`. Linear's GitHub integration recognises the branch and auto-transitions the PRD to **Done** when the PR merges. See ADR-0006.

## After (manual)

16. Review and merge the PR on GitHub. On merge, Linear's GitHub integration auto-transitions the **PRD → Done**.

## End-of-run warnings

If the run finishes without a path that will eventually transition the PRD to Done, tide warns you so you don't end up with stranded _In Progress_ PRDs:

- No PR was opened (you opted out, or the branch had nothing to push).
- A PR was opened but later closed without merging.

In both cases the PRD remains in **In Progress** and you'll need to transition it manually (or merge a follow-up PR on the same branch name).

## Resume

If a run aborted (infra FAIL, ctrl-c, etc.), re-run `tide run` from the base branch and pick the same PRD. Tide skips sub-issues already in a terminal state and skips any flagged `ready-for-human`, then queues the rest. PRD stays at _In Progress_ throughout.

## State summary

| Issue         | Pre-run requirement                                  | While its turn runs                      | On agent DONE                                                   | On agent BLOCKED / agent-FAIL                                 | On infra FAIL         |
| ------------- | ---------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- | --------------------- |
| **PRD**       | non-terminal state, labels `prd` + `ready-for-agent` | **In Progress** (set by tide on confirm) | stays **In Progress**; auto-transitions to **Done** on PR merge | stays **In Progress**                                         | stays **In Progress** |
| **Sub-issue** | non-terminal state, label `ready-for-agent`          | **In Progress**                          | **Done**                                                        | label flipped to `ready-for-human`; summarizer comment posted | unchanged             |

## Conventions locked in

- **Standalone PRD** (PRD with no labelled children): treat the PRD itself as the unit of work, applying the In Progress → Done lifecycle to the PRD itself.
- **No create-new path.** PRDs must be authored in Linear's UI before `tide run`. Tide is a pure runner.
- **Only direct children are queued.** Nested grandchildren of the picked PRD are not flattened into the queue.
- **PR body emits no closing magic words.** The branch name is the sole PR↔PRD link (ADR-0006). The PR body references the PRD identifier + URL informationally only.
- **All Linear writes happen from the tide host.** The sandbox does not see `LINEAR_API_KEY` (ADR-0005); agent code cannot make rogue Linear writes.
- **Excluded children are surfaced** in the pre-flight ("skipped 2 sub-issues — no `ready-for-agent` label"), not silently dropped.
- **PRD transitions to In Progress on confirm**, not before — a cancelled pre-flight doesn't mutate Linear state.
- **Workflow states are resolved by `state.type`** (lowest `position` tiebreak), so renaming "In Progress" to "Doing" on your team doesn't break tide.
