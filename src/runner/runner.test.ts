// Orchestration tests for `runIssueQueue`. Production wiring goes through
// the `LinearService` interface; tests inject `InMemoryLinearService` as
// a domain-shaped fake. Cross-method ordering assertions interleave the
// fake's `onMethodCall` hook with the `sandcastleRun` stub's event
// callbacks into a single `events` array.

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
import type { LinearIssueContent, SubIssue } from "../linear/index.ts";
import { InMemoryLinearService } from "../services/linear/index.ts";

/**
 * Map a runner's `OrderedIssue[]` into the `SubIssue[]` shape that
 * `fetchSubIssues` returns, with `ready-for-agent` labels and no blockers.
 * Used by tests to seed the per-boundary queue rebuild (ADR-0010) so
 * iteration ≥2 has the same candidate set as the pre-flight queue.
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

const baseRunOptions = {
  branch: "feature/eng-1",
  baseBranch: "master",
  repoRoot: "/repo",
  featureWorktreePath: "/repo/.tide/worktrees/feature",
  config: baseConfig,
  sandboxEnv: {},
};

describe("runIssueQueue — DONE signal + Linear transitions", () => {
  test("DONE + commits → transitions sub-issue to Done after the run", async () => {
    const events: string[] = [];
    const linear = new InMemoryLinearService();
    linear.onMethodCall = (method, args) => {
      if (method === "fetchIssueContent") events.push("fetchContent");
      else if (method === "transitionToInProgress")
        events.push(`inProgress:${String(args[0])}`);
      else if (method === "transitionToDone")
        events.push(`done:${String(args[0])}`);
    };

    const result = await runIssueQueue({
      ...baseRunOptions,
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      linear,
      sandcastleRun: () => {
        events.push("run");
        return Promise.resolve(makeRunResult());
      },
    });

    expect(result.completed).toBe(1);
    expect(result.abortedAt).toBeUndefined();
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
    const linear = new InMemoryLinearService({
      subIssuesByParent: {
        "uuid-prd": asSubIssues([
          makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
          makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
        ]),
      },
    });
    linear.onMethodCall = (method, args) => {
      if (method === "transitionToInProgress")
        events.push(`inProgress:${String(args[0])}`);
      else if (method === "transitionToDone")
        events.push(`done:${String(args[0])}`);
      else if (method === "flipLabelToReadyForHuman")
        events.push(`flip:${String(args[0])}`);
      else if (method === "postComment")
        events.push(`comment:${String(args[0])}`);
    };

    const sandboxRunNames: string[] = [];
    let runCount = 0;

    const result = await runIssueQueue({
      ...baseRunOptions,
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
      ],
      linear,
      sandcastleRun: (opts: RunOptions) => {
        events.push(`run:${opts.name ?? "unknown"}`);
        sandboxRunNames.push(opts.name ?? "unknown");
        runCount += 1;
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
    expect(linear.commentsOn("uuid-1")).toEqual([
      "Tide flipped this to ready-for-human. The agent ran out of iterations without committing.",
    ]);
    expect(linear.labelsOf("uuid-1")).toEqual(["ready-for-human"]);
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
    const linear = new InMemoryLinearService({
      subIssuesByParent: {
        "uuid-prd": asSubIssues([
          makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
          makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
        ]),
      },
    });
    linear.onMethodCall = (method, args) => {
      if (method === "transitionToInProgress")
        events.push(`inProgress:${String(args[0])}`);
      else if (method === "transitionToDone")
        events.push(`done:${String(args[0])}`);
      else if (method === "flipLabelToReadyForHuman")
        events.push(`flip:${String(args[0])}`);
      else if (method === "postComment")
        events.push(`comment:${String(args[0])}`);
    };

    let summarizerPromptSeen: string | undefined;
    let runCount = 0;

    const result = await runIssueQueue({
      ...baseRunOptions,
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
      ],
      linear,
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
    expect(linear.commentsOn("uuid-1")).toEqual([
      "Linear comment summarizing the BLOCKED reason.",
    ]);
    expect(summarizerPromptSeen).toBeDefined();
    expect(summarizerPromptSeen).toContain("blocked");
    expect(summarizerPromptSeen).toContain("ENG-1");
    expect(summarizerPromptSeen).toContain("ENG-100");
    expect(summarizerPromptSeen).toContain(
      "blocked: linear API key is missing"
    );
    expect(linear.transitionsOf("uuid-1")).toEqual(["In Progress"]);
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
    const linear = new InMemoryLinearService();

    await runIssueQueue({
      ...baseRunOptions,
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      linear,
      sandcastleRun: (opts: RunOptions) => {
        if (opts.name === "tide") {
          capturedSignal = opts.completionSignal;
        }
        return Promise.resolve(makeRunResult());
      },
    });

    expect(Array.isArray(capturedSignal)).toBe(true);
    if (Array.isArray(capturedSignal)) {
      expect(capturedSignal).toContain(DONE_SIGNAL);
      expect(capturedSignal).toContain(BLOCKED_SIGNAL);
    }
  });

  test("DONE signalled but no commits → routed through agent-FAIL flip path (continue, not abort)", async () => {
    const linear = new InMemoryLinearService();

    const result = await runIssueQueue({
      ...baseRunOptions,
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      linear,
      sandcastleRun: (opts: RunOptions) => {
        if (opts.name === "tide") {
          return Promise.resolve(
            makeRunResult({ commits: [], completionSignal: DONE_SIGNAL })
          );
        }
        return Promise.resolve(
          makeRunResult({ commits: [], completionSignal: undefined })
        );
      },
      readFinalAssistantMessage: () =>
        Promise.resolve("summarized comment body"),
    });

    expect(result.abortedAt).toBeUndefined();
    expect(result.flipped).toBe(1);
    expect(linear.transitionsOf("uuid-eng-1")).toEqual(["In Progress"]);
    expect(linear.labelsOf("uuid-eng-1")).toEqual(["ready-for-human"]);
  });

  test("commits without a DONE signal → routed through agent-FAIL flip path (continue, not abort)", async () => {
    const linear = new InMemoryLinearService();

    const result = await runIssueQueue({
      ...baseRunOptions,
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      linear,
      sandcastleRun: (opts: RunOptions) => {
        if (opts.name === "tide") {
          return Promise.resolve(
            makeRunResult({
              commits: [{ sha: "abc" }],
              completionSignal: undefined,
            })
          );
        }
        return Promise.resolve(
          makeRunResult({ commits: [], completionSignal: undefined })
        );
      },
      readFinalAssistantMessage: () =>
        Promise.resolve("summarized comment body"),
    });

    expect(result.abortedAt).toBeUndefined();
    expect(result.flipped).toBe(1);
    expect(linear.labelsOf("uuid-eng-1")).toEqual(["ready-for-human"]);
  });

  test("summarizer failure falls back to a placeholder comment that cites the error", async () => {
    const linear = new InMemoryLinearService();
    let runCount = 0;

    const result = await runIssueQueue({
      ...baseRunOptions,
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      linear,
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
        return Promise.reject(new Error("summarizer sandbox crashed"));
      },
      readFinalAssistantMessage: () =>
        Promise.resolve("Working agent transcript text"),
    });

    expect(result.abortedAt).toBeUndefined();
    expect(result.flipped).toBe(1);
    const comments = linear.commentsOn("uuid-eng-1");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("ready-for-human");
    expect(comments[0]).toContain("BLOCKED");
    expect(comments[0]).toContain("summarizer sandbox crashed");
  });

  test("summarizer producing an empty message falls back to placeholder", async () => {
    const linear = new InMemoryLinearService();
    let runCount = 0;

    const result = await runIssueQueue({
      ...baseRunOptions,
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      linear,
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
    const comments = linear.commentsOn("uuid-eng-1");
    expect(comments[0]).toContain("ready-for-human");
    expect(comments[0]).toMatch(/empty final message/);
  });

  test("label-flip failure surfaces as an infra abort (no comment, no further sub-issues)", async () => {
    const linear = new InMemoryLinearService({
      subIssuesByParent: {
        "uuid-prd": asSubIssues([
          makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
          makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
        ]),
      },
    });
    linear.failNext(
      "flipLabelToReadyForHuman",
      new Error("Linear write rate-limited")
    );

    const result = await runIssueQueue({
      ...baseRunOptions,
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
      ],
      linear,
      sandcastleRun: (opts: RunOptions) => {
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
    // Comment never fires when the flip failed.
    expect(linear.commentsOn("uuid-1")).toEqual([]);
  });

  test("infra FAIL (sandcastle threw) aborts without flipping any state", async () => {
    const linear = new InMemoryLinearService();

    const result = await runIssueQueue({
      ...baseRunOptions,
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      linear,
      sandcastleRun: () => Promise.reject(new Error("docker daemon down")),
    });

    expect(result.completed).toBe(0);
    expect(result.abortedAt?.reason).toContain("docker daemon down");
    // In Progress fired, but the run threw — no Done transition.
    expect(linear.transitionsOf("uuid-eng-1")).toEqual(["In Progress"]);
  });

  test("multi-issue queue: each sub-issue transitions In Progress → run → Done in order", async () => {
    const events: string[] = [];
    const linear = new InMemoryLinearService({
      subIssuesByParent: {
        "uuid-prd": asSubIssues([
          makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
          makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
        ]),
      },
    });
    linear.onMethodCall = (method, args) => {
      if (method === "transitionToInProgress")
        events.push(`inProgress:${String(args[0])}`);
      else if (method === "transitionToDone")
        events.push(`done:${String(args[0])}`);
    };

    const result = await runIssueQueue({
      ...baseRunOptions,
      branch: "feature/eng",
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
      ],
      linear,
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
});

describe("runIssueQueue — prompt args + sandcastle wiring", () => {
  test("registers both DONE and BLOCKED signals with sandcastle and surfaces sub-issue identity in promptArgs", async () => {
    let capturedOpts: RunOptions | undefined;
    const linear = new InMemoryLinearService({
      issueContent: {
        "uuid-eng-7": makeIssueContent({ identifier: "ENG-7" }),
        "uuid-prd": makeIssueContent({ identifier: "ENG-100" }),
      },
    });

    await runIssueQueue({
      ...baseRunOptions,
      branch: "user/feature/eng-7",
      baseBranch: "main",
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered({ id: "uuid-eng-7", identifier: "ENG-7" })],
      linear,
      sandcastleRun: (opts: RunOptions) => {
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
    expect(args.FEATURE_BRANCH).toBe("user/feature/eng-7");
    expect(args.BASE_BRANCH).toBe("main");
    expect(args.SOURCE_BRANCH).toBeUndefined();
    expect(args.TARGET_BRANCH).toBeUndefined();
  });

  test("working-agent iteration uses merge-to-head and runs with cwd=featureWorktreePath (ADR-0014)", async () => {
    let capturedOpts: RunOptions | undefined;
    const linear = new InMemoryLinearService();

    await runIssueQueue({
      ...baseRunOptions,
      featureWorktreePath: "/repo/.tide/worktrees/feature-eng-1",
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      linear,
      sandcastleRun: (opts: RunOptions) => {
        if (opts.name === "tide") capturedOpts = opts;
        return Promise.resolve(makeRunResult());
      },
    });

    expect(capturedOpts).toBeDefined();
    if (!capturedOpts) throw new Error("unreachable");
    expect(capturedOpts.cwd).toBe("/repo/.tide/worktrees/feature-eng-1");
    expect(capturedOpts.branchStrategy).toEqual({ type: "merge-to-head" });
  });

  test("summarizer iteration also runs in cwd=featureWorktreePath", async () => {
    const captured: RunOptions[] = [];
    const linear = new InMemoryLinearService();
    let runCount = 0;

    await runIssueQueue({
      ...baseRunOptions,
      featureWorktreePath: "/repo/.tide/worktrees/feature-eng-1",
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      linear,
      sandcastleRun: (opts: RunOptions) => {
        captured.push(opts);
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
    const linear = new InMemoryLinearService();

    await runIssueQueue({
      ...baseRunOptions,
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      linear,
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
    const linear = new InMemoryLinearService();
    let runCount = 0;

    const result = await runIssueQueue({
      ...baseRunOptions,
      branch: "feature/eng",
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      linear,
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
          makeRunResult({ commits: [], completionSignal: undefined })
        );
      },
      readFinalAssistantMessage: () => Promise.resolve("summary text"),
    });

    expect(result.abortedAt).toBeUndefined();
    expect(linear.transitionsOf("uuid-eng-1")).toEqual(["In Progress"]);
    expect(linear.labelsOf("uuid-eng-1")).toEqual(["ready-for-human"]);
    expect(result.flipped).toBe(1);
  });
});

describe("runIssueQueue — host-side `git push` after every iteration", () => {
  test("after a working-agent iteration with ≥1 commit, fires `git push -u origin <branch>` on the host", async () => {
    const { runner, calls } = recordingShellRunner();
    const linear = new InMemoryLinearService();

    const result = await runIssueQueue({
      ...baseRunOptions,
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      linear,
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
    const linear = new InMemoryLinearService();

    const result = await runIssueQueue({
      ...baseRunOptions,
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      linear,
      sandcastleRun: (opts: RunOptions) => {
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
    expect(calls.filter((c) => c.cmd === "git")).toHaveLength(0);
  });

  test("when sandbox.run throws, the catch path attempts `git push` before returning the infra-abort", async () => {
    const { runner, calls } = recordingShellRunner();
    const linear = new InMemoryLinearService();

    const result = await runIssueQueue({
      ...baseRunOptions,
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered()],
      linear,
      sandcastleRun: () =>
        Promise.reject(new Error("sandcastle ran out of disk")),
      shellRunner: runner,
    });

    expect(result.completed).toBe(0);
    expect(result.abortedAt?.reason).toContain("ran out of disk");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("git");
    expect(calls[0]?.args).toEqual(["push", "-u", "origin", "feature/eng-1"]);
  });

  test("when `git push` exits non-zero, the runner warns and continues — no abort, no Linear mutation, no flip", async () => {
    const { runner, calls } = recordingShellRunner({
      exitCode: 1,
      stdout: "",
      stderr: "remote: temporary network blip",
    });
    const linear = new InMemoryLinearService({
      subIssuesByParent: {
        "uuid-prd": asSubIssues([
          makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
          makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
        ]),
      },
    });

    const result = await runIssueQueue({
      ...baseRunOptions,
      branch: "feature/eng",
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2" }),
      ],
      linear,
      sandcastleRun: () => Promise.resolve(makeRunResult()),
      shellRunner: runner,
    });

    expect(result.completed).toBe(2);
    expect(result.flipped).toBe(0);
    expect(result.abortedAt).toBeUndefined();
    expect(calls.filter((c) => c.cmd === "git")).toHaveLength(2);
    expect(linear.transitionsOf("uuid-1")).toEqual(["In Progress", "Done"]);
    expect(linear.transitionsOf("uuid-2")).toEqual(["In Progress", "Done"]);
  });
});

describe("runIssueQueue — Standalone Issue root: skip Done transition", () => {
  test("standalone DONE + commits → does NOT call transitionToDone; counts as completed", async () => {
    const linear = new InMemoryLinearService();

    const result = await runIssueQueue({
      ...baseRunOptions,
      branch: "feature/eng-7",
      root: { kind: "standalone" },
      orderedIssues: [makeOrdered({ id: "uuid-iss-7", identifier: "ENG-7" })],
      linear,
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    expect(result.completed).toBe(1);
    expect(result.flipped).toBe(0);
    expect(result.abortedAt).toBeUndefined();
    expect(linear.transitionsOf("uuid-iss-7")).toEqual(["In Progress"]);
  });

  test("standalone BLOCKED iteration: existing flip + comment path is preserved (no Done transition either)", async () => {
    const linear = new InMemoryLinearService();
    let runCount = 0;

    const result = await runIssueQueue({
      ...baseRunOptions,
      branch: "feature/eng-7",
      root: { kind: "standalone" },
      orderedIssues: [makeOrdered({ id: "uuid-iss-7", identifier: "ENG-7" })],
      linear,
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
    expect(linear.labelsOf("uuid-iss-7")).toEqual(["ready-for-human"]);
    expect(linear.commentsOn("uuid-iss-7")).toHaveLength(1);
    expect(linear.transitionsOf("uuid-iss-7")).toEqual(["In Progress"]);
  });

  test("PRD root: sub-issue DONE + commits → still calls transitionToDone (regression guard)", async () => {
    const linear = new InMemoryLinearService();

    await runIssueQueue({
      ...baseRunOptions,
      branch: "feature/eng",
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [makeOrdered({ id: "uuid-sub-1", identifier: "ENG-1" })],
      linear,
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    expect(linear.transitionsOf("uuid-sub-1")).toEqual(["In Progress", "Done"]);
  });
});

describe("runIssueQueue — mid-run queue rebuild (ADR-0010)", () => {
  test("PRD root: result.processed lists every sub-issue the runner ran an iteration on, in run order", async () => {
    const linear = new InMemoryLinearService({
      subIssuesByParent: {
        "uuid-prd": asSubIssues([
          makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
          makeOrdered({ id: "uuid-2", identifier: "ENG-2", title: "Second" }),
        ]),
      },
    });

    const result = await runIssueQueue({
      ...baseRunOptions,
      branch: "feature/eng",
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2", title: "Second" }),
      ],
      linear,
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    expect(result.processed.map((o) => o.identifier)).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
  });

  test("PRD root: human adds a fresh ready-for-agent sub-issue mid-run; it is absorbed and runs after the snapshot drains", async () => {
    const linear = new InMemoryLinearService();
    let fetchCount = 0;
    linear.setFetchSubIssuesHandler(() => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return Promise.resolve(
          asSubIssues([
            makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
            makeOrdered({
              id: "uuid-2",
              identifier: "ENG-2",
              title: "Late arrival",
            }),
          ])
        );
      }
      return Promise.resolve([]);
    });

    const result = await runIssueQueue({
      ...baseRunOptions,
      branch: "feature/eng",
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
      ],
      linear,
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    expect(result.completed).toBe(2);
    expect(result.flipped).toBe(0);
    expect(result.abortedAt).toBeUndefined();
    expect(result.processed.map((o) => o.identifier)).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
  });

  test("PRD root: late arrival X with blockedBy → still-queued Y runs Y first regardless of arrival order", async () => {
    const linear = new InMemoryLinearService();
    let fetchCount = 0;
    linear.setFetchSubIssuesHandler(() => {
      fetchCount += 1;
      if (fetchCount === 1) {
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
    });

    const result = await runIssueQueue({
      ...baseRunOptions,
      branch: "feature/eng",
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "Y first" }),
      ],
      linear,
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    expect(result.processed.map((o) => o.identifier)).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
  });

  test("PRD root: late arrival X with blockedBy → already-flipped sibling errors as external-blocker; X is skipped, the rest of the queue continues", async () => {
    const linear = new InMemoryLinearService();
    let fetchCount = 0;
    linear.setFetchSubIssuesHandler(() => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return Promise.resolve([
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
            makeOrdered({ id: "uuid-2", identifier: "ENG-2", title: "Second" }),
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
    });

    let runCount = 0;
    const result = await runIssueQueue({
      ...baseRunOptions,
      branch: "feature/eng",
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2", title: "Second" }),
      ],
      linear,
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
    expect(result.processed.map((o) => o.identifier)).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
  });

  test("PRD root: rebuild error survives the retry → tide aborts via the existing infra-failure path", async () => {
    const linear = new InMemoryLinearService();
    let fetchCount = 0;
    linear.setFetchSubIssuesHandler(() => {
      fetchCount += 1;
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
    });

    const result = await runIssueQueue({
      ...baseRunOptions,
      branch: "feature/eng",
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2", title: "Second" }),
      ],
      linear,
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    expect(result.abortedAt).toBeDefined();
    expect(result.abortedAt?.identifier).toMatch(/^ENG-/);
    expect(result.abortedAt?.reason).toContain("queue rebuild failed");
    expect(result.completed).toBe(1);
    expect(result.processed.map((o) => o.identifier)).toEqual(["ENG-1"]);
  });

  test("PRD root: fetchSubIssues throws mid-run → warn-and-continue with the previous boundary's queue", async () => {
    const linear = new InMemoryLinearService();
    let fetchCount = 0;
    linear.setFetchSubIssuesHandler(() => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return Promise.reject(new Error("Linear API hiccup"));
      }
      return Promise.resolve([]);
    });

    const result = await runIssueQueue({
      ...baseRunOptions,
      branch: "feature/eng",
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2", title: "Second" }),
      ],
      linear,
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    expect(result.abortedAt).toBeUndefined();
    expect(result.completed).toBe(2);
    expect(result.processed.map((o) => o.identifier)).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
  });

  test("PRD root: queued-but-not-yet-run sub-issue loses ready-for-agent mid-run → silently dropped on next rebuild", async () => {
    const linear = new InMemoryLinearService();
    let fetchCount = 0;
    linear.setFetchSubIssuesHandler(() => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return Promise.resolve([
          ...asSubIssues([
            makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
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
    });

    const result = await runIssueQueue({
      ...baseRunOptions,
      branch: "feature/eng",
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
        makeOrdered({ id: "uuid-2", identifier: "ENG-2", title: "Second" }),
      ],
      linear,
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    expect(result.abortedAt).toBeUndefined();
    expect(result.completed).toBe(1);
    expect(result.processed.map((o) => o.identifier)).toEqual(["ENG-1"]);
  });

  test("Standalone Issue root: never calls fetchSubIssues — the rebuild path is skipped entirely", async () => {
    const linear = new InMemoryLinearService();
    let fetchCalls = 0;
    linear.setFetchSubIssuesHandler(() => {
      fetchCalls += 1;
      return Promise.resolve([]);
    });

    const result = await runIssueQueue({
      ...baseRunOptions,
      branch: "feature/eng-7",
      root: { kind: "standalone" },
      orderedIssues: [makeOrdered({ id: "uuid-iss-7", identifier: "ENG-7" })],
      linear,
      sandcastleRun: () => Promise.resolve(makeRunResult()),
    });

    expect(fetchCalls).toBe(0);
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]?.identifier).toBe("ENG-7");
  });

  test("PRD root: an absorbed sub-issue that BLOCKEDs appears in `processed` and counts toward `flipped`", async () => {
    const linear = new InMemoryLinearService();
    let fetchCount = 0;
    linear.setFetchSubIssuesHandler(() => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return Promise.resolve(
          asSubIssues([
            makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
            makeOrdered({ id: "uuid-2", identifier: "ENG-2", title: "Late" }),
          ])
        );
      }
      return Promise.resolve([]);
    });

    let runCount = 0;
    const result = await runIssueQueue({
      ...baseRunOptions,
      branch: "feature/eng",
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
      orderedIssues: [
        makeOrdered({ id: "uuid-1", identifier: "ENG-1", title: "First" }),
      ],
      linear,
      sandcastleRun: (opts: RunOptions) => {
        runCount += 1;
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
});
