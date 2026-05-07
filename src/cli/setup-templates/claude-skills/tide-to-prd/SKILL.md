---
name: tide-to-prd
description: Author a tide PRD in Linear from a brief or conversation context — applies the `prd` label, writes the `[<repo>] ` title prefix, and leaves the issue in a non-terminal state ready for `/tide-to-issues`.
---

# tide-to-prd

Turn a high-level brief into a tide-runnable **PRD** in Linear. Output is a single Linear issue carrying the `prd` label (and only `prd` — _not_ `ready-for-agent`; PRDs are context, not units of work). Once the PRD exists, the user runs `/tide-to-issues` to break it down into queueable sub-issues.

## Pre-flight (hard-stop)

Read `<repoRoot>/.tide/config.ts`. If the file does not exist, stop immediately and emit this exact message, then halt:

> This skill (`tide-to-prd`) requires a tide-configured repo. Run `tide setup` from the repo root, then re-invoke `/tide-to-prd`.

If `.tide/config.ts` is present, parse it for the `linear.team` key and use that as the team identifier for every Linear write below.

## Repo prefix

Every Linear title this skill creates starts with `[<repo>] ` — open-bracket, the GitHub repo name returned by `gh repo view --json name -q .name`, close-bracket, single space. tide filters every Linear list query by `title: { startsWith: "[<repo>] " }`, so an unprefixed PRD will be invisible to `tide run`. Compute the prefix once at the start of the run and apply it verbatim. See ADR-0012.

## What you produce

A single Linear issue with:

- **Title**: `[<repo>] <short, intent-shaped headline>`. Aim for 6–10 words. Active-voice; describe the change, not the artifact (good: "make tide setup write bundled skills"; bad: "skills work").
- **Description**: a four-section body —
  1. **Problem** — the user-visible pain or constraint, in one paragraph.
  2. **Solution** — the smallest design that addresses it, naming the files / modules / data shapes that change.
  3. **Out of scope** — explicit non-goals so future sub-issues know where to stop.
  4. **Open questions** — anything you couldn't resolve from the brief; the human triages these before sub-issues are cut.
- **Labels**: `prd` only.
- **Workflow state**: a non-terminal state (`Backlog`, `Todo`, or whatever the team's lowest-position non-terminal state is). Do _not_ set it to `In Progress` — tide does that on selection.
- **Parent**: none. PRDs are roots.

Use the project's CONTEXT.md vocabulary in titles and bodies. Do not invent synonyms the glossary explicitly avoids.

## Linear write

Prefer the Linear MCP server's `create_issue` tool when it is available; fall back to the Linear SDK (`client.createIssue({ teamId, title, description, labelIds, stateId })`) otherwise. Resolve `stateId` from the team's workflow states by `state.type` (lowest `position` tiebreak) — never hard-code an id, never look up by display-name. See `docs/agents/issue-tracker.md`.

## After the PRD lands

Print the new issue's identifier (`PER-NN`) and URL, then suggest the user run `/tide-to-issues` against it to produce the sub-issue queue. Do _not_ create sub-issues yourself — that is the next skill's job, and splitting concerns lets the user review the PRD's wording before fanning out.

## Hand-off to `tide-to-issues`

The hand-off is implicit: a PRD with no `ready-for-agent` children is a **Standalone PRD** in tide vocabulary and is not selectable in `tide run` until at least one sub-issue is created under it. Running `/tide-to-issues <PER-NN>` is the next step.
