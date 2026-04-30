// Pure topological sort over a set of issue nodes connected by `blockedBy`
// edges. Closed blockers are filtered out before sorting (a closed blocker
// can't actually block anything). Open blockers that reference issues
// outside the input set are reported as `external-blocker` errors. Cycles
// among open issues are reported as `cycle` errors.
//
// Among nodes that become simultaneously unblocked the deterministic
// tiebreaker is issue-number ascending.

export interface DepNode {
  number: number;
  blockedBy: number[];
  closed: boolean;
}

export interface CycleEdge {
  from: number;
  to: number;
}

export type TopoResult =
  | { ok: true; order: number[] }
  | {
      ok: false;
      error:
        | { kind: "cycle"; edges: CycleEdge[] }
        | { kind: "external-blocker"; issue: number; blocker: number };
    };

export function topoSort(nodes: DepNode[]): TopoResult {
  const numbers = new Set(nodes.map((n) => n.number));
  const closed = new Map(nodes.map((n) => [n.number, n.closed]));

  // Build the effective blockedBy edges: drop blockers that are closed (they
  // can't block) and surface external open blockers as errors.
  const effective = new Map<number, Set<number>>();
  for (const node of nodes) {
    const filtered = new Set<number>();
    for (const blocker of node.blockedBy) {
      if (!numbers.has(blocker)) {
        // Blocker not in our scope. If it's a closed-and-thus-irrelevant
        // issue we'd never see it here at all (the caller should have
        // filtered the GitHub state of external refs); to be safe, report
        // anything we can't prove is closed as external.
        return {
          ok: false,
          error: { kind: "external-blocker", issue: node.number, blocker },
        };
      }
      if (closed.get(blocker)) continue;
      filtered.add(blocker);
    }
    effective.set(node.number, filtered);
  }

  // Cycle detection via DFS over the open-issue subgraph. Closed nodes are
  // also excluded from the sort output (they're already done — emitting them
  // would re-enqueue completed work).
  const open = nodes.filter((n) => !n.closed).map((n) => n.number);
  const openSet = new Set(open);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<number, number>();
  for (const n of open) color.set(n, WHITE);

  const stack: number[] = [];

  function visit(n: number): { ok: true } | { ok: false; cycle: CycleEdge[] } {
    color.set(n, GRAY);
    stack.push(n);
    const blockers = effective.get(n) ?? new Set();
    // Sort for determinism in the error path's edge list.
    for (const blocker of [...blockers].sort((a, b) => a - b)) {
      if (!openSet.has(blocker)) continue;
      const c = color.get(blocker);
      if (c === GRAY) {
        // Found a back-edge — extract the cycle path.
        const idx = stack.indexOf(blocker);
        const cyclePath = stack.slice(idx);
        cyclePath.push(blocker);
        const edges: CycleEdge[] = [];
        for (let i = 0; i < cyclePath.length - 1; i++) {
          const from = cyclePath[i];
          const to = cyclePath[i + 1];
          if (from === undefined || to === undefined) continue;
          edges.push({ from, to });
        }
        return { ok: false, cycle: edges };
      }
      if (c === WHITE) {
        const r = visit(blocker);
        if (!r.ok) return r;
      }
    }
    stack.pop();
    color.set(n, BLACK);
    return { ok: true };
  }

  for (const n of open) {
    if (color.get(n) === WHITE) {
      const r = visit(n);
      if (!r.ok) {
        return { ok: false, error: { kind: "cycle", edges: r.cycle } };
      }
    }
  }

  // Kahn's algorithm with an issue-number-asc tiebreaker. Edges point from
  // blocker -> blocked (a blocker must come first in topo order).
  const indeg = new Map<number, number>();
  const outEdges = new Map<number, Set<number>>();
  for (const n of open) {
    indeg.set(n, 0);
    outEdges.set(n, new Set());
  }
  for (const n of open) {
    for (const blocker of effective.get(n) ?? new Set()) {
      if (!openSet.has(blocker)) continue;
      const out = outEdges.get(blocker);
      if (out) out.add(n);
      indeg.set(n, (indeg.get(n) ?? 0) + 1);
    }
  }

  const ready = open
    .filter((n) => (indeg.get(n) ?? 0) === 0)
    .sort((a, b) => a - b);
  const order: number[] = [];
  while (ready.length > 0) {
    const n = ready.shift();
    if (n === undefined) break;
    order.push(n);
    for (const next of outEdges.get(n) ?? new Set()) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) {
        // Insert keeping ready sorted asc.
        let i = 0;
        while (i < ready.length) {
          const cur = ready[i];
          if (cur === undefined || cur >= next) break;
          i++;
        }
        ready.splice(i, 0, next);
      }
    }
  }

  return { ok: true, order };
}
