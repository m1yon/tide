import { describe, it, expect } from "bun:test";
import { topoSort } from "./index.ts";

describe("topoSort", () => {
  it("sorts a simple chain A <- B <- C in [A, B, C] order", () => {
    // ENG-1 blocks ENG-2 blocks ENG-3.
    const r = topoSort([
      { id: "ENG-1", blockedBy: [], closed: false },
      { id: "ENG-2", blockedBy: ["ENG-1"], closed: false },
      { id: "ENG-3", blockedBy: ["ENG-2"], closed: false },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
  });

  it("produces a valid topo order on a diamond", () => {
    // ENG-1 blocks ENG-2 and ENG-3; ENG-2 and ENG-3 both block ENG-4.
    const r = topoSort([
      { id: "ENG-1", blockedBy: [], closed: false },
      { id: "ENG-2", blockedBy: ["ENG-1"], closed: false },
      { id: "ENG-3", blockedBy: ["ENG-1"], closed: false },
      { id: "ENG-4", blockedBy: ["ENG-2", "ENG-3"], closed: false },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const pos = new Map(r.order.map((n, i) => [n, i]));
      const get = (n: string): number => {
        const p = pos.get(n);
        if (p === undefined) throw new Error(`missing pos for ${n}`);
        return p;
      };
      expect(get("ENG-1")).toBeLessThan(get("ENG-2"));
      expect(get("ENG-1")).toBeLessThan(get("ENG-3"));
      expect(get("ENG-2")).toBeLessThan(get("ENG-4"));
      expect(get("ENG-3")).toBeLessThan(get("ENG-4"));
      // Tiebreaker: ENG-2 before ENG-3 (identifier asc).
      expect(get("ENG-2")).toBeLessThan(get("ENG-3"));
    }
  });

  it("breaks ties between simultaneously-unblocked nodes by identifier ascending", () => {
    const r = topoSort([
      { id: "ENG-5", blockedBy: [], closed: false },
      { id: "ENG-2", blockedBy: [], closed: false },
      { id: "ENG-8", blockedBy: [], closed: false },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order).toEqual(["ENG-2", "ENG-5", "ENG-8"]);
  });

  it("treats closed blockers as satisfied", () => {
    // ENG-100 is closed; ENG-102 is blocked by ENG-100 only -- should be ready immediately.
    const r = topoSort([
      { id: "ENG-100", blockedBy: [], closed: true },
      { id: "ENG-102", blockedBy: ["ENG-100"], closed: false },
    ]);
    expect(r.ok).toBe(true);
    // Closed nodes are not emitted in the order; only the open ones are.
    if (r.ok) expect(r.order).toEqual(["ENG-102"]);
  });

  it("returns external-blocker error when an open blocker is outside the input set", () => {
    const r = topoSort([
      { id: "ENG-200", blockedBy: ["ENG-99"], closed: false },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("external-blocker");
      if (r.error.kind === "external-blocker") {
        expect(r.error.issue).toBe("ENG-200");
        expect(r.error.blocker).toBe("ENG-99");
      }
    }
  });

  it("returns cycle error with edges when a cycle exists", () => {
    // ENG-10 blocked by ENG-11; ENG-11 blocked by ENG-10.
    const r = topoSort([
      { id: "ENG-10", blockedBy: ["ENG-11"], closed: false },
      { id: "ENG-11", blockedBy: ["ENG-10"], closed: false },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("cycle");
      if (r.error.kind === "cycle") {
        const edges = r.error.edges;
        const involved = new Set<string>();
        for (const e of edges) {
          involved.add(e.from);
          involved.add(e.to);
        }
        expect(involved.has("ENG-10")).toBe(true);
        expect(involved.has("ENG-11")).toBe(true);
      }
    }
  });
});
