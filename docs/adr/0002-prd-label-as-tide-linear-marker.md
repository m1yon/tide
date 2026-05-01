# PRD label as the tide↔Linear marker

Tide marks every Linear issue it tracks with a hardcoded `PRD` label, scoped to the configured Linear team, and auto-creates the label on first use if it's missing. The label — not a title prefix — is the canonical signal that an issue is tide-tracked, and it's the only filter `tide run` uses to populate the "use existing PRD" select.

## Considered

- **Title-prefix marker (`[GH-#NN]`).** The previous convention. Pinned the Linear↔GitHub correlation to title text, breaking silently on rename and forcing `createIssueForParent` to own the title format. Rejected: the prefix is being removed anyway, and it conflated "is this a tide PRD?" with "which GH parent does this track?".
- **Custom field on the Linear issue.** More structured than a label, but team-admin permissions on custom fields are messier and tide would need configuration for the field's UUID per workspace. Labels are the right primitive for a binary marker.
- **Hard-fail when the label is missing** (matching the `In Progress` workflow-state pattern). Rejected: workflow states are user-defined Linear primitives that tide _references_; the PRD label is something tide _owns_ (writes on every create, reads for discovery). For owned markers, lazy auto-create is more honest than "you must hand-craft tide's marker before using tide."

## Consequences

The label is load-bearing. Anyone editing `createIssueForParent` to drop the label, or hand-creating Linear issues without it, makes those issues invisible to `tide run`'s discovery select. That's the intended contract — manual relinking via paste-by-ID is deliberately not supported, since the label is meant to be the only correlation surface.

There is no machine correlation between a specific GitHub parent and a specific Linear PRD. The select shows every PRD-labelled issue on the team (filtered to non-completed, non-cancelled workflow states), and the human picks the match. Re-introducing automatic GH↔Linear correlation later would require a new marker (attachment, custom field, or description-body parse) on top of the label.

Existing tide-created Linear issues from before this decision do not carry the label and will not appear in the select until labelled. Backfill is out of scope and tracked separately if it becomes painful in practice.
