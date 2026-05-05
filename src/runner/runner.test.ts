// Orchestration tests for `runIssueQueue` with the sandbox stubbed. The
// goal is contract coverage of the runner's per-iteration flow:
//
// - sub-issue is transitioned to In Progress *before* run() fires
// - DONE signal + commits → transition to Done, queue continues
// - BLOCKED signal → flip label to ready-for-human, post comment, continue
// - agent-FAIL (no DONE, no commits) → flip + comment + continue
// - infra FAIL (run() throws) → queue aborts, no label flip
// - per-iteration prompt args carry baseBranch through

import { describe, expect, test } from "bun:test";
import type { RunResult, RunOptions } from "@ai-hero/sandcastle";
import {
  BLOCKED_SIGNAL,
  DONE_SIGNAL,
  runIssueQueue,
  type OrderedIssue,
} from "./index.ts";
import type { TideConfig } from "../config-loader/index.ts";
import type { LinearContext, LinearIssueContent } from "../linear/index.ts";

const baseConfig: TideConfig = {
  linear: { team: "ENG" },
  sandbox: { mounts: [] },
  hooks: { onSandboxReady: [] },
};

const linearCtx: LinearContext = { apiKey: "lk", teamKey: "ENG" };

function makeIssueContent(
  overrides: Partial<LinearIssueContent> = {}
): LinearIssueContent {
  return {
    identifier: "ENG-1",
    title: "Sub-issue title",
    body: "Body text",
    comments: [],
    ...overrides,
  };
}

function makeOrdered(overrides: Partial<OrderedIssue> = {}): OrderedIssue {
  return {
    id: "uuid-eng-1",
    identifier: "ENG-1",
    title: "Sub-issue title",
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    iterations: [],
    completionSignal: DONE_SIGNAL,
    stdout: "",
    commits: [{ sha: "abc" }],
    branch: "feature/eng",
    ...overrides,
  };
}

