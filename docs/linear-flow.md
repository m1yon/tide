# Tide flow (Linear-native)

End-to-end user flow for `tide run` once issue tracking lives entirely in Linear. Code and PRs still live on GitHub; everything else (PRD, sub-issues, blockers, lifecycle states) is Linear.

## Setup (in Linear, before running)

1. Create the **PRD** — a parent Linear issue with the high-level requirements. Apply labels `prd` + `ready-for-agent`. Put it in a non-terminal state.
2. Create **sub-issues** under the PRD, one per unit of work. Apply `ready-for-agent` to each. Use Linear's `blockedBy` relations to express ordering.

## Run

3. From your **base branch** in the code repo (`main` / `dev` / whatever you'll PR against), run `tide run`. Tide creates the feature-branch worktree itself; you don't switch branches first.
4. Pick the PRD from the selector (lists every Linear issue on your team with `prd` + `ready-for-agent` in a non-terminal state, most-recently-updated first).
5. Tide shows the pre-flight: feature-branch name (from the PRD's auto-generated `branchName`), the topo-sorted queue of in-scope sub-issues, and a count of any children excluded for missing the label or being in a terminal state.
6. Confirm "Run N issue(s)?" Y/n. Then confirm "Create a PR at end?" Y/n.
7. On confirm, the **PRD transitions to In Progress** in Linear and the queue starts.

## Per sub-issue (visible in Linear's UI as it runs)

8. Sub-issue transitions to **In Progress** when its turn starts.
9. The agent works in the sandbox, committing to the shared feature branch.
10. On success → sub-issue transitions to **Done**.
11. On failure → sub-issue stays at **In Progress**, the run aborts, the worktree is preserved on disk, and the PRD also stays at **In Progress** for resume.

## Tail (if you said yes to the PR)

12. After all sub-issues are Done, tide pushes the feature branch to GitHub and opens a PR against the base branch you started from.
13. PR body references the PRD using Linear Magic Words (e.g. `Fixes ENG-123`) so Linear links them.

## After (manual)

14. Review and merge the PR on GitHub.
15. On merge, Linear's GitHub integration auto-transitions the **PRD → Done** via the Magic Words link.

## Resume

16. If a run aborted, run `tide run` from the base branch again and pick the same PRD. Tide skips children already in a terminal state and queues the rest. PRD stays at In Progress throughout.

## State summary

| Issue         | Pre-run requirement                                  | While its turn runs                      | On success                                                          | On failure            |
| ------------- | ---------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------- | --------------------- |
| **PRD**       | non-terminal state, labels `prd` + `ready-for-agent` | **In Progress** (set by tide on confirm) | stays **In Progress** until PR merges → then Magic-Words → **Done** | stays **In Progress** |
| **Sub-issue** | non-terminal state, label `ready-for-agent`          | **In Progress**                          | **Done**                                                            | stays **In Progress** |

## Conventions locked in

- **Standalone PRD** (no labelled children): treat the PRD itself as the unit of work, applying the In Progress → Done lifecycle to the PRD itself.
- **No create-new path.** PRDs must be authored in Linear's UI before `tide run`. Tide is a pure runner.
- **PR body uses Linear Magic Words** (`Fixes <PRD-ID>`) instead of GitHub `Closes #NN`.
- **Excluded children are surfaced** in the pre-flight ("skipped 2 sub-issues — no `ready-for-agent` label"), not silently dropped.
- **PRD transitions to In Progress on confirm**, not before — a cancelled pre-flight doesn't mutate Linear state.
