// Pure topological sort over a set of issue nodes connected by `blockedBy`
// edges. Closed blockers are filtered out before sorting (a closed blocker
// can't actually block anything). Open blockers that reference issues
// outside the input set are reported as `external-blocker` errors. Cycles
// among open issues are reported as `cycle` errors.
//
// Among nodes that become simultaneously unblocked the deterministic
// tiebreaker is identifier ascending (lexicographic).

export interface DepNode {
  id: string;
  blockedBy: string[];
  closed: boolean;
}

export interface CycleEdge {
  from: string;
  to: string;
}

export type TopoResult =
  | { ok: true; order: string[] }
  | {
      ok: false;
      error:
        | { kind: "cycle"; edges: CycleEdge[] }
        | { kind: "external-blocker"; issue: string; blocker: string };
    };

export function topoSort(nodes: DepNode[]): TopoResult {
  const ids = new Set(nodes.map((n) => n.id));
  const closed = new Map(nodes.map((n) => [n.id, n.closed]));

  // Build the effective blockedBy edges: drop blockers that are closed (they
  // can't block) and surface external open blockers as errors.
  const effective = new Map<string, Set<string>>();
  for (const node of nodes) {
    const filtered = new Set<string>();
    for (const blocker of node.blockedBy) {
      if (!ids.has(blocker)) {
        return {
          ok: false,
          error: { kind: "external-blocker", issue: node.id, blocker },
        };
      }
      if (closed.get(blocker)) continue;
      filtered.add(blocker);
    }
    effective.set(node.id, filtered);
  }

  // Cycle detection via DFS over the open-issue subgraph. Closed nodes are
  // also excluded from the sort output (they're already done — emitting them
  // would re-enqueue completed work).
  const open = nodes.filter((n) => !n.closed).map((n) => n.id);
  const openSet = new Set(open);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of open) color.set(n, WHITE);

  const stack: string[] = [];

  function visit(n: string): { ok: true } | { ok: false; cycle: CycleEdge[] } {
    color.set(n, GRAY);
    stack.push(n);
    const blockers = effective.get(n) ?? new Set();
    for (const blocker of [...blockers].sort()) {
      if (!openSet.has(blocker)) continue;
      const c = color.get(blocker);
      if (c === GRAY) {
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

  // Kahn's algorithm with an identifier-asc tiebreaker. Edges point from
  // blocker -> blocked (a blocker must come first in topo order).
  const indeg = new Map<string, number>();
  const outEdges = new Map<string, Set<string>>();
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

  const ready = open.filter((n) => (indeg.get(n) ?? 0) === 0).sort();
  const order: string[] = [];
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
