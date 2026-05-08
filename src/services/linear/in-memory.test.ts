// Runs the LinearService contract against `InMemoryLinearService` plus a
// small handful of in-memory-specific scenarios (failure injection,
// observation methods) that the contract intentionally doesn't cover.

import { describe, expect, test } from "bun:test";
import { linearServiceContract } from "./contract.ts";
import { InMemoryLinearService } from "./in-memory.ts";

linearServiceContract(
  "InMemoryLinearService",
  () => new InMemoryLinearService({ inReviewStatePresent: false })
);

describe("InMemoryLinearService — failure injection + observation", () => {
  test("failNext makes the next call to that method throw and is one-shot", async () => {
    const svc = new InMemoryLinearService();
    svc.failNext("transitionToInProgress", new Error("rate limited"));

    let caught: unknown;
    try {
      await svc.transitionToInProgress("uuid-1");
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toMatch(/rate limited/);

    // Second call succeeds (one-shot).
    await svc.transitionToInProgress("uuid-1");
    expect(svc.transitionsOf("uuid-1")).toEqual(["In Progress"]);
  });

  test("transitionsOf records each transition in order across In Progress, Done, In Review", async () => {
    const svc = new InMemoryLinearService();
    await svc.transitionToInProgress("uuid-1");
    await svc.transitionToDone("uuid-1");
    await svc.transitionToInReview("uuid-1");
    expect(svc.transitionsOf("uuid-1")).toEqual([
      "In Progress",
      "Done",
      "In Review",
    ]);
  });

  test("commentsOn collects bodies in posting order", async () => {
    const svc = new InMemoryLinearService();
    await svc.postComment("uuid-1", "first");
    await svc.postComment("uuid-1", "second");
    expect(svc.commentsOn("uuid-1")).toEqual(["first", "second"]);
  });

  test("flipLabelToReadyForHuman swaps ready-for-agent for ready-for-human, preserves unrelated labels", async () => {
    const svc = new InMemoryLinearService({
      initialLabels: { "uuid-1": ["ready-for-agent", "area:auth"] },
    });
    await svc.flipLabelToReadyForHuman("uuid-1");
    expect(svc.labelsOf("uuid-1").sort()).toEqual([
      "area:auth",
      "ready-for-human",
    ]);
  });

  test("flipLabelToReadyForHuman is idempotent when ready-for-human is already present", async () => {
    const svc = new InMemoryLinearService({
      initialLabels: {
        "uuid-1": ["ready-for-agent", "ready-for-human"],
      },
    });
    await svc.flipLabelToReadyForHuman("uuid-1");
    expect(svc.labelsOf("uuid-1")).toEqual(["ready-for-human"]);
  });

  test("setFetchSubIssuesHandler overrides the default state-based response", async () => {
    const svc = new InMemoryLinearService({
      subIssuesByParent: {
        "uuid-prd": [
          {
            id: "uuid-1",
            identifier: "ENG-1",
            title: "from seed",
            state: "Backlog",
            stateType: "backlog",
            labels: ["ready-for-agent"],
            blockedBy: [],
          },
        ],
      },
    });

    let calls = 0;
    svc.setFetchSubIssuesHandler(() => {
      calls += 1;
      return Promise.resolve([]);
    });
    expect(await svc.fetchSubIssues("uuid-prd")).toEqual([]);
    expect(calls).toBe(1);

    svc.setFetchSubIssuesHandler(null);
    const restored = await svc.fetchSubIssues("uuid-prd");
    expect(restored.map((s) => s.identifier)).toEqual(["ENG-1"]);
  });

  test("assertInReviewStatePresent throws with the tide setup hint when the state is missing", async () => {
    const svc = new InMemoryLinearService({ inReviewStatePresent: false });
    let caught: unknown;
    try {
      await svc.assertInReviewStatePresent();
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toMatch(/In Review/);
    expect((caught as Error).message).toMatch(/tide setup/);
  });
});
