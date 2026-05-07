// Orchestration tests for `runIssueQueue` with the per-iteration
// `sandcastle.run(...)` call stubbed. The goal is contract coverage of the
// runner's per-iteration flow:
//
// - sub-issue is transitioned to In Progress *before* sandcastle.run() fires
// - each working-agent iteration uses `branchStrategy: 'merge-to-head'` and
//   `cwd: featureWorktreePath`
// - DONE signal + commits → transition to Done, queue continues
// - BLOCKED signal → run summarizer (separate sandcastle.run call), post
//   summarizer-generated comment, flip label, continue
// - agent-FAIL (no DONE, no commits) → same path as BLOCKED with the
//   `fail-summary` prompt
// - infra FAIL (run() throws) → queue aborts, no label flip, no summarizer
// - per-iteration prompt args carry baseBranch through

import { describe, expect, test } from "bun:test";
import type { RunOptions, RunResult } from "@ai-hero/sandcastle";
import {
  BLOCKED_SIGNAL,
  DONE_SIGNAL,
  runIssueQueue,
  type OrderedIssue,
  type ShellResult,
  type ShellRunner,
} from "./index.ts";
import type { TideConfig } from "../config-loader/index.ts";
import type {
  LinearContext,
  LinearIssueContent,
  SubIssue,
} from "../linear/index.ts";

/**
 * Map a runner's `OrderedIssue[]` into the `SubIssue[]` shape that
 * `fetchSubIssues` returns, with `ready-for-agent` labels and no blockers.
 * Used by tests to seed the per-boundary queue rebuild (ADR-0010) so
 * iteration ≥2 has the same candidate set as the pre-flight queue. Tests
 * that only need a single iteration can simply pass `() => []`.
 */
function asSubIssues(orderedIssues: OrderedIssue[]): SubIssue[] {
  return orderedIssues.map((o) => ({
    id: o.id,
    identifier: o.identifier,
    title: o.title,
    state: "Backlog",
    stateType: "backlog",
    labels: ["ready-for-agent"],
    blockedBy: [],
  }));
}

interface ShellCall {
  cmd: string;
  args: readonly string[];
  cwd: string;
}

function recordingShellRunner(
  result: ShellResult = { exitCode: 0, stdout: "", stderr: "" }
): { runner: ShellRunner; calls: ShellCall[] } {
  const calls: ShellCall[] = [];
  const runner: ShellRunner = (cmd, args, cwd) => {
    calls.push({ cmd, args: [...args], cwd });
    return Promise.resolve(result);
  };
  return { runner, calls };
}

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
    branch: "feature/eng-1",
    logFilePath: "/tmp/working.log",
    ...overrides,
  };
}