describe("runIssueQueue — DONE signal + Linear transitions", () => {
  test("DONE + commits → transitions sub-issue to Done after the run", async () => {
    const events: string[] = [];

    const result = await runIssueQueue({
      parentIdentifier: "ENG-100",
      parentId: "uuid-prd",
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => {
        events.push("fetchContent");
        return Promise.resolve(makeIssueContent());
      },
      transitionToInProgress: (_ctx, issueId) => {
        events.push(`inProgress:${issueId}`);
        return Promise.resolve();
      },
      transitionToDone: (_ctx, issueId) => {
        events.push(`done:${issueId}`);
        return Promise.resolve();
      },
      sandcastleRun: () => {
        events.push("run");
        return Promise.resolve(makeRunResult());
      },
    });

    expect(result.completed).toBe(1);
    expect(result.abortedAt).toBeUndefined();
    // Order: in-progress fires *before* the agent runs; done fires *after*.
    expect(events).toEqual([
      "fetchContent", // parent body
      "fetchContent", // sub-issue body
      "inProgress:uuid-eng-1",
      "run",
      "done:uuid-eng-1",
    ]);
  });

  test("agent-FAIL (no commits + no signal) flips label, posts comment, and continues", async () => {
    const events: string[] = [];
    const flipCalls: string[] = [];
    const postedComments: { issueId: string; body: string }[] = [];
    let runCount = 0;

    const result = await runIssueQueue({
      parentIdentifier: "ENG-100",
      parentId: "uuid-prd",
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
      ],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: (_ctx, issueId) => {
        events.push(`inProgress:${issueId}`);
        return Promise.resolve();
      },
      transitionToDone: (_ctx, issueId) => {
        events.push(`done:${issueId}`);
        return Promise.resolve();
      },
      flipLabelToReadyForHuman: (_ctx, issueId) => {
        events.push(`flip:${issueId}`);
        flipCalls.push(issueId);
        return Promise.resolve();
      },
      postComment: (_ctx, issueId, body) => {
        events.push(`comment:${issueId}`);
        postedComments.push({ issueId, body });
        return Promise.resolve();
      },
      sandcastleRun: () => {
        events.push("run");
        runCount += 1;
        // First sub-issue agent-fails; second sub-issue succeeds.
        return Promise.resolve(
          runCount === 1
            ? makeRunResult({
                commits: [],
                completionSignal: undefined,
                preservedWorktreePath: "/path/to/worktree",
              })
            : makeRunResult()
        );
      },
    });

    expect(result.completed).toBe(1);
    expect(result.flipped).toBe(1);
    // No abort: queue continued past the agent-FAIL.
    expect(result.abortedAt).toBeUndefined();
    expect(flipCalls).toEqual(["uuid-1"]);
    // Comment was posted on the agent-failed sub-issue with a recognisable
    // FAIL reason and the preserved worktree path so a human can inspect it.
    expect(postedComments).toHaveLength(1);
    expect(postedComments[0]?.issueId).toBe("uuid-1");
    expect(postedComments[0]?.body).toContain("FAIL");
    expect(postedComments[0]?.body).toContain("ready-for-human");
    expect(postedComments[0]?.body).toContain("/path/to/worktree");
    // Order: flip happens before comment (flip is the queue-gating write).
    // Then the second sub-issue runs and reaches Done normally.
    expect(events).toEqual([
      "inProgress:uuid-1",
      "run",
      "flip:uuid-1",
      "comment:uuid-1",
      "inProgress:uuid-2",
      "run",
      "done:uuid-2",
    ]);
  });

  test("BLOCKED signal flips label, posts comment with BLOCKED reason, and continues", async () => {
    const events: string[] = [];
    const postedComments: { issueId: string; body: string }[] = [];
    let runCount = 0;

    const result = await runIssueQueue({
      parentIdentifier: "ENG-100",
      parentId: "uuid-prd",
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
      ],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: (_ctx, issueId) => {
        events.push(`inProgress:${issueId}`);
        return Promise.resolve();
      },
      transitionToDone: (_ctx, issueId) => {
        events.push(`done:${issueId}`);
        return Promise.resolve();
      },
      flipLabelToReadyForHuman: (_ctx, issueId) => {
        events.push(`flip:${issueId}`);
        return Promise.resolve();
      },
      postComment: (_ctx, issueId, body) => {
        events.push(`comment:${issueId}`);
        postedComments.push({ issueId, body });
        return Promise.resolve();
      },
      sandcastleRun: () => {
        events.push("run");
        runCount += 1;
        return Promise.resolve(
          runCount === 1
            ? makeRunResult({
                commits: [{ sha: "partial" }],
                completionSignal: BLOCKED_SIGNAL,
              })
            : makeRunResult()
        );
      },
    });

    expect(result.completed).toBe(1);
    expect(result.flipped).toBe(1);
    expect(result.abortedAt).toBeUndefined();
    expect(postedComments[0]?.body).toContain("BLOCKED");
    // The sub-issue's workflow state was NOT transitioned to Done.
    expect(events).not.toContain("done:uuid-1");
    // The flip-then-continue ordering is preserved.
    expect(events).toEqual([
      "inProgress:uuid-1",
      "run",
      "flip:uuid-1",
      "comment:uuid-1",
      "inProgress:uuid-2",
      "run",
      "done:uuid-2",
    ]);
  });

  test("BLOCKED registers BLOCKED_SIGNAL with sandcastle alongside DONE_SIGNAL", async () => {
    let capturedSignal: string | string[] | undefined;

    await runIssueQueue({
      parentIdentifier: "ENG-100",
      parentId: "uuid-prd",
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      flipLabelToReadyForHuman: () => Promise.resolve(),
      postComment: () => Promise.resolve(),
      sandcastleRun: (opts) => {
        capturedSignal = opts.completionSignal;
        return Promise.resolve(makeRunResult());
      },
    });

    // Sandcastle must short-circuit on either DONE or BLOCKED — pass both.
    expect(Array.isArray(capturedSignal)).toBe(true);
    if (Array.isArray(capturedSignal)) {
      expect(capturedSignal).toContain(DONE_SIGNAL);
      expect(capturedSignal).toContain(BLOCKED_SIGNAL);
    }
  });

  test("DONE signalled but no commits → routed through agent-FAIL flip path (continue, not abort)", async () => {
    const events: string[] = [];

    const result = await runIssueQueue({
      parentIdentifier: "ENG-100",
      parentId: "uuid-prd",
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => {
        events.push("inProgress");
        return Promise.resolve();
      },
      transitionToDone: () => {
        events.push("done");
        return Promise.resolve();
      },
      flipLabelToReadyForHuman: () => {
        events.push("flip");
        return Promise.resolve();
      },
      postComment: () => {
        events.push("comment");
        return Promise.resolve();
      },
      sandcastleRun: () =>
        Promise.resolve(
          makeRunResult({
            commits: [],
            completionSignal: DONE_SIGNAL,
          })
        ),
    });

    // No `done` event — Done transition never fires when the agent didn't
    // commit. But the queue did NOT abort — the issue was flipped instead.
    expect(result.abortedAt).toBeUndefined();
    expect(result.flipped).toBe(1);
    expect(events).toEqual(["inProgress", "flip", "comment"]);
  });

  test("commits without a DONE signal → routed through agent-FAIL flip path (continue, not abort)", async () => {
    const events: string[] = [];

    const result = await runIssueQueue({
      parentIdentifier: "ENG-100",
      parentId: "uuid-prd",
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => {
        events.push("inProgress");
        return Promise.resolve();
      },
      transitionToDone: () => {
        events.push("done");
        return Promise.resolve();
      },
      flipLabelToReadyForHuman: () => {
        events.push("flip");
        return Promise.resolve();
      },
      postComment: () => {
        events.push("comment");
        return Promise.resolve();
      },
      sandcastleRun: () =>
        Promise.resolve(
          makeRunResult({
            commits: [{ sha: "abc" }],
            completionSignal: undefined,
          })
        ),
    });

    expect(result.abortedAt).toBeUndefined();
    expect(result.flipped).toBe(1);
    expect(events).toEqual(["inProgress", "flip", "comment"]);
  });

  test("label-flip failure surfaces as an infra abort (no comment, no further sub-issues)", async () => {
    const events: string[] = [];

    const result = await runIssueQueue({
      parentIdentifier: "ENG-100",
      parentId: "uuid-prd",
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
      ],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      flipLabelToReadyForHuman: () => {
        events.push("flip");
        return Promise.reject(new Error("Linear write rate-limited"));
      },
      postComment: () => {
        events.push("comment");
        return Promise.resolve();
      },
      sandcastleRun: () =>
        Promise.resolve(
          makeRunResult({
            commits: [],
            completionSignal: BLOCKED_SIGNAL,
          })
        ),
    });

    expect(result.completed).toBe(0);
    expect(result.flipped).toBe(0);
    expect(result.abortedAt?.identifier).toBe("ENG-1");
    expect(result.abortedAt?.reason).toContain("label flip failed");
    expect(result.abortedAt?.reason).toContain("rate-limited");
    // Comment never fires when the flip failed.
    expect(events).toEqual(["flip"]);
  });

  test("infra FAIL (sandcastle threw) aborts without flipping any state", async () => {
    const events: string[] = [];

    const result = await runIssueQueue({
      parentIdentifier: "ENG-100",
      parentId: "uuid-prd",
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => {
        events.push("inProgress");
        return Promise.resolve();
      },
      transitionToDone: () => {
        events.push("done");
        return Promise.resolve();
      },
      sandcastleRun: () => Promise.reject(new Error("docker daemon down")),
    });

    expect(result.completed).toBe(0);
    expect(result.abortedAt?.reason).toContain("docker daemon down");
    // In Progress fired, but the run threw — no Done transition.
    expect(events).toEqual(["inProgress"]);
  });

  test("multi-issue queue: each sub-issue transitions In Progress → run → Done in order", async () => {
    const events: string[] = [];

    const result = await runIssueQueue({
      parentIdentifier: "ENG-100",
      parentId: "uuid-prd",
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
      ],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: (_ctx, issueId) =>
        Promise.resolve(makeIssueContent({ identifier: issueId })),
      transitionToInProgress: (_ctx, issueId) => {
        events.push(`inProgress:${issueId}`);
        return Promise.resolve();
      },
      transitionToDone: (_ctx, issueId) => {
        events.push(`done:${issueId}`);
        return Promise.resolve();
      },
      sandcastleRun: () => {
        events.push("run");
        return Promise.resolve(makeRunResult());
      },
    });

    expect(result.completed).toBe(2);
    expect(events).toEqual([
      "inProgress:uuid-1",
      "run",
      "done:uuid-1",
      "inProgress:uuid-2",
      "run",
      "done:uuid-2",
    ]);
  });

  test("transitions resolve states by `state.type` not by name (delegated to linear seam)", async () => {
    // Smoke: the runner doesn't itself look up state names; it just calls
    // the seam. This test pins the contract that the seam IS called with
    // the sub-issue's UUID — name-vs-type resolution lives in
    // `linear.transitionToInProgress` (covered there).
    const inProgressCalls: string[] = [];
    const doneCalls: string[] = [];

    await runIssueQueue({
      parentIdentifier: "ENG-100",
      parentId: "uuid-prd",
      orderedIssues: [makeOrdered({ id: "uuid-eng-1" })],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: (_ctx, issueId) => {
        inProgressCalls.push(issueId);
        return Promise.resolve();
      },
      transitionToDone: (_ctx, issueId) => {
        doneCalls.push(issueId);
        return Promise.resolve();
      },
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    expect(inProgressCalls).toEqual(["uuid-eng-1"]);
    expect(doneCalls).toEqual(["uuid-eng-1"]);
  });
});

