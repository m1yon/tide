# PR submission as a Sandcastle iteration with a bundled, interface-emphasizing template

After `runIssueQueue` succeeds and the branch is ahead of base, `tide run` fires a final Sandcastle iteration whose sole job is to draft and submit the PR. The prompt template ships bundled in tide source (not user-editable like `.tide/prompt.md`) and structures the PR body around public-interface change — Ousterhout's framing: the change callers see is the change that matters.

## Considered

- **Host-side native + LLM call.** Cleaner separation between "do work in the sandbox" and "shape the repo from the host," but duplicates the git and `gh` access the sandbox already provides and requires a new LLM client integration.
- **Host-side native, no LLM.** Deterministic and cheap, but discards the interface-framing entirely; the resulting PR body would be a generic commit-list summary.
- **Stripped template** (Problem + Solution + Housekeeping only). Drops the interface-movement table and per-package breakdown — the highest-signal parts of the framing.
- **`<sub>Files-changed:</sub>` anchor links** under each package. Dropped from the bundled template: requires a two-phase `gh pr create` → `gh pr edit` flow to inject post-creation URLs, which adds failure modes for marginal reviewer benefit.
- **User-editable template at `.tide/pr-prompt.md`.** Rejected: PR shape is a property of tide itself, not the host repo. `.tide/prompt.md` is appropriately editable because it encodes per-repo coding conventions; the PR template is closer to public surface and should not drift per-user.

## Consequences

The PR step is a Sandcastle iteration that produces no commit, so the existing `isFailedRun` check (which requires either a commit or a completion signal) does not apply. Success is determined host-side via `gh pr list --head <branch>`. On re-runs the iteration uses `gh pr edit` to overwrite the existing PR body — accepted cost: silent overwrite of any hand-edits a user made to the body between runs.

The base branch is captured at `tide run` invocation via `git rev-parse --abbrev-ref HEAD` before any Sandcastle work, and threaded through to both the rev-list gate (`git rev-list --count <base>..<branch>`) and `gh pr create --base <base>`.

A pre-flight clack `confirm` ("Create a PR at the end?", default yes) gates whether the PR step fires at all — the only opt-out surface in v1; no `--no-pr` flag.
