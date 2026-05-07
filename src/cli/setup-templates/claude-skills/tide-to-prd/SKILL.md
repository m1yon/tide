---
name: tide-to-prd
description: Turn the current conversation context into a PRD and publish it to Linear via the Linear MCP server. Use when user wants to create a PRD from the current context in a tide-configured repo backed by Linear.
---

This skill takes the current conversation context and codebase understanding and produces a PRD. Do NOT interview the user — just synthesize what you already know.

This skill assumes the repo is tide-configured and uses Linear as its issue tracker. Team identity is read from `<repoRoot>/.tide/config.ts` (`linear.team`). If `.tide/config.ts` does not exist at the repo root, hard-stop and tell the user: "This skill requires `.tide/config.ts` at the repo root with a `linear.team` key. Run `tide setup` (or add the file) before invoking `tide-to-prd`." Do not prompt for the team mid-flow.

## Repo prefix on issue titles

Prefix every created or retitled issue with `[<repo>] ` (e.g. `[dotfiles] store repo in linear issues`). Compute `<repo>` from `git remote get-url origin` — last path segment, strip trailing `.git`. If `origin` is missing, hard-stop: "This skill requires an `origin` git remote. Run `git remote add origin <url>` first." Idempotent — never double-prefix. Titles only, not comment bodies.

All Linear operations go through the registered `linear-server` MCP server. Describe the operation you want to perform in prose ("create a Linear issue with title X, body Y, team `{linear.team}`, state Triage, labels [...]") and pick the appropriate MCP tool at runtime; do not hardcode tool names.

Reference Linear issues by their team-prefixed identifier (e.g. `PER-42`), not by URL.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the PRD, and respect any ADRs in the area you're touching.

2. Sketch out the major modules you will need to build or modify to complete the implementation. Actively look for opportunities to extract deep modules that can be tested in isolation.

A deep module (as opposed to a shallow module) is one which encapsulates a lot of functionality in a simple, testable interface which rarely changes.

Check with the user that these modules match their expectations. Check with the user which modules they want tests written for.

3. Write the PRD using the template below, then publish it to Linear: create a Linear issue in team `{linear.team}` (read from `.tide/config.ts`), in Linear's built-in **Triage** state, with the title set to a short summary prefixed with `[<repo>] `, the body set to the rendered template, and the assignee set to `me`. Apply two labels: `prd`, and one of `bug` or `enhancement` depending on whether the PRD describes a defect or new capability. Do not apply any other labels at creation — the Triage state is what makes the PRD show up in Linear's Triage inbox for explicit promotion.

4. After the issue is created, output the Linear issue identifier (e.g. `PER-42`) and suggest the user run `tide-to-issues` next to break the PRD down into sub-issues. Do **not** offer a "promote to ready-for-agent" prompt — PRDs are always parents of sub-issues, never units of work themselves, and promotion happens at the end of `tide-to-issues` once sub-issues exist.

<prd-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>
