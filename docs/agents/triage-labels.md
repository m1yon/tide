# Triage Labels

The skills speak in terms of canonical triage roles. This file maps those roles to the actual label strings used on the Linear team that hosts tide PRDs.

## Label scope

These labels live on the **Linear team** configured in `.tide/config.ts` (e.g. `PER`). They are distinct from any GitHub triage labels on the tide repo itself (`m1yon/tide`'s GitHub Issues use `needs-triage` / `enhancement` / `bug` etc.; those are the GitHub repo's own intake convention and are not read or written by tide).

`tide setup` provisions the three labels tide reads from and writes to (`prd`, `ready-for-agent`, `ready-for-human`) on the configured Linear team.

## Mapping

| Label in mattpocock/skills | Label on the Linear team | Meaning                                    |
| -------------------------- | ------------------------ | ------------------------------------------ |
| `needs-triage`             | `needs-triage`           | Maintainer needs to evaluate this issue    |
| `needs-info`               | `needs-info`             | Waiting on reporter for more information   |
| `ready-for-agent`          | `ready-for-agent`        | Fully specified, ready for tide to pick up |
| `ready-for-human`          | `ready-for-human`        | Requires human implementation / review     |
| `wontfix`                  | `wontfix`                | Will not be actioned                       |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table. Edit the right-hand column to match whatever vocabulary your team actually uses.

## Tide-driven label flip

Tide reads `ready-for-agent` to discover work and writes `ready-for-human` to gate work behind a human. The two labels are mutually exclusive on a given issue from tide's point of view — tide never has both set at once.

- **PRD discovery**: tide's selector lists every Linear issue carrying the `prd` label with at least one `ready-for-agent` direct child, in a non-terminal workflow state. PRDs themselves do **not** carry `ready-for-agent` — they're context, not units of work (ADR-0008).
- **Sub-issue discovery**: tide queues every direct child of the picked PRD that carries `ready-for-agent` and is in a non-terminal state. Children missing the label or already in a terminal state are surfaced as excluded counts in the pre-flight, not silently dropped.
- **Standalone Issue discovery**: tide's selector also lists every Linear issue carrying `ready-for-agent` with no Linear parent and no `prd` label, in a non-terminal workflow state. These are runnable in a single iteration without a parent PRD.
- **Pause a PRD, sub-issue, or Standalone Issue**: remove `ready-for-agent` in Linear's UI. For a PRD this means removing it from the sub-issues you want to pause (PRDs themselves don't carry the label). For sub-issues / Standalone Issues, removing the label takes them out of the queue; identity and state are preserved.
- **Tide-driven flip on BLOCKED / agent-FAIL**: when a working agent emits `<promise>BLOCKED</promise>`, or silently gives up (no commits + no signal), the host removes `ready-for-agent` and adds `ready-for-human` on the running issue (sub-issue or Standalone Issue). A summarizer agent posts a comment explaining what happened. For a PRD-rooted run the queue continues to the next sub-issue; for a Standalone-Issue root the run ends. See ADR-0004 for the source-of-truth split that makes this flip the queue's hand-off mechanism.
- **Resume after a flip**: a human reviews the issue, decides what to do, and (if the work is to continue automatically) flips the labels back: remove `ready-for-human`, add `ready-for-agent`. The next `tide run` picks it up again.

Tide does not flip labels on infrastructure failures (sandcastle threw, fetch failed, etc.) — those abort the queue without mutating Linear, so transient errors don't impose extra cleanup work.