describe("runIssueQueue — DONE signal + Linear transitions", () => {
  test("DONE + commits → transitions sub-issue to Done after the run", async () => {
    const events: string[] = [];

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
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

  test("agent-FAIL (no commits + no signal) runs summarizer, posts its output, flips, continues", async () => {
    const events: string[] = [];
    const flipCalls: string[] = [];
    const postedComments: { issueId: string; body: string }[] = [];
    const sandboxRunNames: string[] = [];
    let runCount = 0;

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
      ],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () =>
        Promise.resolve(
          asSubIssues([
            makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
            makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
          ])
        ),
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
      sandcastleRun: (opts: RunOptions) => {
        events.push(`run:${opts.name ?? "unknown"}`);
        sandboxRunNames.push(opts.name ?? "unknown");
        runCount += 1;
        // First call: working agent agent-fails. Second call: summarizer
        // for the failed sub-issue. Third: working agent of next sub-issue
        // succeeds.
        if (runCount === 1) {
          return Promise.resolve(
            makeRunResult({
              commits: [],
              completionSignal: undefined,
              logFilePath: "/tmp/eng-1-working.log",
            })
          );
        }
        if (runCount === 2) {
          return Promise.resolve(
            makeRunResult({
              commits: [],
              completionSignal: undefined,
              logFilePath: "/tmp/eng-1-summarizer.log",
            })
          );
        }
        return Promise.resolve(makeRunResult());
      },
      readFinalAssistantMessage: (logFilePath: string) => {
        events.push(`extract:${logFilePath}`);
        if (logFilePath === "/tmp/eng-1-summarizer.log") {
          return Promise.resolve(
            "Tide flipped this to ready-for-human. The agent ran out of iterations without committing."
          );
        }
        return Promise.resolve(
          "I tried but ran out of ideas. Bailing without committing."
        );
      },
    });

    expect(result.completed).toBe(1);
    expect(result.flipped).toBe(1);
    expect(result.abortedAt).toBeUndefined();
    expect(flipCalls).toEqual(["uuid-1"]);
    // The posted comment is the SUMMARIZER's output (not a placeholder).
    expect(postedComments).toHaveLength(1);
    expect(postedComments[0]?.issueId).toBe("uuid-1");
    expect(postedComments[0]?.body).toBe(
      "Tide flipped this to ready-for-human. The agent ran out of iterations without committing."
    );
    // Two sandbox.run calls fired for the failed sub-issue: working agent
    // and summarizer. The second sub-issue used one more.
    expect(sandboxRunNames).toEqual(["tide", "tide-summarizer", "tide"]);
    // Order: working run → extract working transcript → summarizer run →
    // extract summarizer's final message → flip → comment → next sub-issue.
    expect(events).toEqual([
      "inProgress:uuid-1",
      "run:tide",
      "extract:/tmp/eng-1-working.log",
      "run:tide-summarizer",
      "extract:/tmp/eng-1-summarizer.log",
      "flip:uuid-1",
      "comment:uuid-1",
      "inProgress:uuid-2",
      "run:tide",
      "done:uuid-2",
    ]);
  });

  test("BLOCKED signal runs summarizer with the BLOCKED prompt, posts output, flips, continues", async () => {
    const events: string[] = [];
    const postedComments: { issueId: string; body: string }[] = [];
    let summarizerPromptSeen: string | undefined;
    let runCount = 0;

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
      ],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () =>
        Promise.resolve(
          asSubIssues([
            makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
            makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
          ])
        ),
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
      sandcastleRun: (opts: RunOptions) => {
        events.push(`run:${opts.name ?? "unknown"}`);
        runCount += 1;
        if (runCount === 1) {
          return Promise.resolve(
            makeRunResult({
              commits: [{ sha: "partial" }],
              completionSignal: BLOCKED_SIGNAL,
              logFilePath: "/tmp/eng-1-working.log",
            })
          );
        }
        if (runCount === 2) {
          summarizerPromptSeen =
            typeof opts.prompt === "string" ? opts.prompt : undefined;
          return Promise.resolve(
            makeRunResult({
              commits: [],
              completionSignal: undefined,
              logFilePath: "/tmp/eng-1-summarizer.log",
            })
          );
        }
        return Promise.resolve(makeRunResult());
      },
      readFinalAssistantMessage: (logFilePath: string) => {
        if (logFilePath === "/tmp/eng-1-summarizer.log") {
          return Promise.resolve(
            "Linear comment summarizing the BLOCKED reason."
          );
        }
        return Promise.resolve("blocked: linear API key is missing");
      },
    });

    expect(result.completed).toBe(1);
    expect(result.flipped).toBe(1);
    expect(result.abortedAt).toBeUndefined();
    expect(postedComments[0]?.body).toBe(
      "Linear comment summarizing the BLOCKED reason."
    );
    // Summarizer prompt was rendered with the BLOCKED template.
    expect(summarizerPromptSeen).toBeDefined();
    expect(summarizerPromptSeen).toContain("blocked");
    expect(summarizerPromptSeen).toContain("ENG-1");
    expect(summarizerPromptSeen).toContain("ENG-100");
    // Working transcript is embedded as the {{TRANSCRIPT}} arg.
    expect(summarizerPromptSeen).toContain(
      "blocked: linear API key is missing"
    );
    // No Done transition for the BLOCKED sub-issue.
    expect(events).not.toContain("done:uuid-1");
    expect(events).toEqual([
      "inProgress:uuid-1",
      "run:tide",
      "run:tide-summarizer",
      "flip:uuid-1",
      "comment:uuid-1",
      "inProgress:uuid-2",
      "run:tide",
      "done:uuid-2",
    ]);
  });

  test("BLOCKED registers BLOCKED_SIGNAL with sandcastle alongside DONE_SIGNAL", async () => {
    let capturedSignal: string | string[] | undefined;

    await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      flipLabelToReadyForHuman: () => Promise.resolve(),
      postComment: () => Promise.resolve(),
      sandcastleRun: (opts: RunOptions) => {
        // Capture only the working-agent invocation (not the summarizer).
        if (opts.name === "tide") {
          capturedSignal = opts.completionSignal;
        }
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
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
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
      sandcastleRun: (opts: RunOptions) => {
        events.push(`run:${opts.name ?? "unknown"}`);
        if (opts.name === "tide") {
          return Promise.resolve(
            makeRunResult({
              commits: [],
              completionSignal: DONE_SIGNAL,
            })
          );
        }
        return Promise.resolve(
          makeRunResult({
            commits: [],
            completionSignal: undefined,
          })
        );
      },
      readFinalAssistantMessage: () =>
        Promise.resolve("summarized comment body"),
    });

    // No `done` event — Done transition never fires when the agent didn't
    // commit. But the queue did NOT abort — the issue was flipped instead.
    expect(result.abortedAt).toBeUndefined();
    expect(result.flipped).toBe(1);
    expect(events).toEqual([
      "inProgress",
      "run:tide",
      "run:tide-summarizer",
      "flip",
      "comment",
    ]);
  });

  test("commits without a DONE signal → routed through agent-FAIL flip path (continue, not abort)", async () => {
    const events: string[] = [];

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
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
      sandcastleRun: (opts: RunOptions) => {
        events.push(`run:${opts.name ?? "unknown"}`);
        if (opts.name === "tide") {
          return Promise.resolve(
            makeRunResult({
              commits: [{ sha: "abc" }],
              completionSignal: undefined,
            })
          );
        }
        return Promise.resolve(
          makeRunResult({
            commits: [],
            completionSignal: undefined,
          })
        );
      },
      readFinalAssistantMessage: () =>
        Promise.resolve("summarized comment body"),
    });

    expect(result.abortedAt).toBeUndefined();
    expect(result.flipped).toBe(1);
    expect(events).toEqual([
      "inProgress",
      "run:tide",
      "run:tide-summarizer",
      "flip",
      "comment",
    ]);
  });

  test("summarizer failure falls back to a placeholder comment that cites the error", async () => {
    const postedComments: { issueId: string; body: string }[] = [];
    let runCount = 0;

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      flipLabelToReadyForHuman: () => Promise.resolve(),
      postComment: (_ctx, issueId, body) => {
        postedComments.push({ issueId, body });
        return Promise.resolve();
      },
      sandcastleRun: () => {
        runCount += 1;
        // Working agent BLOCKED.
        if (runCount === 1) {
          return Promise.resolve(
            makeRunResult({
              commits: [],
              completionSignal: BLOCKED_SIGNAL,
              logFilePath: "/tmp/working.log",
            })
          );
        }
        // Summarizer throws (simulating a sandbox infra error).
        return Promise.reject(new Error("summarizer sandbox crashed"));
      },
      readFinalAssistantMessage: () =>
        Promise.resolve("Working agent transcript text"),
    });

    expect(result.abortedAt).toBeUndefined();
    expect(result.flipped).toBe(1);
    expect(postedComments).toHaveLength(1);
    expect(postedComments[0]?.body).toContain("ready-for-human");
    expect(postedComments[0]?.body).toContain("BLOCKED");
    // Fallback explicitly cites the summarizer error.
    expect(postedComments[0]?.body).toContain("summarizer sandbox crashed");
  });

  test("summarizer producing an empty message falls back to placeholder", async () => {
    const postedComments: { issueId: string; body: string }[] = [];
    let runCount = 0;

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      flipLabelToReadyForHuman: () => Promise.resolve(),
      postComment: (_ctx, issueId, body) => {
        postedComments.push({ issueId, body });
        return Promise.resolve();
      },
      sandcastleRun: () => {
        runCount += 1;
        if (runCount === 1) {
          return Promise.resolve(
            makeRunResult({
              commits: [],
              completionSignal: BLOCKED_SIGNAL,
              logFilePath: "/tmp/working.log",
            })
          );
        }
        return Promise.resolve(
          makeRunResult({
            commits: [],
            completionSignal: undefined,
            logFilePath: "/tmp/summarizer.log",
          })
        );
      },
      readFinalAssistantMessage: (logFilePath: string) => {
        if (logFilePath === "/tmp/summarizer.log") return Promise.resolve("");
        return Promise.resolve("working transcript");
      },
    });

    expect(result.flipped).toBe(1);
    expect(postedComments[0]?.body).toContain("ready-for-human");
    expect(postedComments[0]?.body).toMatch(/empty final message/);
  });

  test("label-flip failure surfaces as an infra abort (no comment, no further sub-issues)", async () => {
    const events: string[] = [];

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
      ],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () =>
        Promise.resolve(
          asSubIssues([
            makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
            makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
          ])
        ),
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
      sandcastleRun: (opts: RunOptions) => {
        events.push(`run:${opts.name ?? "unknown"}`);
        if (opts.name === "tide") {
          return Promise.resolve(
            makeRunResult({
              commits: [],
              completionSignal: BLOCKED_SIGNAL,
              logFilePath: "/tmp/working.log",
            })
          );
        }
        return Promise.resolve(
          makeRunResult({
            commits: [],
            completionSignal: undefined,
            logFilePath: "/tmp/summarizer.log",
          })
        );
      },
      readFinalAssistantMessage: () =>
        Promise.resolve("Summarizer comment body"),
    });

    expect(result.completed).toBe(0);
    expect(result.flipped).toBe(0);
    expect(result.abortedAt?.identifier).toBe("ENG-1");
    expect(result.abortedAt?.reason).toContain("label flip failed");
    expect(result.abortedAt?.reason).toContain("rate-limited");
    // Comment never fires when the flip failed. Summarizer ran before the
    // flip, but we don't post when the flip didn't land.
    expect(events).toEqual(["run:tide", "run:tide-summarizer", "flip"]);
  });

  test("infra FAIL (sandcastle threw) aborts without flipping any state", async () => {
    const events: string[] = [];

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
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
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
      ],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () =>
        Promise.resolve(
          asSubIssues([
            makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
            makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
          ])
        ),
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
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered({ id: "uuid-eng-1" })],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
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
  test("registers both DONE and BLOCKED signals with sandcastle and surfaces sub-issue identity in promptArgs", async () => {
    let capturedOpts: RunOptions | undefined;

    await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered({ id: "uuid-eng-7", identifier: "ENG-7" })],
      branch: "user/feature/eng-7",
      baseBranch: "main",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
      fetchIssueContent: () =>
        Promise.resolve(makeIssueContent({ identifier: "ENG-7" })),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      flipLabelToReadyForHuman: () => Promise.resolve(),
      postComment: () => Promise.resolve(),
      sandcastleRun: (opts: RunOptions) => {
        // Only capture the working-agent invocation (skip the summarizer).
        if (opts.name === "tide") capturedOpts = opts;
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
    expect(args.ISSUE_ID).toBe("ENG-7");
    // FEATURE_BRANCH / BASE_BRANCH are tide-owned and supersede sandcastle's
    // built-in SOURCE_BRANCH / TARGET_BRANCH (ADR-0014); the runner threads
    // the caller-supplied `branch` and `baseBranch` through.
    expect(args.FEATURE_BRANCH).toBe("user/feature/eng-7");
    expect(args.BASE_BRANCH).toBe("main");
    expect(args.SOURCE_BRANCH).toBeUndefined();
    expect(args.TARGET_BRANCH).toBeUndefined();
  });

  test("working-agent iteration uses merge-to-head and runs with cwd=featureWorktreePath (ADR-0014)", async () => {
    let capturedOpts: RunOptions | undefined;

    await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature-eng-1",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      sandcastleRun: (opts: RunOptions) => {
        if (opts.name === "tide") capturedOpts = opts;
        return Promise.resolve(makeRunResult());
      },
    });

    expect(capturedOpts).toBeDefined();
    if (!capturedOpts) throw new Error("unreachable");
    // Iteration worktree is created beneath the Feature worktree.
    expect(capturedOpts.cwd).toBe("/repo/.tide/worktrees/feature-eng-1");
    // Sandcastle owns the merge step; tide doesn't reimplement merge edge
    // cases under the new runtime.
    expect(capturedOpts.branchStrategy).toEqual({ type: "merge-to-head" });
  });

  test("summarizer iteration also runs in cwd=featureWorktreePath", async () => {
    const captured: RunOptions[] = [];
    let runCount = 0;

    await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature-eng-1",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      flipLabelToReadyForHuman: () => Promise.resolve(),
      postComment: () => Promise.resolve(),
      sandcastleRun: (opts: RunOptions) => {
        captured.push(opts);
        runCount += 1;
        // First call: working agent BLOCKED → triggers summarizer call.
        if (runCount === 1) {
          return Promise.resolve(
            makeRunResult({
              commits: [],
              completionSignal: BLOCKED_SIGNAL,
              logFilePath: "/tmp/working.log",
            })
          );
        }
        return Promise.resolve(
          makeRunResult({
            commits: [],
            completionSignal: undefined,
            logFilePath: "/tmp/summary.log",
          })
        );
      },
      readFinalAssistantMessage: () => Promise.resolve("summary text"),
    });

    expect(captured.map((c) => c.name)).toEqual(["tide", "tide-summarizer"]);
    for (const c of captured) {
      expect(c.cwd).toBe("/repo/.tide/worktrees/feature-eng-1");
    }
  });

  test("working-agent run uses file-based logging so the summarizer can read the transcript", async () => {
    let capturedOpts: RunOptions | undefined;

    await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      sandcastleRun: (opts: RunOptions) => {
        if (opts.name === "tide") capturedOpts = opts;
        return Promise.resolve(makeRunResult());
      },
    });

    expect(capturedOpts?.logging).toBeDefined();
    expect(capturedOpts?.logging?.type).toBe("file");
    if (capturedOpts?.logging?.type === "file") {
      expect(capturedOpts.logging.path).toContain(".tide");
      expect(capturedOpts.logging.path).toContain("logs");
    }
  });

  test("legacy <promise>COMPLETE</promise> is no longer accepted as a success signal — flips through agent-FAIL", async () => {
    let doneCalls = 0;
    let flipCalls = 0;
    let runCount = 0;

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
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
      sandcastleRun: () => {
        runCount += 1;
        if (runCount === 1) {
          return Promise.resolve(
            makeRunResult({
              commits: [{ sha: "abc" }],
              completionSignal: "<promise>COMPLETE</promise>",
            })
          );
        }
        return Promise.resolve(
          makeRunResult({
            commits: [],
            completionSignal: undefined,
          })
        );
      },
      readFinalAssistantMessage: () => Promise.resolve("summary text"),
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

describe("runIssueQueue — host-side `git push` after every iteration", () => {
  test("after a working-agent iteration with ≥1 commit, fires `git push -u origin <branch>` on the host", async () => {
    const { runner, calls } = recordingShellRunner();

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      sandcastleRun: () => Promise.resolve(makeRunResult()),
      shellRunner: runner,
    });

    expect(result.completed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("git");
    expect(calls[0]?.args).toEqual(["push", "-u", "origin", "feature/eng-1"]);
    expect(calls[0]?.cwd).toBe("/repo");
  });

  test("an iteration whose result has zero commits does not fire a push", async () => {
    const { runner, calls } = recordingShellRunner();

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      flipLabelToReadyForHuman: () => Promise.resolve(),
      postComment: () => Promise.resolve(),
      sandcastleRun: (opts: RunOptions) => {
        // Working-agent iteration: zero commits, no signal → agent-FAIL.
        // Summarizer iteration: also zero commits.
        if (opts.name === "tide") {
          return Promise.resolve(
            makeRunResult({
              commits: [],
              completionSignal: undefined,
              logFilePath: "/tmp/working.log",
            })
          );
        }
        return Promise.resolve(
          makeRunResult({
            commits: [],
            completionSignal: undefined,
            logFilePath: "/tmp/summarizer.log",
          })
        );
      },
      readFinalAssistantMessage: () => Promise.resolve("summary"),
      shellRunner: runner,
    });

    expect(result.flipped).toBe(1);
    // No `git push` call fired — the working-agent iteration's commit list
    // was empty.
    expect(calls.filter((c) => c.cmd === "git")).toHaveLength(0);
  });

  test("when sandbox.run throws, the catch path attempts `git push` before returning the infra-abort", async () => {
    const { runner, calls } = recordingShellRunner();

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      branch: "feature/eng-1",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      sandcastleRun: () =>
        Promise.reject(new Error("sandcastle ran out of disk")),
      shellRunner: runner,
    });

    // Queue aborts as infra-fail …
    expect(result.completed).toBe(0);
    expect(result.abortedAt?.reason).toContain("ran out of disk");
    // … but not before the push attempt. The agent may have committed
    // before the throw; pushing salvages that work even when the
    // SandboxRunResult is unavailable.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("git");
    expect(calls[0]?.args).toEqual(["push", "-u", "origin", "feature/eng-1"]);
  });

  test("when `git push` exits non-zero, the runner warns and continues — no abort, no Linear mutation, no flip", async () => {
    const events: string[] = [];
    const { runner, calls } = recordingShellRunner({
      exitCode: 1,
      stdout: "",
      stderr: "remote: temporary network blip",
    });

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
      ],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () =>
        Promise.resolve(
          asSubIssues([
            makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
            makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
          ])
        ),
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
      postComment: (_ctx, issueId) => {
        events.push(`comment:${issueId}`);
        return Promise.resolve();
      },
      sandcastleRun: () => Promise.resolve(makeRunResult()),
      shellRunner: runner,
    });

    // Both sub-issues completed despite the per-iteration push failures.
    // No abort, no flips, every Done transition fired.
    expect(result.completed).toBe(2);
    expect(result.flipped).toBe(0);
    expect(result.abortedAt).toBeUndefined();
    // Each iteration tried to push.
    expect(calls.filter((c) => c.cmd === "git")).toHaveLength(2);
    expect(events).toEqual([
      "inProgress:uuid-1",
      "done:uuid-1",
      "inProgress:uuid-2",
      "done:uuid-2",
    ]);
  });
});

