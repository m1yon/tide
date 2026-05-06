# Tide flow (Linear-native)

End-to-end user flow for `tide run` once issue tracking lives entirely in Linear. Code and PRs still live on GitHub; everything else (PRD, sub-issues, standalone issues, blockers, lifecycle states) is Linear. See ADR-0004 for the source-of-truth decision, ADR-0005 for the host-driven Linear writes boundary, ADR-0006 for the branch-name PR↔root link, and ADR-0008 for the Standalone Issue / context-only PRD split.

## One-time setup

Run `tide setup` once per Linear team. It idempotently creates the three labels tide reads from and writes to (`prd`, `ready-for-agent`, `ready-for-human`) on the team configured in `.tide/config.ts`. Re-running on a fully provisioned team is a no-op.

## Authoring (in Linear, before running)

You can author work in two shapes; tide picks up either as a "root" for one `tide run`.

- **PRD-rooted work.** Create a parent Linear issue with the high-level requirements. Apply the `prd` label only — _not_ `ready-for-agent` (PRDs are context, not units of work). Put it in a non-terminal state. Then create **Sub-issues** under it, one per unit of work, each carrying `ready-for-agent`. Use Linear's `blockedBy` relations to express ordering between sub-issues. A PRD with no `ready-for-agent` children (a **Standalone PRD**) is treated as still awaiting human triage and is invisible to `tide run` until at least one sub-issue exists.
- **Standalone Issue.** Create a single Linear issue carrying `ready-for-agent` (no `prd` label, no Linear parent). One iteration of work, queued and run on its own branch. Use this for work that doesn't need a separate planning context — typically the output of a triage pass on a single bug or small feature.

## Run

