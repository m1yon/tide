// Orchestration tests for `runIssueQueue` with the sandbox stubbed. The
// goal is contract coverage of the runner's per-iteration flow:
//
// - sub-issue is transitioned to In Progress *before* sandbox.run() fires
// - DONE signal + commits → transition to Done, queue continues
// - BLOCKED signal → run summarizer, post summarizer-generated comment,
//   flip label, continue
// - agent-FAIL (no DONE, no commits) → same path as BLOCKED with the
//   `fail-summary` prompt
// - infra FAIL (run() throws) → queue aborts, no label flip, no summarizer
// - per-iteration prompt args carry baseBranch through

import { describe, expect, test } from "bun:test";
import type { SandboxRunOptions, SandboxRunResult } from "@ai-hero/sandcastle";
import {
  BLOCKED_SIGNAL,
  DONE_SIGNAL,
  runIssueQueue,
  type OrderedIssue,
  type ShellResult,
  type ShellRunner,
} from "./index.ts";
import type { TideConfig } from "../config-loader/index.ts";
import type { LinearContext, LinearIssueContent } from "../linear/index.ts";

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

function makeSandboxRunResult(
  overrides: Partial<SandboxRunResult> = {}
): SandboxRunResult {
  return {
    iterations: [],
    completionSignal: DONE_SIGNAL,
    stdout: "",
    commits: [{ sha: "abc" }],
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
      sandboxRun: () => {
        events.push("run");
        return Promise.resolve(makeSandboxRunResult());
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
      sandboxRun: (opts: SandboxRunOptions) => {
        events.push(`run:${opts.name ?? "unknown"}`);
        sandboxRunNames.push(opts.name ?? "unknown");
        runCount += 1;
        // First call: working agent agent-fails. Second call: summarizer
        // for the failed sub-issue. Third: working agent of next sub-issue
        // succeeds.
        if (runCount === 1) {
          return Promise.resolve(
            makeSandboxRunResult({
              commits: [],
              completionSignal: undefined,
              logFilePath: "/tmp/eng-1-working.log",
            })
          );
        }
        if (runCount === 2) {
          return Promise.resolve(
            makeSandboxRunResult({
              commits: [],
              completionSignal: undefined,
              logFilePath: "/tmp/eng-1-summarizer.log",
            })
          );
        }
        return Promise.resolve(makeSandboxRunResult());
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
      sandboxRun: (opts: SandboxRunOptions) => {
        events.push(`run:${opts.name ?? "unknown"}`);
        runCount += 1;
        if (runCount === 1) {
          return Promise.resolve(
            makeSandboxRunResult({
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
            makeSandboxRunResult({
              commits: [],
              completionSignal: undefined,
              logFilePath: "/tmp/eng-1-summarizer.log",
            })
          );
        }
        return Promise.resolve(makeSandboxRunResult());
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
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      flipLabelToReadyForHuman: () => Promise.resolve(),
      postComment: () => Promise.resolve(),
      sandboxRun: (opts: SandboxRunOptions) => {
        // Capture only the working-agent invocation (not the summarizer).
        if (opts.name === "tide") {
          capturedSignal = opts.completionSignal;
        }
        return Promise.resolve(makeSandboxRunResult());
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
      sandboxRun: (opts: SandboxRunOptions) => {
        events.push(`run:${opts.name ?? "unknown"}`);
        if (opts.name === "tide") {
          return Promise.resolve(
            makeSandboxRunResult({
              commits: [],
              completionSignal: DONE_SIGNAL,
            })
          );
        }
        return Promise.resolve(
          makeSandboxRunResult({
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
      sandboxRun: (opts: SandboxRunOptions) => {
        events.push(`run:${opts.name ?? "unknown"}`);
        if (opts.name === "tide") {
          return Promise.resolve(
            makeSandboxRunResult({
              commits: [{ sha: "abc" }],
              completionSignal: undefined,
            })
          );
        }
        return Promise.resolve(
          makeSandboxRunResult({
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
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      flipLabelToReadyForHuman: () => Promise.resolve(),
      postComment: (_ctx, issueId, body) => {
        postedComments.push({ issueId, body });
        return Promise.resolve();
      },
      sandboxRun: () => {
        runCount += 1;
        // Working agent BLOCKED.
        if (runCount === 1) {
          return Promise.resolve(
            makeSandboxRunResult({
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
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      flipLabelToReadyForHuman: () => Promise.resolve(),
      postComment: (_ctx, issueId, body) => {
        postedComments.push({ issueId, body });
        return Promise.resolve();
      },
      sandboxRun: () => {
        runCount += 1;
        if (runCount === 1) {
          return Promise.resolve(
            makeSandboxRunResult({
              commits: [],
              completionSignal: BLOCKED_SIGNAL,
              logFilePath: "/tmp/working.log",
            })
          );
        }
        return Promise.resolve(
          makeSandboxRunResult({
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
      sandboxRun: (opts: SandboxRunOptions) => {
        events.push(`run:${opts.name ?? "unknown"}`);
        if (opts.name === "tide") {
          return Promise.resolve(
            makeSandboxRunResult({
              commits: [],
              completionSignal: BLOCKED_SIGNAL,
              logFilePath: "/tmp/working.log",
            })
          );
        }
        return Promise.resolve(
          makeSandboxRunResult({
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
      sandboxRun: () => Promise.reject(new Error("docker daemon down")),
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
      sandboxRun: () => {
        events.push("run");
        return Promise.resolve(makeSandboxRunResult());
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
      sandboxRun: () => Promise.resolve(makeSandboxRunResult()),
    });

    expect(inProgressCalls).toEqual(["uuid-eng-1"]);
    expect(doneCalls).toEqual(["uuid-eng-1"]);
  });
});

describe("runIssueQueue — prompt args + sandcastle wiring", () => {
  test("registers both DONE and BLOCKED signals with sandcastle and surfaces sub-issue identity in promptArgs", async () => {
    let capturedOpts: SandboxRunOptions | undefined;

    await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
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
      sandboxRun: (opts: SandboxRunOptions) => {
        // Only capture the working-agent invocation (skip the summarizer).
        if (opts.name === "tide") capturedOpts = opts;
        return Promise.resolve(makeSandboxRunResult());
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
    // SOURCE_BRANCH / TARGET_BRANCH are sandcastle built-ins; they must not
    // appear in promptArgs (the SDK rejects overrides).
    expect(args.SOURCE_BRANCH).toBeUndefined();
    expect(args.TARGET_BRANCH).toBeUndefined();
  });

  test("working-agent run uses file-based logging so the summarizer can read the transcript", async () => {
    let capturedOpts: SandboxRunOptions | undefined;

    await runIssueQueue({
      root: { kind: "prd", id: "uuid-prd", identifier: "ENG-100" },
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
      sandboxRun: (opts: SandboxRunOptions) => {
        if (opts.name === "tide") capturedOpts = opts;
        return Promise.resolve(makeSandboxRunResult());
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
      sandboxRun: () => {
        runCount += 1;
        if (runCount === 1) {
          return Promise.resolve(
            makeSandboxRunResult({
              commits: [{ sha: "abc" }],
              completionSignal: "<promise>COMPLETE</promise>",
            })
          );
        }
        return Promise.resolve(
          makeSandboxRunResult({
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
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      sandboxRun: () => Promise.resolve(makeSandboxRunResult()),
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
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      flipLabelToReadyForHuman: () => Promise.resolve(),
      postComment: () => Promise.resolve(),
      sandboxRun: (opts: SandboxRunOptions) => {
        // Working-agent iteration: zero commits, no signal → agent-FAIL.
        // Summarizer iteration: also zero commits.
        if (opts.name === "tide") {
          return Promise.resolve(
            makeSandboxRunResult({
              commits: [],
              completionSignal: undefined,
              logFilePath: "/tmp/working.log",
            })
          );
        }
        return Promise.resolve(
          makeSandboxRunResult({
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
      config: baseConfig,
      sandboxEnv: {},
      fetchIssueContent: () => Promise.resolve(makeIssueContent()),
      transitionToInProgress: () => Promise.resolve(),
      transitionToDone: () => Promise.resolve(),
      sandboxRun: () => Promise.reject(new Error("sandcastle ran out of disk")),
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
      postComment: (_ctx, issueId) => {
        events.push(`comment:${issueId}`);
        return Promise.resolve();
      },
      sandboxRun: () => Promise.resolve(makeSandboxRunResult()),
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