describe("runIssueQueue — Standalone Issue root: skip Done transition", () => {
  test("standalone DONE + commits → does NOT call transitionToDone; counts as completed", async () => {
    const events: string[] = [];

    const result = await runIssueQueue({
      root: { kind: "standalone" },
      orderedIssues: [makeOrdered({ id: "uuid-iss-7", identifier: "ENG-7" })],
      branch: "feature/eng-7",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchIssueContent: () => {
        events.push("fetchContent");
        return Promise.resolve(makeIssueContent({ identifier: "ENG-7" }));
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

    // Iteration counted as completed (clean DONE + commits) but no host-side
    // Done transition fired — the post-submission hook handles In Review.
    expect(result.completed).toBe(1);
    expect(result.flipped).toBe(0);
    expect(result.abortedAt).toBeUndefined();
    expect(events).toEqual([
      "fetchContent", // issue body (no parent fetch for standalone)
      "inProgress:uuid-iss-7",
      "run",
    ]);
    expect(events).not.toContain("done:uuid-iss-7");
  });

  test("standalone BLOCKED iteration: existing flip + comment path is preserved (no Done transition either)", async () => {
    const events: string[] = [];
    let runCount = 0;

    const result = await runIssueQueue({
      root: { kind: "standalone" },
      orderedIssues: [makeOrdered({ id: "uuid-iss-7", identifier: "ENG-7" })],
      branch: "feature/eng-7",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
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
      postComment: (_ctx, issueId) => {
        events.push(`comment:${issueId}`);
        return Promise.resolve();
      },
      sandcastleRun: () => {
        runCount += 1;
        if (runCount === 1) {
          return Promise.resolve(
            makeRunResult({
              commits: [],
              completionSignal: BLOCKED_SIGNAL,
              logFilePath: "/tmp/standalone-working.log",
            })
          );
        }
        return Promise.resolve(
          makeRunResult({
            commits: [],
            completionSignal: undefined,
            logFilePath: "/tmp/standalone-summarizer.log",
          })
        );
      },
      readFinalAssistantMessage: () => Promise.resolve("summary"),
    });

    expect(result.completed).toBe(0);
    expect(result.flipped).toBe(1);
    expect(result.abortedAt).toBeUndefined();
    expect(events).toContain("flip:uuid-iss-7");
    expect(events).toContain("comment:uuid-iss-7");
    // The BLOCKED path never calls Done, even for sub-issues. This pins that
    // the standalone gate doesn't accidentally widen to flip-Done.
    expect(events).not.toContain("done:uuid-iss-7");
  });

  test("PRD root: sub-issue DONE + commits → still calls transitionToDone (regression guard)", async () => {
    const doneCalls: string[] = [];

    await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered({ id: "uuid-sub-1", identifier: "ENG-1" })],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => Promise.resolve([]),
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: (_ctx, issueId) => {
        doneCalls.push(issueId);
        return Promise.resolve();
      },
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    // Sub-issues continue to transition to Done host-side (real-time
    // per-iteration progress, ADR-0005).
    expect(doneCalls).toEqual(["uuid-sub-1"]);
  });
});

describe("runIssueQueue — mid-run queue rebuild (ADR-0010)", () => {
  test("PRD root: result.processed lists every sub-issue the runner ran an iteration on, in run order", async () => {
    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2", title: "Second" }),
      ],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () =>
        Promise.resolve(
          asSubIssues([
            makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
            makeOrdered({
              id: "uuid-2",
              identifier: "ENG-2",
              title: "Second",
            }),
          ])
        ),
      fetchIssueContent: (_ctx, issueId) =>
        Promise.resolve(makeIssueContent({ identifier: issueId })),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    expect(result.processed.map((o) => o.identifier)).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
  });

  test("PRD root: human adds a fresh ready-for-agent sub-issue mid-run; it is absorbed and runs after the snapshot drains", async () => {
    const events: string[] = [];
    let fetchCount = 0;

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
      ],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => {
        fetchCount += 1;
        // After iteration 1, the human added ENG-2 in Linear's UI.
        if (fetchCount === 1) {
          return Promise.resolve(
            asSubIssues([
              makeOrdered({
                id: "uuid-1",
                identifier: "ENG-1",
                title: "First",
              }),
              makeOrdered({
                id: "uuid-2",
                identifier: "ENG-2",
                title: "Late arrival",
              }),
            ])
          );
        }
        return Promise.resolve([]);
      },
      fetchIssueContent: (_ctx, issueId) => {
        events.push(`fetch:${issueId}`);
        return Promise.resolve(makeIssueContent({ identifier: issueId }));
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

    expect(result.completed).toBe(2);
    expect(result.flipped).toBe(0);
    expect(result.abortedAt).toBeUndefined();
    expect(result.processed.map((o) => o.identifier)).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
    // Iteration 1 ran ENG-1 → boundary fetch absorbed ENG-2 → iteration 2 ran ENG-2.
    expect(events).toContain("inProgress:uuid-1");
    expect(events).toContain("done:uuid-1");
    expect(events).toContain("inProgress:uuid-2");
    expect(events).toContain("done:uuid-2");
  });

  test("PRD root: late arrival X with blockedBy → still-queued Y runs Y first regardless of arrival order", async () => {
    const events: string[] = [];
    let fetchCount = 0;

    // Initial queue has only ENG-1 (Y) — the human will add ENG-2 (X)
    // mid-run with blockedBy: ["ENG-1"]. The rebuild should re-topo-sort,
    // but ENG-1 is in `handled` after iteration 1, so only ENG-2 remains
    // and runs next.
    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "Y first" }),
      ],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          // Boundary 1: ENG-2 (X) shows up with blockedBy ENG-1 (Y).
          return Promise.resolve([
            ...asSubIssues([
              makeOrdered({
                id: "uuid-1",
                identifier: "ENG-1",
                title: "Y first",
              }),
            ]),
            {
              id: "uuid-2",
              identifier: "ENG-2",
              title: "X depends on Y",
              state: "Backlog",
              stateType: "backlog",
              labels: ["ready-for-agent"],
              blockedBy: ["ENG-1"],
            },
          ]);
        }
        return Promise.resolve([]);
      },
      fetchIssueContent: (_ctx, issueId) => {
        events.push(`fetch:${issueId}`);
        return Promise.resolve(makeIssueContent({ identifier: issueId }));
      },
      transitionToInProgress: (_ctx, issueId) => {
        events.push(`inProgress:${issueId}`);
        return Promise.resolve();
      },
      transitionToDone: (_ctx, issueId) => {
        events.push(`done:${issueId}`);
        return Promise.resolve();
      },
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    // Y ran first (it was the snapshot's only entry), then X was absorbed
    // and ran after — topo-correct because ENG-1 was already handled when
    // the rebuild fired, so the buildOrderedQueue's external-blocker check
    // never triggers (a handled identifier is filtered out before the
    // dep-graph sees it).
    expect(result.processed.map((o) => o.identifier)).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
    expect(events).toEqual([
      "fetch:uuid-prd", // parent PRD body fetch
      "fetch:uuid-1",
      "inProgress:uuid-1",
      "done:uuid-1",
      "fetch:uuid-2",
      "inProgress:uuid-2",
      "done:uuid-2",
    ]);
  });

  test("PRD root: late arrival X with blockedBy → already-flipped sibling errors as external-blocker; X is skipped, the rest of the queue continues", async () => {
    let fetchCount = 0;
    let runCount = 0;

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2", title: "Second" }),
      ],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          // After iteration 1: ENG-1 was just flipped (BLOCKED). The
          // human added ENG-3 with blockedBy ENG-1 — but tide flipped
          // ENG-1 to ready-for-human, so the rebuild must reject ENG-3.
          // ENG-2 is still ready-for-agent and should still run.
          return Promise.resolve([
            // ENG-1 lost its `ready-for-agent` (now `ready-for-human`).
            {
              id: "uuid-1",
              identifier: "ENG-1",
              title: "First",
              state: "In Progress",
              stateType: "started",
              labels: ["ready-for-human"],
              blockedBy: [],
            },
            ...asSubIssues([
              makeOrdered({
                id: "uuid-2",
                identifier: "ENG-2",
                title: "Second",
              }),
            ]),
            {
              id: "uuid-3",
              identifier: "ENG-3",
              title: "Late arrival blocked by flipped",
              state: "Backlog",
              stateType: "backlog",
              labels: ["ready-for-agent"],
              blockedBy: ["ENG-1"],
            },
          ]);
        }
        return Promise.resolve([]);
      },
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      flipLabelToReadyForHuman: () => Promise.resolve(),
      postComment: () => Promise.resolve(),
      sandcastleRun: (opts: RunOptions) => {
        if (opts.name === "tide-summarizer") {
          return Promise.resolve(
            makeRunResult({
              commits: [],
              completionSignal: undefined,
              logFilePath: "/tmp/summary.log",
            })
          );
        }
        runCount += 1;
        // Iteration 1 (working ENG-1): BLOCKED to set up the flipped
        // sibling for the rebuild's external-blocker error. Iteration 2
        // (working ENG-2): clean success.
        if (runCount === 1) {
          return Promise.resolve(
            makeRunResult({
              commits: [],
              completionSignal: BLOCKED_SIGNAL,
              logFilePath: "/tmp/eng-1.log",
            })
          );
        }
        return Promise.resolve(makeRunResult());
      },
      readFinalAssistantMessage: () =>
        Promise.resolve("summarized comment body"),
    });

    expect(result.abortedAt).toBeUndefined();
    expect(result.flipped).toBe(1);
    expect(result.completed).toBe(1);
    // ENG-3 was skipped (warn-and-skip). ENG-2 ran cleanly after the rebuild.
    expect(result.processed.map((o) => o.identifier)).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
  });

  test("PRD root: rebuild error survives the retry → tide aborts via the existing infra-failure path", async () => {
    let fetchCount = 0;

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2", title: "Second" }),
      ],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => {
        fetchCount += 1;
        // After iteration 1: ENG-2 has acquired a blockedBy that points to
        // an external (out-of-PRD) identifier. Dropping ENG-2 from
        // candidates leaves the queue empty, but the parser surfaces the
        // identifier and the second pass succeeds — so we engineer a
        // case that fails BOTH passes: ENG-2 is blocked by ENG-99
        // (external), AND we add a second still-bad node ENG-3 also
        // blocked by ENG-99. Dropping just one isn't enough.
        if (fetchCount === 1) {
          return Promise.resolve([
            {
              id: "uuid-2",
              identifier: "ENG-2",
              title: "Second",
              state: "Backlog",
              stateType: "backlog",
              labels: ["ready-for-agent"],
              blockedBy: ["ENG-99"],
            },
            {
              id: "uuid-3",
              identifier: "ENG-3",
              title: "Third",
              state: "Backlog",
              stateType: "backlog",
              labels: ["ready-for-agent"],
              blockedBy: ["ENG-99"],
            },
          ]);
        }
        return Promise.resolve([]);
      },
      fetchIssueContent: (_ctx, issueId) =>
        Promise.resolve(makeIssueContent({ identifier: issueId })),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    expect(result.abortedAt).toBeDefined();
    expect(result.abortedAt?.identifier).toMatch(/^ENG-/);
    expect(result.abortedAt?.reason).toContain("queue rebuild failed");
    // ENG-1 ran cleanly before the abort.
    expect(result.completed).toBe(1);
    expect(result.processed.map((o) => o.identifier)).toEqual(["ENG-1"]);
  });

  test("PRD root: fetchSubIssues throws mid-run → warn-and-continue with the previous boundary's queue", async () => {
    let fetchCount = 0;
    const events: string[] = [];

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2", title: "Second" }),
      ],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return Promise.reject(new Error("Linear API hiccup"));
        }
        return Promise.resolve([]);
      },
      fetchIssueContent: (_ctx, issueId) => {
        events.push(`fetch:${issueId}`);
        return Promise.resolve(makeIssueContent({ identifier: issueId }));
      },
      transitionToInProgress: (_ctx, issueId) => {
        events.push(`inProgress:${issueId}`);
        return Promise.resolve();
      },
      transitionToDone: (_ctx, issueId) => {
        events.push(`done:${issueId}`);
        return Promise.resolve();
      },
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    // ENG-2 still ran because the rebuild fell back to the previous queue.
    expect(result.abortedAt).toBeUndefined();
    expect(result.completed).toBe(2);
    expect(result.processed.map((o) => o.identifier)).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
  });

  test("PRD root: queued-but-not-yet-run sub-issue loses ready-for-agent mid-run → silently dropped on next rebuild", async () => {
    let fetchCount = 0;

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2", title: "Second" }),
      ],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          // Human removed `ready-for-agent` from ENG-2 mid-run.
          return Promise.resolve([
            ...asSubIssues([
              makeOrdered({
                id: "uuid-1",
                identifier: "ENG-1",
                title: "First",
              }),
            ]),
            {
              id: "uuid-2",
              identifier: "ENG-2",
              title: "Second",
              state: "Backlog",
              stateType: "backlog",
              labels: [],
              blockedBy: [],
            },
          ]);
        }
        return Promise.resolve([]);
      },
      fetchIssueContent: (_ctx, issueId) =>
        Promise.resolve(makeIssueContent({ identifier: issueId })),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    expect(result.abortedAt).toBeUndefined();
    expect(result.completed).toBe(1);
    expect(result.processed.map((o) => o.identifier)).toEqual(["ENG-1"]);
  });

  test("Standalone Issue root: never calls fetchSubIssues — the rebuild path is skipped entirely", async () => {
    let fetchCalls = 0;

    const result = await runIssueQueue({
      root: { kind: "standalone" },
      orderedIssues: [makeOrdered({ id: "uuid-iss-7", identifier: "ENG-7" })],
      branch: "feature/eng-7",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => {
        fetchCalls += 1;
        return Promise.resolve([]);
      },
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    expect(fetchCalls).toBe(0);
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]?.identifier).toBe("ENG-7");
  });

  test("PRD root: an absorbed sub-issue that BLOCKEDs appears in `processed` and counts toward `flipped`", async () => {
    let runCount = 0;
    let fetchCount = 0;

    const result = await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
      ],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "tide",
      fetchSubIssues: () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return Promise.resolve(
            asSubIssues([
              makeOrdered({
                id: "uuid-1",
                identifier: "ENG-1",
                title: "First",
              }),
              makeOrdered({
                id: "uuid-2",
                identifier: "ENG-2",
                title: "Late",
              }),
            ])
          );
        }
        return Promise.resolve([]);
      },
      fetchIssueContent: (_ctx, issueId) =>
        Promise.resolve(makeIssueContent({ identifier: issueId })),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      flipLabelToReadyForHuman: () => Promise.resolve(),
      postComment: () => Promise.resolve(),
      sandcastleRun: (opts: RunOptions) => {
        runCount += 1;
        // Iteration 1 (working): ENG-1 succeeds. Iteration 2 (working):
        // ENG-2 BLOCKEDs. Iteration 3 (summarizer for ENG-2).
        if (opts.name === "tide-summarizer") {
          return Promise.resolve(
            makeRunResult({
              commits: [],
              completionSignal: undefined,
              logFilePath: "/tmp/eng-2-summary.log",
            })
          );
        }
        if (runCount === 1) {
          return Promise.resolve(makeRunResult());
        }
        return Promise.resolve(
          makeRunResult({
            commits: [],
            completionSignal: BLOCKED_SIGNAL,
            logFilePath: "/tmp/eng-2-working.log",
          })
        );
      },
      readFinalAssistantMessage: () => Promise.resolve("summary"),
    });

    expect(result.completed).toBe(1);
    expect(result.flipped).toBe(1);
    expect(result.processed.map((o) => o.identifier)).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
  });

  test("PRD root: every iteration-boundary fetchSubIssues call receives the runner's repoName (ADR-0012)", async () => {
    // The mid-run queue rebuild must apply the same `[<repoName>] `
    // title-prefix scope filter as the initial queue build — wrong-repo
    // and unprefixed Sub-issues are invisible to both, and a mistitled
    // sub-issue is never absorbed by the rebuild.
    const fetchCalls: { prdId: string; repoName: string }[] = [];

    await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
      ],
      branch: "feature/eng",
      baseBranch: "master",
      linearCtx,
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature",
      config: baseConfig,
      sandboxEnv: {},
      repoName: "widget",
      fetchSubIssues: (_ctx, prdId, repoName) => {
        fetchCalls.push({ prdId, repoName });
        return Promise.resolve(
          asSubIssues([
            makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
            makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
          ])
        );
      },
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    // Two iterations → two boundaries → two rebuild fetches. Each must
    // carry the runner's `repoName` argument verbatim.
    expect(fetchCalls).toHaveLength(2);
    for (const c of fetchCalls) {
      expect(c.prdId).toBe("uuid-prd");
      expect(c.repoName).toBe("widget");
    }
  });
});