3. From your **base branch** in the code repo (`main` / `dev` / whatever you'll PR against), run `tide run`. Tide creates the feature-branch worktree itself; you don't switch branches first. If you invoke `tide run` from the feature branch by mistake, tide errors out — the feature branch must not also be the PR base.
4. Pick a root from the selector. The selector renders two sections, most-recently-updated first within each:
   - **PRDs** — every issue carrying the `prd` label with at least one `ready-for-agent` direct child, in a non-terminal state. Each option shows its `ready-for-agent` and `ready-for-human` sub-issue counts.
   - **Standalone Issues** — every issue carrying `ready-for-agent` with no Linear parent and no `prd` label, in a non-terminal state.
5. Tide shows the pre-flight:
   - For a **PRD root**: feature-branch name (PRD's auto-generated `branchName`), topo-sorted queue of `ready-for-agent` sub-issues, and a count of any direct children excluded for missing the label or being in a terminal state.
   - For a **Standalone Issue root**: feature-branch name (the Issue's auto-generated `branchName`), and a one-element queue (the Issue itself).
6. Confirm "Run N issue(s)?" Y/n. Then confirm "Create a PR at end?" Y/n.
7. On confirm, the **root transitions to In Progress** in Linear and the queue starts.

If the picked root is a non-PRD `ready-for-agent` issue that has Linear children, tide errors at this step ("non-PRD with children — label the parent as a `prd` or remove the children") and aborts before any Linear write.

## Per queued issue (visible in Linear's UI as it runs)

The state machine is identical for **Sub-issues** and **Standalone Issues**. For a Standalone-Issue root the queue length is 1 and the issue plays both the root and the unit-of-work role; the rules below compose without special-casing.

8. Issue transitions to **In Progress** when its turn starts (no-op if it's already In Progress because it's also the root).
9. The agent works in the sandbox, committing to the shared feature branch. Each commit is prefixed with `ref <linear-id>` (a non-closing Linear magic word) so it surfaces on the issue's timeline without forcing a state transition.
10. **DONE** signal from the agent → host transitions the issue to **Done**.
11. **BLOCKED** signal (the agent decided it's gracefully stuck) → host runs a summarizer agent that posts a concise comment on the issue explaining why, then flips the issue's label from `ready-for-agent` to `ready-for-human`. For a PRD-rooted run the queue continues; for a Standalone-Issue root the run ends here.
12. **Agent-FAIL** (no commits, no signal — the working agent silently gave up) → same as BLOCKED with a different summarizer prompt. Comment posted, label flipped, queue continues (or run ends, for a Standalone-Issue root).
13. **Infra FAIL** (sandcastle threw, fetch failed, etc.) → no label flip; the queue aborts so transient docker/network errors don't cascade. Re-run `tide run` to resume from the same base branch.

## Tail (if you said yes to the PR)

14. After the queue completes, tide pushes the feature branch to GitHub and opens a PR against the base branch you started from. The PR body references the **root** (PRD or Standalone Issue) by Linear identifier and URL for the reviewer's benefit but emits **no closing magic words** (`Fixes`, `Closes`, etc.). For a Standalone-Issue root the body's "Sub-issues addressed" list is omitted.
15. The PR↔root link is the **branch name**, taken verbatim from Linear's auto-generated `branchName` for the root issue. Linear's GitHub integration recognises the branch and auto-transitions the root issue to **Done** when the PR merges. See ADR-0006.

For a Standalone-Issue root, tide already drove the issue to **Done** on the agent's DONE signal — Linear's auto-transition on merge is therefore an idempotent no-op. If the run ended on BLOCKED / agent-FAIL but the human chose to merge the partial-work PR anyway, Linear will auto-transition the issue to **Done** despite a stale `ready-for-human` label; tide accepts this as semantically correct (merge ≡ human accepted).

## After (manual)

16. Review and merge the PR on GitHub. On merge, Linear's GitHub integration auto-transitions the **root → Done**.

## End-of-run warnings

If the run finishes without a path that will eventually transition the root to Done, tide warns you so you don't end up with stranded _In Progress_ roots:

- No PR was opened (you opted out, or the branch had nothing to push).
- A PR was opened but later closed without merging.
- For a Standalone-Issue root: the run ended on BLOCKED / agent-FAIL (issue is now flipped to `ready-for-human` and stays _In Progress_ until you resolve it, mirroring the Sub-issue case).

In all cases the root remains in **In Progress** and you'll need to transition it manually (or merge a follow-up PR on the same branch name).

## Resume

If a run aborted (infra FAIL, ctrl-c, etc.), re-run `tide run` from the base branch and pick the same root. Tide skips already-terminal issues and any flagged `ready-for-human`, then queues the rest. The root stays at _In Progress_ throughout. (For a Standalone-Issue root, "the rest" is just the issue itself — tide will re-run it.)

## State summary

| Issue                | Pre-run requirement                                    | While its turn runs                      | On agent DONE                                                               | On agent BLOCKED / agent-FAIL                                 | On infra FAIL         |
| -------------------- | ------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------- |
| **PRD** (root)       | non-terminal state, label `prd`, ≥1 labelled child     | **In Progress** (set by tide on confirm) | stays **In Progress**; auto-transitions to **Done** on PR merge             | stays **In Progress**                                         | stays **In Progress** |
| **Sub-issue**        | non-terminal state, label `ready-for-agent`            | **In Progress**                          | **Done**                                                                    | label flipped to `ready-for-human`; summarizer comment posted | unchanged             |
| **Standalone Issue** | non-terminal state, label `ready-for-agent`, no parent | **In Progress** (set by tide on confirm) | **Done** (host); auto-transitioned again by Linear on PR merge — idempotent | label flipped to `ready-for-human`; summarizer comment posted | unchanged             |

## Conventions locked in

- **PRDs are context-only.** A PRD's body and comments hydrate its Sub-issues' prompts; the agent never executes a PRD directly. PRDs carry `prd` only — _not_ `ready-for-agent` (ADR-0008).
- **Standalone Issue ≡ entry-point unit of work.** A `ready-for-agent` issue with no Linear parent and no `prd` label, runnable in a single iteration. Functionally identical to a Sub-issue but reached directly from the selector (ADR-0008).
- **A non-PRD with children errors on selection.** The picker shows it (it qualifies as a `ready-for-agent`-no-parent issue) but tide aborts on confirm with "label parent as `prd` or remove children" — no Linear writes happen.
- **A `ready-for-agent` issue under a non-PRD parent is invisible.** Standalone Issue requires _no_ Linear parent. Fix by removing the link or labelling the parent as a PRD.
- **Standalone PRD ≡ pre-triage state.** A PRD with no `ready-for-agent` Sub-issues is not selectable. Add at least one Sub-issue to make it selectable.
- **No create-new path.** PRDs and Standalone Issues must be authored in Linear's UI before `tide run`. Tide is a pure runner.
- **Only direct children of the picked PRD are queued.** Grandchildren are not flattened.
- **PR body emits no closing magic words.** The branch name is the sole PR↔root link (ADR-0006). The body references the root identifier + URL informationally only; the "Sub-issues addressed" list is present for PRD roots and omitted for Standalone-Issue roots.
- **All Linear writes happen from the tide host.** The sandbox does not see `LINEAR_API_KEY` (ADR-0005); agent code cannot make rogue Linear writes.
- **Excluded children are surfaced** in the pre-flight ("skipped 2 sub-issues — no `ready-for-agent` label"), not silently dropped.
- **Root transitions to In Progress on confirm**, not before — a cancelled pre-flight doesn't mutate Linear state.
- **Workflow states are resolved by `state.type`** (lowest `position` tiebreak), so renaming "In Progress" to "Doing" on your team doesn't break tide.
