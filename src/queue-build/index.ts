// Pure topo-ordering of a PRD's direct sub-issues.
//
// Extracted so both the CLI's pre-flight queue build and the runner's
// per-iteration queue rebuild (ADR-0010) can call it without a circular
// import. No GraphQL, no Linear writes — just labels + `blockedBy`.

import { type DepNode, topoSort } from "../dep-graph/index.ts";
import type { SubIssue } from "../linear/index.ts";

const READY_FOR_AGENT = "ready-for-agent";
const READY_FOR_HUMAN = "ready-for-human";
const TERMINAL_STATE_TYPES = new Set(["completed", "canceled"]);

export interface OrderedSubIssue {
  /** Linear UUID. */
  id: string;
  identifier: string;
  title: string;
}

export type BuildOrderedQueueResult =
  | { kind: "queue"; ordered: OrderedSubIssue[] }
  | { kind: "standalone" }
  | { kind: "error"; message: string };

/**
 * Pure: turn the picked PRD's direct sub-issues into an ordered queue.
 *
 * - Filters to direct children carrying the `ready-for-agent` label.
 * - If the filtered set is empty, returns `kind: "standalone"` — the caller
 *   treats the PRD itself as the unit of work.
 * - Closed (terminal-state) direct-child blockers are treated as satisfied.
 * - A `blockedBy` reference outside the picked PRD's children surfaces as
 *   an error mirroring the GitHub-path message shape.
 * - A cycle among open scoped sub-issues surfaces as a cycle error.
 */
export function buildOrderedQueue(
  subIssues: readonly SubIssue[]
): BuildOrderedQueueResult {
  const inScope = subIssues.filter((s) => s.labels.includes(READY_FOR_AGENT));
  if (inScope.length === 0) {
    return { kind: "standalone" };
  }
  const closedAmongDirectChildren = new Map(
    subIssues.map(
      (s) => [s.identifier, TERMINAL_STATE_TYPES.has(s.stateType)] as const
    )
  );

  const nodes: DepNode[] = inScope.map((s) => {
    const filtered = s.blockedBy.filter(
      // Drop blockers that are direct children in a terminal state — those
      // are satisfied. Any other blocker either is an in-scope sub-issue
      // (handled by topoSort) or surfaces as an external-blocker error.
      (b) => closedAmongDirectChildren.get(b) !== true
    );
    return {
      id: s.identifier,
      blockedBy: filtered,
      closed: TERMINAL_STATE_TYPES.has(s.stateType),
    };
  });

  const result = topoSort(nodes);
  if (!result.ok) {
    if (result.error.kind === "external-blocker") {
      const { issue, blocker } = result.error;
      // The blocker is in the picked PRD's direct children iff it appears in
      // `closedAmongDirectChildren` (which maps every direct child, not just
      // in-scope ones). Distinguish "out-of-scope direct child" from "truly
      // outside the PRD" so the message points at the right fix.
      const blockerDirectChild = subIssues.find(
        (s) => s.identifier === blocker
      );
      if (blockerDirectChild) {
        const labelHint = blockerDirectChild.labels.includes(READY_FOR_HUMAN)
          ? "carries `ready-for-human` (flagged for human review)"
          : "is missing the `ready-for-agent` label";
        return {
          kind: "error",
          message:
            `Sub-issue ${issue} is blocked by ${blocker}, a direct child of the picked PRD that ${labelHint}.\n` +
            `Resolve in Linear: re-add \`ready-for-agent\` to the blocker, remove the relationship, or close the blocker.`,
        };
      }
      return {
        kind: "error",
        message:
          `Sub-issue ${issue} is blocked by ${blocker}, which is open and outside the picked PRD's children.\n` +
          `Resolve by closing the blocker, removing the relationship, or expanding scope.`,
      };
    }
    const edges = result.error.edges
      .map((e) => `  ${e.from} -> ${e.to}`)
      .join("\n");
    return {
      kind: "error",
      message:
        `Dependency graph contains a cycle. Offending edges:\n${edges}\n\n` +
        "Resolve by removing one of the `blocked by` relationships in Linear, then re-run.",
    };
  }

  const byIdentifier = new Map(inScope.map((s) => [s.identifier, s]));
  const ordered: OrderedSubIssue[] = [];
  for (const id of result.order) {
    const sub = byIdentifier.get(id);
    if (!sub) continue;
    ordered.push({ id: sub.id, identifier: sub.identifier, title: sub.title });
  }
  return { kind: "queue", ordered };
}
