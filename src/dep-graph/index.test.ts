import { describe, it, expect } from "bun:test";
import { topoSort } from "./index.ts";

describe("topoSort", () => {
  it("sorts a simple chain A <- B <- C in [A, B, C] order", () => {
    // A blocks B blocks C: B has blockedBy [A]; C has blockedBy [B].
    const r = topoSort([
      { number: 1, blockedBy: [], closed: false },
      { number: 2, blockedBy: [1], closed: false },
      { number: 3, blockedBy: [2], closed: false },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order).toEqual([1, 2, 3]);
  });

  it("produces a valid topo order on a diamond", () => {
    // 1 blocks 2 and 3; 2 and 3 both block 4.
    const r = topoSort([
      { number: 1, blockedBy: [], closed: false },
      { number: 2, blockedBy: [1], closed: false },
      { number: 3, blockedBy: [1], closed: false },
      { number: 4, blockedBy: [2, 3], closed: false },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const pos = new Map(r.order.map((n, i) => [n, i]));
      const get = (n: number): number => {
        const p = pos.get(n);
        if (p === undefined) throw new Error(`missing pos for ${String(n)}`);
        return p;
      };
      expect(get(1)).toBeLessThan(get(2));
      expect(get(1)).toBeLessThan(get(3));
      expect(get(2)).toBeLessThan(get(4));
      expect(get(3)).toBeLessThan(get(4));
      // Tiebreaker: 2 before 3 (issue-number asc).
      expect(get(2)).toBeLessThan(get(3));
    }
  });

  it("breaks ties between simultaneously-unblocked nodes by issue number ascending", () => {
    const r = topoSort([
      { number: 5, blockedBy: [], closed: false },
      { number: 2, blockedBy: [], closed: false },
      { number: 8, blockedBy: [], closed: false },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order).toEqual([2, 5, 8]);
  });

  it("treats closed blockers as satisfied", () => {
    // 100 is closed; 102 is blocked by 100 only -- should be ready immediately.
    const r = topoSort([
      { number: 100, blockedBy: [], closed: true },
      { number: 102, blockedBy: [100], closed: false },
    ]);
    expect(r.ok).toBe(true);
    // Closed nodes are not emitted in the order; only the open ones are.
    if (r.ok) expect(r.order).toEqual([102]);
  });

  it("returns external-blocker error when an open blocker is outside the input set", () => {
    const r = topoSort([{ number: 200, blockedBy: [99], closed: false }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("external-blocker");
      if (r.error.kind === "external-blocker") {
        expect(r.error.issue).toBe(200);
        expect(r.error.blocker).toBe(99);
      }
    }
  });

  it("returns cycle error with edges when a cycle exists", () => {
    // 10 blocked by 11; 11 blocked by 10.
    const r = topoSort([
      { number: 10, blockedBy: [11], closed: false },
      { number: 11, blockedBy: [10], closed: false },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("cycle");
      if (r.error.kind === "cycle") {
        const edges = r.error.edges;
        const involved = new Set<number>();
        for (const e of edges) {
          involved.add(e.from);
          involved.add(e.to);
        }
        expect(involved.has(10)).toBe(true);
        expect(involved.has(11)).toBe(true);
      }
    }
  });
});
