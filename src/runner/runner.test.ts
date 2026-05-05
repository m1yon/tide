// Orchestration tests for `runIssueQueue` with the sandbox stubbed. The
// goal is contract coverage of the runner's per-iteration flow:
//
// - sub-issue is transitioned to In Progress *before* run() fires
// - DONE signal + commits → transition to Done, queue continues
// - failed iteration (no DONE / no commits) → queue aborts, no Done
//   transition, preserved worktree path bubbles up
// - infra FAIL (run() throws) → queue aborts, no transitions fire
// - per-iteration prompt args carry baseBranch through

import { describe, expect, test } from "bun:test";
import type { RunResult, RunOptions } from "@ai-hero/sandcastle";
import { DONE_SIGNAL, runIssueQueue, type OrderedIssue } from "./index.ts";
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

  test("agent-FAIL (no commits + no signal) aborts the queue and never transitions to Done", async () => {
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
        return Promise.resolve(
          makeRunResult({
            commits: [],
            completionSignal: undefined,
            preservedWorktreePath: "/path/to/worktree",
          })
        );
      },
    });

    expect(result.completed).toBe(0);
    expect(result.abortedAt?.identifier).toBe("ENG-1");
    expect(result.abortedAt?.reason).toContain("no commit");
    expect(result.abortedAt?.preservedWorktreePath).toBe("/path/to/worktree");
    // First sub-issue transitioned to In Progress, then run failed.
    // No Done transition was issued; the second sub-issue never started.
    expect(events).toEqual(["inProgress:uuid-1", "run"]);
  });

  test("DONE signalled but no commits → still treated as failed (no Done transition)", async () => {
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
      sandcastleRun: () =>
        Promise.resolve(
          makeRunResult({
            commits: [],
            completionSignal: DONE_SIGNAL,
          })
        ),
    });

    expect(result.completed).toBe(0);
    expect(result.abortedAt?.reason).toMatch(/DONE without committing/);
    // No `done` event — Done transition never fires when the agent didn't
    // actually commit.
    expect(events).toEqual(["inProgress"]);
  });

  test("commits without a DONE signal → failed (the new prompt requires DONE)", async () => {
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
      sandcastleRun: () =>
        Promise.resolve(
          makeRunResult({
            commits: [{ sha: "abc" }],
            completionSignal: undefined,
          })
        ),
    });

    expect(result.completed).toBe(0);
    expect(result.abortedAt?.reason).toMatch(/did not emit/);
    expect(events).toEqual(["inProgress"]);
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
  test("registers DONE_SIGNAL with sandcastle and forwards baseBranch as BASE_BRANCH", async () => {
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
      sandcastleRun: (opts) => {
        capturedOpts = opts;
        return Promise.resolve(makeRunResult());
      },
    });

    expect(capturedOpts).toBeDefined();
    if (!capturedOpts) throw new Error("unreachable");
    expect(capturedOpts.completionSignal).toBe(DONE_SIGNAL);
    const args = capturedOpts.promptArgs as Record<string, string>;
    expect(args.BASE_BRANCH).toBe("main");
    expect(args.BRANCH).toBe("user/feature/eng-7");
    expect(args.ISSUE_ID).toBe("ENG-7");
  });

  test("legacy <promise>COMPLETE</promise> is no longer accepted as a success signal", async () => {
    let doneCalls = 0;

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
      // The agent emitted the *old* COMPLETE signal — sandcastle wouldn't
      // even have matched it because the runner registers DONE only. We
      // simulate the post-iteration result directly.
      sandcastleRun: () =>
        Promise.resolve(
          makeRunResult({
            commits: [{ sha: "abc" }],
            completionSignal: "<promise>COMPLETE</promise>",
          })
        ),
    });

    // Failed: COMPLETE is no longer treated as success, so no Done
    // transition fires and the queue aborts.
    expect(result.abortedAt).toBeDefined();
    expect(doneCalls).toBe(0);
  });
});