describe("runIssueQueue — prompt args + sandcastle wiring", () => {
  test("registers both DONE and BLOCKED signals with sandcastle and forwards baseBranch as BASE_BRANCH", async () => {
    let capturedOpts: RunOptions | undefined;

    await runIssueQueue({
      parentIdentifier: "ENG-100",
      parentId: "uuid-prd",
      orderedIssues: [makeOrdered({ id: "uuid-eng-7", identifier: "ENG-7" })],
      branch: "user/feature/eng-7",
      baseBranch: "main",
      linearCtx,
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () =>
        Promise.resolve(makeIssueContent({ identifier: "ENG-7" })),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      flipLabelToReadyForHuman: () => Promise.resolve(),
      postComment: () => Promise.resolve(),
      sandcastleRun: (opts) => {
        capturedOpts = opts;
        return Promise.resolve(makeRunResult());
      },
    });

    expect(capturedOpts).toBeDefined();
    if (!capturedOpts) throw new Error("unreachable");
    expect(capturedOpts.completionSignal).toEqual([
      DONE_SIGNAL,
      BLOCKED_SIGNAL,
    ]);
    const args = capturedOpts.promptArgs as Record<string, string>;
    expect(args.BASE_BRANCH).toBe("main");
    expect(args.BRANCH).toBe("user/feature/eng-7");
    expect(args.ISSUE_ID).toBe("ENG-7");
  });

  test("legacy <promise>COMPLETE</promise> is no longer accepted as a success signal — flips through agent-FAIL", async () => {
    let doneCalls = 0;
    let flipCalls = 0;

    const result = await runIssueQueue({
      parentIdentifier: "ENG-100",
      parentId: "uuid-prd",
      orderedIssues: [makeOrdered()],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => {
        doneCalls += 1;
        return Promise.resolve();
      },
      flipLabelToReadyForHuman: () => {
        flipCalls += 1;
        return Promise.resolve();
      },
      postComment: () => Promise.resolve(),
      // The agent emitted the *old* COMPLETE signal — sandcastle wouldn't
      // even have matched it because the runner registers DONE/BLOCKED only.
      // We simulate the post-iteration result directly.
      sandcastleRun: () =>
        Promise.resolve(
          makeRunResult({
            commits: [{ sha: "abc" }],
            completionSignal: "<promise>COMPLETE</promise>",
          })
        ),
    });

    // No Done transition: COMPLETE is not success. The queue does not abort
    // (S5 routes non-success non-infra-fail outcomes through the flip-and-
    // continue path); the sub-issue is flipped to ready-for-human.
    expect(result.abortedAt).toBeUndefined();
    expect(doneCalls).toBe(0);
    expect(flipCalls).toBe(1);
    expect(result.flipped).toBe(1);
  });
});
