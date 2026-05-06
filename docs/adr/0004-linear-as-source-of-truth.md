# Linear as the source of truth for PRDs and sub-issues

Tide stops mirroring GitHub issues into Linear and treats Linear as the canonical home for the PRD and its sub-issues. Code and PRs still live on GitHub. The user authors a PRD and its sub-issues directly in Linear's UI; tide is a pure runner that discovers them by label, queues them by Linear's `blockedBy` relations, and never creates a Linear issue itself. Supersedes ADR-0002.

## Considered

- **Keep the mirror, polish it.** Continue treating GitHub as the source of truth and Linear as a read-mostly mirror. Rejected: the mirror's value collapses once we accept that planning, dependency expression, and lifecycle tracking are all already nicer in Linear than GitHub Issues; mirroring then costs us a sync surface for no offsetting benefit.
- **Single label as the marker** (`ready-for-agent` only). Cheaper vocabulary, but conflates "this is the unit of work tide can plan around" (the PRD) with "this is in scope for the next run" (sub-issues). Rejected: collapsing the two means you can't pause a PRD without untagging every child, and a stray-labelled issue with no parent becomes indistinguishable from a standalone PRD.
- **Custom field instead of label.** Considered for the same reasons as ADR-0002. Same rejection: labels are still the right primitive for a binary marker, and team-admin permissions on custom fields would push setup work onto every workspace.
- **Tide auto-creates the labels lazily.** Convenient, but the labels are user vocabulary now (not tide-owned scaffolding like the old `PRD` label). Auto-creating user vocabulary on first use feels presumptuous and makes typos hard to spot. A dedicated `tide setup` command creates the three labels (`prd`, `ready-for-agent`, `ready-for-human`) explicitly.

## Consequences

The marker scheme is two labels with distinct roles. **`prd`** (lowercase, distinct from the deprecated capital-`PRD` from ADR-0002) declares that an issue is a top-level work item tide can plan around. **`ready-for-agent`** declares that an issue is in scope for the next run; it appears on PRDs alongside `prd` and on each sub-issue. Removing `ready-for-agent` from a PRD pauses it without losing its identity; removing it from a sub-issue takes that single sub-issue out of the queue.

Sub-issues are direct Linear children of the picked PRD only — grandchildren are not flattened into the queue, in deliberate contrast with the previous GitHub-tree walker. Linear's UX nudges flat PRD/sub-issue shapes; tide leans into that and forces users to flatten when they want nesting queued.

There is no "create new Linear PRD" path. Tide is a pure runner. Existing pre-ADR-0002 Linear issues with the capital-`PRD` label do not appear in the new selector; backfill is a manual relabel.

The Linear team's "In Progress" and "Done" workflow states are resolved by `state.type` (`started` / `completed`) rather than by name, with the lowest-`position` state winning ties. This keeps tide robust to per-team renames ("Doing", "In Dev", "Shipped") that previously hard-failed at startup.
