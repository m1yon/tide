# Branch name as the sole PR↔PRD link

The feature branch's name is the entire mechanism by which Linear's GitHub integration connects the PR to the PRD and auto-transitions the PRD to _Done_ on merge. Tide takes the branch name verbatim from the PRD's Linear-auto-generated `branchName` field, opens the PR against the user's captured base branch, and emits no closing magic words anywhere — neither GitHub `Closes #NN` nor Linear `Fixes MEC-X`.

## Considered

- **`Fixes MEC-PRD` in the PR body** in addition to the branch-name link. Belt-and-braces, but doubles up two mechanisms that produce the same transition. Rejected: redundant magic words make it harder to reason about which path actually fired the transition (a real concern when the integration misbehaves), and they leave the PR body cluttered with machine-syntax that adds nothing for human reviewers.
- **`Closes MEC-X` per sub-issue in the PR body.** Would let Linear close all sub-issues at once on merge and let tide skip the per-iteration transition call. Rejected: tide already drives sub-issues to _Done_ mid-run as each iteration completes, so the PR-merge close would be a no-op on already-Done issues. More importantly, mid-run transitions give the user real-time progress visibility in Linear's UI; deferring all closes to PR-merge time hides progress and conflates "agent finished this piece" with "code shipped."
- **Tide auto-transitions the PRD itself at end-of-clean-queue.** Avoids the no-merge stranding case where a user opts out of the PR step (or closes the PR without merging) and the PRD is stuck at _In Progress_ forever. Rejected: it races a real PR merge — tide marks the PRD _Done_ before the code lands — which inverts what _Done_ normally means in Linear. The stranded-PRD case is rare enough and visible enough that a warning at end-of-run is the right intervention.

## Consequences

The PR body retains the existing six-section emoji template (🚩 Problem, 💡 Solution, 🏗 Interface Movements, 📦 Package Breakdowns, 🧹 Housekeeping) for human readers, but no longer ends with `Closes #{{PARENT_ID}}`. The `{{PARENT_ID}}` and `{{PARENT_URL}}` substitutions point at the Linear PRD identifier and URL; they appear in the body only as a link to the originating PRD, not as a transition trigger.

Per-commit messages on the feature branch are prefixed with `ref MEC-X` — the _non-closing_ Linear magic word — to thread each commit to its sub-issue in Linear's timeline view without firing a transition (sub-issues are already transitioned host-side per ADR-0005). The previous `RALPH:` commit prefix is retired.

When the user opts out of the PR step, or opens a PR they later close without merging, the PRD is left at _In Progress_ with no automatic resolution. Tide warns about this at end-of-run; the user is expected to transition the PRD manually if shipping outside the tide-driven PR path. This is the conscious cost of refusing to forge a transition tide has no real signal for.
