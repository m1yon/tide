---
name: tide-triage
description: Triage Linear issues in the tide team — apply the canonical label vocabulary (`needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), normalise titles to the `[<repo>] ` prefix, and move items out of the `Triage` state.
---

# tide-triage

Walk a batch of un-triaged Linear issues and decide, for each, what the next step is: ready for tide to pick up (`ready-for-agent`), needs more info from the reporter (`needs-info`), needs a human (`ready-for-human`), or rejected outright (`wontfix`). Move every issue out of the `Triage` workflow state as a side-effect of triaging — leaving an issue in `Triage` after a triage pass is the bug this skill exists to prevent (PER-51 / ADR-0009).

## Pre-flight (hard-stop)

Read `<repoRoot>/.tide/config.ts`. If the file does not exist, stop immediately and emit this exact message, then halt:

> This skill (`tide-triage`) requires a tide-configured repo. Run `tide setup` from the repo root, then re-invoke `/tide-triage`.

If `.tide/config.ts` is present, parse it for the `linear.team` key and use that as the team identifier for every Linear read and write below.

## Companion files (read these first)

- `AGENT-BRIEF.md` — the prompt-shaped summary of how to think while triaging an issue (what to look at, in what order, what to ask the human if anything's ambiguous).
- `OUT-OF-SCOPE.md` — what triage does _not_ do (no PRD authoring, no sub-issue cutting, no state transitions beyond moving out of `Triage`).

## Inputs

A list of Linear issues currently in the team's `Triage` workflow state. Resolve them with the MCP `list_issues` tool (or the SDK), filtered by `state: { type: { eq: "triage" } }` on the configured team. Process them one at a time — don't batch-update.

## Decision per issue

For each issue:

1. **Read the body and any comments**. Look at attachments, linked PRs, and the reporter's history if useful.
2. **Normalise the title**. If the title is missing the `[<repo>] ` prefix, prepend it (open-bracket, the GitHub repo name returned by `gh repo view --json name -q .name`, close-bracket, single space). Per ADR-0012, an unprefixed issue is invisible to `tide run`.
3. **Pick a next step** from the canonical label vocabulary in `docs/agents/triage-labels.md`:
   - **`ready-for-agent`** — the issue is fully specified, scoped to one iteration, and an agent can start. Apply the label and transition to a non-terminal non-`Triage` state (`Backlog` / `Todo`).
   - **`needs-info`** — the report is incomplete; the reporter needs to provide more before this is actionable. Apply the label, post a Linear comment listing the specific questions, and transition out of `Triage` to `Backlog` (or your team's "waiting on reporter" state).
   - **`ready-for-human`** — the work needs a person, not an agent (large refactor, ambiguous design call, security review). Apply the label and transition to a non-terminal non-`Triage` state.
   - **`wontfix`** — out of scope for the project. Transition to a `cancelled`-type state and post a brief Linear comment explaining why.

Removing the issue from `Triage` is mandatory in every branch — even on `wontfix`, the transition out of `Triage` is what closes the loop.

## Linear writes

Prefer the MCP `update_issue` (label set + new `stateId`) and `create_comment` tools. Fall back to the SDK (`client.updateIssue(id, { labelIds, stateId })`, `client.createComment({ issueId, body })`). The Linear API is set-based for labels — pass the full desired label list, not a delta. Resolve every `stateId` by `state.type` (lowest `position` tiebreak) — never by display-name. See `docs/agents/issue-tracker.md`.

## What this skill does _not_ do

See `OUT-OF-SCOPE.md`. In particular: it does not author PRDs (use `/tide-to-prd`), it does not cut sub-issues from a PRD (use `/tide-to-issues`), and it does not transition issues into terminal states except for `wontfix`.
