# Standalone Issues; PRDs become context-only

Tide's runnable unit splits cleanly from its planning unit. **PRDs** are now context-only: they carry the `prd` label, never `ready-for-agent`, and the agent never executes a PRD directly — its body and comments hydrate the prompts of its **Sub-issues**. **Standalone Issues** — `ready-for-agent`-labelled issues with no Linear parent — become a first-class entry point alongside PRDs, runnable in a single iteration. The selector lists both kinds in two sections; the user picks exactly one root per `tide run`.

## Considered

- **Keep `prd` + `ready-for-agent` coupled on PRDs (status quo).** Rejected: the coupling forced any AFK-ready intake to graduate to a PRD before it could be picked up. Triage produces a `ready-for-agent` issue without a `prd` label; under the old rule that issue was invisible to `tide run`. The user-facing intent ("the agent will execute this directly") is sharper when `ready-for-agent` lives only on units the agent actually runs.
- **Drop the `prd` label entirely; one label everywhere.** Rejected for the same reasons ADR-0004 rejected it: PRDs and Sub-issues need distinct lifecycles (you pause a PRD by removing one label, you pause a Sub-issue by removing the label from that one issue). A single label collapses the planning role into the execution role.
- **Add a third label (e.g. `task`) to mark Standalone Issues distinctly from Sub-issues.** Rejected: Standalone Issues and Sub-issues are functionally identical (one iteration of work). The structural difference (PRD parent or not) is already encoded in Linear's parent/child graph; a second label re-encodes the same fact and creates drift opportunities.

## Consequences

The selector's queries change shape. PRDs are listed by `prd` label + has-`ready-for-agent`-direct-children. Standalone Issues are listed by `ready-for-agent` + no Linear parent. A PRD with no `ready-for-agent` children (a **Standalone PRD** in the new sense — pre-triage, awaiting breakdown) is invisible to the selector by construction.

This partially reverses ADR-0004's "a stray-labelled issue with no parent is malformed" premise. Such an issue is now a legitimate Standalone Issue. The other half of ADR-0004's reasoning — that PRDs and Sub-issues need distinct labels for distinct lifecycles — still stands.

A non-PRD issue with `ready-for-agent` and children appears in the picker's Standalone Issues section but errors on selection: the user must either label the parent as a PRD or remove the children. The error is the teaching moment; tide does not silently hide malformed issues.

A `ready-for-agent` issue whose parent is a non-PRD is invisible to tide. Standalone Issue requires _no_ Linear parent — a non-PRD parent does not promote the child to a Standalone Issue. The user fixes by removing the parent link or labelling the parent as a PRD.

Existing PRDs in Linear carry a residual `ready-for-agent` label from the old convention. The new selector ignores it; the residue is harmless and migration is documentation-driven.
