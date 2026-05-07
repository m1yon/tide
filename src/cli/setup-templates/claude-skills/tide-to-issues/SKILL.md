---
name: tide-to-issues
description: Break a tide PRD into queueable Linear sub-issues — each child carries `ready-for-agent`, the `[<repo>] ` title prefix, the PRD as parent, and `blockedBy` relations for ordering.
---

# tide-to-issues

Take an existing tide **PRD** (a Linear issue carrying the `prd` label) and produce its **Sub-issues** — the units of work `tide run` will queue. Each sub-issue is one iteration's worth of work, scoped tightly enough that an agent can finish it in a single `tide run` pass.

## Pre-flight (hard-stop)

Read `<repoRoot>/.tide/config.ts`. If the file does not exist, stop immediately and emit this exact message, then halt:

> This skill (`tide-to-issues`) requires a tide-configured repo. Run `tide setup` from the repo root, then re-invoke `/tide-to-issues`.

If `.tide/config.ts` is present, parse it for the `linear.team` key and use that as the team identifier for every Linear write below.

## Inputs

Either:

- A Linear PRD identifier (e.g. `PER-42`) passed by the user. Fetch the PRD's title, description, and any existing comments before drafting sub-issues.
- A reference to a freshly authored PRD from `/tide-to-prd` (same shape — fetch it by id).

If the picked issue does not carry the `prd` label, refuse: tell the user to either label the parent as a PRD or run `/tide-to-prd` to author one.

## Repo prefix

Every Linear title this skill creates starts with `[<repo>] ` — open-bracket, the GitHub repo name returned by `gh repo view --json name -q .name`, close-bracket, single space. tide filters every Linear list query by this prefix; an unprefixed sub-issue is invisible to `tide run`. See ADR-0012.

## What you produce

One Linear issue per sub-issue you draft, each with:

- **Title**: `[<repo>] <short, intent-shaped headline>`. 6–10 words; active voice. The full set of sub-issue titles should read as a coherent plan, not as overlapping restatements of the PRD.
- **Description**: at minimum —
  - **What to build** — concrete, file/module-level scope.
  - **Acceptance criteria** — a checkbox list. Each item is verifiable in the PR (a test passes, a file exists with such-and-such bytes, a CLI invocation prints such-and-such).
  - **Out of scope** — what _not_ to do in this iteration (forward-references to sibling sub-issues are fine).
- **Labels**: `ready-for-agent`. Do _not_ apply `prd` (that's the parent).
- **Workflow state**: a non-terminal state (`Backlog` / `Todo` / lowest-position non-terminal). tide will move it to `In Progress` when its turn starts.
- **Parent**: the PRD's id.
- **Ordering**: where ordering matters, express it via Linear's `blockedBy` relations between sub-issues — not via title prefixes like `1.` or via numbered description rows. tide's `buildOrderedQueue` topologically sorts on `blockedBy`.

## Sub-issue sizing

Each sub-issue must be small enough to finish in a single `tide run` iteration. If you find yourself drafting one whose acceptance list spans more than a few PR-shaped checkboxes, split it. If you find yourself drafting one whose only acceptance criterion is "the PRD is done", you have not actually broken it down.

A reasonable test: imagine the agent emitting `<promise>DONE</promise>` after the iteration. Is the criterion you wrote checkable from the resulting commit + branch state? If not, tighten the criterion or split the sub-issue.

## Linear writes

Prefer the Linear MCP `create_issue` tool with `parentId`, `labelIds`, and `stateId`. Fall back to the Linear SDK (`client.createIssue({ teamId, title, description, parentId, labelIds, stateId })`). After creating two or more sub-issues, set up `blockedBy` relations between them with the MCP `create_issue_relation` tool or the SDK's `client.createIssueRelation({ issueId, relatedIssueId, type: "blocks" })`. Resolve every `stateId` by `state.type` (lowest `position` tiebreak) — never by display-name. See `docs/agents/issue-tracker.md`.

## After the sub-issues land

Print the parent PRD's id followed by each new sub-issue's id and one-line title. The user runs `tide run` from the code repo to start working through them.
