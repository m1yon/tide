---
name: tide-to-issues
description: Break a plan, spec, or PRD into independently-grabbable Linear sub-issues using tracer-bullet vertical slices, published via the Linear MCP server. Use when user wants to convert a PRD into Linear sub-issues in a tide-configured repo backed by Linear.
---

# Tide To Issues

Break a plan into independently-grabbable Linear sub-issues using vertical slices (tracer bullets).

This skill assumes the repo is tide-configured and uses Linear as its issue tracker. Team identity is read from `<repoRoot>/.tide/config.ts` (`linear.team`). If `.tide/config.ts` does not exist at the repo root, hard-stop and tell the user: "This skill requires `.tide/config.ts` at the repo root with a `linear.team` key. Run `tide setup` (or add the file) before invoking `tide-to-issues`." Do not prompt for the team mid-flow.

## Repo prefix on issue titles

Prefix every created or retitled issue with `[<repo>] ` (e.g. `[dotfiles] store repo in linear issues`). Compute `<repo>` from `git remote get-url origin` — last path segment, strip trailing `.git`. If `origin` is missing, hard-stop: "This skill requires an `origin` git remote. Run `git remote add origin <url>` first." Idempotent — never double-prefix. Applies to all new issues and sub-issues (regardless of parent) and title updates; titles only, not comment bodies.

All Linear operations go through the registered `linear-server` MCP server. Describe the operation you want to perform in prose ("create a Linear issue with title X, body Y, team `{linear.team}`, state Triage, labels [...], parentId `<prd-id>`") and pick the appropriate MCP tool at runtime; do not hardcode tool names.

Reference Linear issues by their team-prefixed identifier (e.g. `PER-42`), not by URL.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a Linear issue identifier (e.g. `PER-42`) as an argument, fetch it from Linear and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Issue titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

### 3. Draft vertical slices

Break the plan into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

Slices may be 'HITL' or 'AFK'. HITL slices require human interaction, such as an architectural decision or a design review. AFK slices can be implemented and merged without human interaction. Prefer AFK over HITL where possible.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
</vertical-slice-rules>

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Type**: HITL / AFK
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?

Iterate until the user approves the breakdown.

### 5. Publish the issues to Linear

For each approved slice, create a Linear issue in team `{linear.team}` (read from `.tide/config.ts`), in Linear's built-in **Triage** state, with `parentId` set to the PRD's Linear issue id and the assignee set to `me` on the create call. Prefix the title with `[<repo>] ` (children are not exempt because the parent already carries it). Apply exactly one category label: `bug` or `enhancement`, depending on whether the slice fixes a defect or delivers new capability. Do **not** apply the `prd` label — sub-issues are not PRDs. Use the issue body template below.

Publish issues in **dependency order** (blockers first) so that when you wire up the dependency graph the blocker's Linear id already exists.

After a dependent issue is created, express each "blocked by" relationship using Linear's native `IssueRelation` (type `blocks` from blocker → blocked, equivalently `blocked_by` from blocked → blocker). This is a separate Linear MCP call after the dependent issue exists; do not write the blocker into the issue body.

<issue-template>
## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

</issue-template>

The parent reference is carried natively by Linear's `parentId`, and blocker relationships are carried natively by `IssueRelation` — neither needs a section in the issue body.

Do NOT close or modify the parent PRD issue.

### 6. Offer bulk promotion to Backlog + `ready-for-agent`

After all sub-issues are created and their parent / blocker relations are wired up, output the Linear identifiers of the PRD and each new sub-issue (e.g. `PER-42`, `PER-43`, …) and prompt the user with a single yes/no question, **default yes**:

> Move PRD + N sub-issues to Backlog + `ready-for-agent`?

On **yes**: for the PRD and each newly-created sub-issue, if the issue is currently in Linear's **Triage** state, transition it to **Backlog** and add the `ready-for-agent` label. Skip any issue that is already in a non-Triage state (idempotency — the user may have promoted the PRD via `tide-triage` before running breakdown). Report which issues were transitioned and which were skipped.

This bulk promotion intentionally **does not** post the agent brief comment that `tide-triage`'s canonical `ready-for-agent` transition would. Sub-issues coming out of this flow have a structured body (`What to build` + `Acceptance criteria` derived from the approved PRD breakdown) and a parent PRD link, which together stand in for the brief. Do not emit a separate brief comment, and do not treat the absence of one as a defect when those issues are later picked up.

On **no**: leave everything in Triage. The user can promote individual issues later via `tide-triage` (which will then ask whether to write an agent brief at promotion time).
