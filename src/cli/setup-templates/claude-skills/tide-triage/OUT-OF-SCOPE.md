# Out of scope for `tide-triage`

This skill is deliberately narrow. The boundary matters because every adjacent skill (`tide-to-prd`, `tide-to-issues`) has its own well-scoped job, and overlapping responsibility is how labels and states drift.

## Not done by this skill

- **PRD authoring.** If an issue is too big to be one iteration's work, the right next step is `/tide-to-prd`, not "rewrite the body in place and apply `prd`". Triage labels the issue and lets the human run the PRD-authoring skill explicitly.
- **Sub-issue cutting.** A PRD already in `Triage` should be triaged as a PRD (label as `prd`, transition out of `Triage`) and the human runs `/tide-to-issues` against it. Do not pre-emptively cut sub-issues from a `Triage`-state PRD.
- **State transitions to `In Progress` / `In Review` / `Done`.** Those are tide's writes (`tide run`, ADR-0009). Triage moves issues out of `Triage` to a non-terminal _Backlog-shape_ state — and into a `cancelled`-type terminal state on `wontfix`. Nothing else.
- **Closing PRD-rooted runs.** If you triage a `wontfix` on an issue that is a PRD with sub-issues, do not close the sub-issues. Comment on the PRD; let the human cancel the children deliberately.
- **Bulk triage.** Process one issue at a time. Bulk triage encourages skipping the read-in-this-order step and produces wrong labels.

## Adjacent decisions tide owns, not this skill

- The `ready-for-agent` ↔ `ready-for-human` flip on BLOCKED / agent-FAIL during a `tide run`. That's a tide-host write driven by the run's outcome (ADR-0004), not a triage decision.
- The PRD's `Triage → In Progress → In Review → Done` lifecycle. Tide drives the first three; Linear's GitHub integration drives the fourth on PR merge (ADR-0009).
- Repo-prefix _filtering_ (`title: { startsWith: "[<repo>] " }`). Tide enforces that on every fetch. This skill is responsible for _writing_ the prefix on triage; tide is responsible for filtering on it (ADR-0012).

## Adjacent decisions humans own, not this skill

- Whether a triage decision is correct after the fact. Triage is reversible — relabel and re-state if needed. Don't try to engineer triage to be perfect; engineer it to be cheap to revisit.
- Whether the canonical label vocabulary fits this team. The mapping table in `docs/agents/triage-labels.md` is editable per team. Don't redefine labels mid-triage.
