# Issue tracker: Linear

Issues and PRDs for tide-tracked work live in Linear. Tide is a pure runner that reads PRDs from Linear and writes state transitions back to Linear; it does not own a separate issue tracker. See ADR-0004 for why Linear is the source of truth and ADR-0005 for the host-side write boundary.

The `prd`, `ready-for-agent`, and `ready-for-human` labels are managed on the Linear team configured in `.tide/config.ts`. Run `tide setup` once per team to provision them. These labels are scoped to your Linear team and are unrelated to the GitHub triage labels on the tide repo itself (see `triage-labels.md`).

## Conventions

Authoring and editing issues happens in **Linear's UI** — there is no `tide issue create` or equivalent CLI surface. The recipes below cover the operations a skill needs to perform programmatically (read, comment, label) via the Linear MCP server or, when MCP is not available, the Linear SDK.

- **Create an issue / PRD**: in Linear's UI. PRDs need both `prd` and `ready-for-agent` labels and a non-terminal workflow state. Sub-issues need `ready-for-agent` and a parent link to the PRD; use Linear's `blockedBy` relations for ordering.
- **Read an issue**: Linear MCP `get_issue` tool with the issue identifier (e.g. `PER-42`). With the SDK: `client.issue("PER-42")`. To include comments, use `get_issue_comments` (MCP) or `(await client.issue("PER-42")).comments()` (SDK).
- **List issues**: Linear MCP `list_issues` with team + label filters. With the SDK: `client.issues({ filter: { team: { key: { eq: "<TEAM>" } }, labels: { name: { eq: "<label>" } } } })`. Filter workflow state by `state.type` (e.g. `state: { type: { in: ["unstarted", "started"] } }`), not by name — names are user-renameable.
- **Comment on an issue**: Linear MCP `create_comment`. With the SDK: `client.createComment({ issueId, body })`.
- **Apply / remove labels**: Linear MCP `update_issue` with the new label set. With the SDK: `client.updateIssue(issueId, { labelIds: [...] })`. The Linear API is set-based — pass the full desired label-id list, not a delta.
- **Transition state**: Linear MCP `update_issue` with a `stateId`. With the SDK: `client.updateIssue(issueId, { stateId })`. Resolve `stateId` from the team's workflow states by `state.type` (lowest `position` tiebreak) — never hard-code an id, never look up by display name.
- **Close**: closure in Linear is just a workflow-state transition to a state of `type` `completed` or `canceled` — there is no separate close verb. Tide itself never closes PRDs directly; the PRD auto-transitions to _Done_ when the linked PR merges, via the branch-name link (ADR-0006).

The configured team key lives in `.tide/config.ts` (`linear.team`). Tide's Linear writes happen exclusively from the host using `LINEAR_API_KEY` from `.tide/.env`; that key is not forwarded into the sandbox (ADR-0005), so agent code running in-sandbox cannot make Linear writes directly.

## When a skill says "publish to the issue tracker"

Create a Linear issue in the configured team. If the work is a tide PRD, add the `prd` and `ready-for-agent` labels.

## When a skill says "fetch the relevant ticket"

Resolve by Linear identifier (e.g. `PER-42`) using the MCP `get_issue` tool or `client.issue("PER-42")` with the SDK, then fetch comments and labels off the returned issue.
