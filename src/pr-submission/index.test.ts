import { describe, it, expect } from "bun:test";
import {
  buildPrPromptArgs,
  countCommitsAhead,
  resolveBaseBranch,
  runPrSubmission,
  type ShellResult,
  type ShellRunner,
  type SandcastleRun,
} from "./index.ts";
import type { TideConfig } from "../config-loader/index.ts";
import type { RunResult } from "@ai-hero/sandcastle";

interface ShellCall {
  cmd: string;
  args: readonly string[];
  cwd: string;
}

interface ShellStubEntry {
  match: (call: ShellCall) => boolean;
  result: ShellResult;
}

function buildShellRunner(stubs: ShellStubEntry[]): {
  runner: ShellRunner;
  calls: ShellCall[];
} {
  const calls: ShellCall[] = [];
  const runner: ShellRunner = (cmd, args, cwd) => {
    const call: ShellCall = { cmd, args: [...args], cwd };
    calls.push(call);
    const stub = stubs.find((s) => s.match(call));
    if (!stub) {
      return Promise.reject(
        new Error(`unstubbed shell call: ${cmd} ${args.join(" ")} (cwd=${cwd})`)
      );
    }
    return Promise.resolve(stub.result);
  };
  return { runner, calls };
}

async function captureError<T>(p: Promise<T>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
}

const baseConfig: TideConfig = {
  linear: { team: "ENG" },
  sandbox: { mounts: [] },
  hooks: { onSandboxReady: [] },
};

const baseGhRepo = { owner: "acme", repo: "widget" };

const baseSandcastleRun: SandcastleRun = () =>
  Promise.resolve({
    iterations: [],
    stdout: "",
    commits: [],
    branch: "feature/foo",
  } satisfies RunResult);

describe("resolveBaseBranch", () => {
  it("returns the trimmed branch name on success", async () => {
    const { runner } = buildShellRunner([
      {
        match: (c) =>
          c.cmd === "git" && c.args.join(" ") === "rev-parse --abbrev-ref HEAD",
        result: { exitCode: 0, stdout: "main\n", stderr: "" },
      },
    ]);
    const branch = await resolveBaseBranch("/tmp/repo", runner);
    expect(branch).toBe("main");
  });

  it("throws a clear error on detached HEAD (output 'HEAD')", async () => {
    const { runner } = buildShellRunner([
      {
        match: (c) =>
          c.cmd === "git" && c.args.join(" ") === "rev-parse --abbrev-ref HEAD",
        result: { exitCode: 0, stdout: "HEAD\n", stderr: "" },
      },
    ]);
    const err = await captureError(resolveBaseBranch("/tmp/repo", runner));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/detached HEAD/);
  });

  it("throws when git rev-parse exits non-zero", async () => {
    const { runner } = buildShellRunner([
      {
        match: (c) => c.cmd === "git",
        result: { exitCode: 128, stdout: "", stderr: "fatal: not a git repo" },
      },
    ]);
    const err = await captureError(resolveBaseBranch("/tmp/repo", runner));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/git rev-parse.*failed/);
  });
});

describe("countCommitsAhead", () => {
  it("returns the parsed integer count on success", async () => {
    const { runner, calls } = buildShellRunner([
      {
        match: (c) =>
          c.cmd === "git" &&
          c.args[0] === "rev-list" &&
          c.args[1] === "--count",
        result: { exitCode: 0, stdout: "5\n", stderr: "" },
      },
    ]);
    const n = await countCommitsAhead("/tmp/repo", "main", "feature/x", runner);
    expect(n).toBe(5);
    expect(calls[0]?.args).toEqual(["rev-list", "--count", "main..feature/x"]);
  });

  it("returns 0 when the branch has no commits ahead of base", async () => {
    const { runner } = buildShellRunner([
      {
        match: (c) => c.cmd === "git" && c.args[0] === "rev-list",
        result: { exitCode: 0, stdout: "0\n", stderr: "" },
      },
    ]);
    const n = await countCommitsAhead("/tmp/repo", "main", "feature/x", runner);
    expect(n).toBe(0);
  });

  it("throws when git rev-list exits non-zero", async () => {
    const { runner } = buildShellRunner([
      {
        match: (c) => c.cmd === "git" && c.args[0] === "rev-list",
        result: {
          exitCode: 128,
          stdout: "",
          stderr: "fatal: ambiguous argument",
        },
      },
    ]);
    const err = await captureError(
      countCommitsAhead("/tmp/repo", "main", "feature/x", runner)
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/git rev-list.*failed/);
  });
});

describe("runPrSubmission", () => {
  it("happy path: pushes the branch, fires the iteration, verifies via gh pr list, returns opened+url", async () => {
    const { runner, calls } = buildShellRunner([
      {
        match: (c) => c.cmd === "git" && c.args[0] === "push",
        result: { exitCode: 0, stdout: "", stderr: "" },
      },
      {
        match: (c) =>
          c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "list",
        result: {
          exitCode: 0,
          stdout: JSON.stringify([
            { number: 42, url: "https://github.com/acme/widget/pull/42" },
          ]),
          stderr: "",
        },
      },
    ]);

    let receivedRunOptions: Parameters<SandcastleRun>[0] | undefined;
    const sandcastleRun: SandcastleRun = (opts) => {
      receivedRunOptions = opts;
      return Promise.resolve({
        iterations: [],
        stdout: "",
        commits: [],
        branch: "feature/per-32",
      } satisfies RunResult);
    };

    const result = await runPrSubmission({
      ghRepo: baseGhRepo,
      branch: "feature/per-32",
      baseBranch: "master",
      parentNumber: 7,
      parentTitle: "PRD: example feature",
      subIssues: [
        { number: 8, title: "Foundation tracer" },
        { number: 9, title: "Pre-flight clack confirm" },
      ],
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      shellRunner: runner,
      sandcastleRun,
    });

    expect(result).toEqual({
      url: "https://github.com/acme/widget/pull/42",
      action: "opened",
    });

    // Push happened first.
    expect(calls[0]?.cmd).toBe("git");
    expect(calls[0]?.args).toEqual(["push", "-u", "origin", "feature/per-32"]);
    expect(calls[0]?.cwd).toBe("/repo");

    // The iteration was fired with the right shape.
    expect(receivedRunOptions).toBeDefined();
    if (!receivedRunOptions) throw new Error("missing run options");
    expect(receivedRunOptions.maxIterations).toBe(1);
    expect(receivedRunOptions.branchStrategy).toEqual({
      type: "branch",
      branch: "feature/per-32",
    });
    expect(typeof receivedRunOptions.prompt).toBe("string");
    expect(receivedRunOptions.promptFile).toBeUndefined();
    // Body must close the parent PRD.
    expect(receivedRunOptions.prompt).toContain("Closes #7");
    // Branch and base must be substituted.
    expect(receivedRunOptions.prompt).toContain("feature/per-32");
    expect(receivedRunOptions.prompt).toContain("master");
    // Repo identifier is injected so the agent can pass --repo correctly.
    expect(receivedRunOptions.prompt).toContain("acme/widget");
    // PRD URL is derived host-side from owner/repo + parent number and
    // surfaced to the agent so it can link back from the body.
    expect(receivedRunOptions.prompt).toContain(
      "https://github.com/acme/widget/issues/7"
    );
    // The bundled rich template ships all six sections plus a Conventional
    // Commits title rule.
    expect(receivedRunOptions.prompt).toContain("🚩 The Problem");
    expect(receivedRunOptions.prompt).toContain("💡 The Solution");
    expect(receivedRunOptions.prompt).toContain("🏗 Interface Movements");
    expect(receivedRunOptions.prompt).toContain("📦 Package Breakdowns");
    expect(receivedRunOptions.prompt).toContain(
      "🧹 Housekeeping & Secondary Changes"
    );
    expect(receivedRunOptions.prompt).toContain("Conventional Commits");
    // Ordered sub-issue list shows up in the rendered prompt.
    expect(receivedRunOptions.prompt).toContain("#8 Foundation tracer");
    expect(receivedRunOptions.prompt).toContain("#9 Pre-flight clack confirm");

    // gh pr list ran with --head <branch>.
    const ghCall = calls.find((c) => c.cmd === "gh");
    expect(ghCall?.args).toContain("--head");
    expect(ghCall?.args).toContain("feature/per-32");
    expect(ghCall?.args).toContain("--json");
    expect(ghCall?.args).toContain("number,url");
  });

  it("throws when git push fails — never reaches the iteration", async () => {
    let sandcastleCalled = false;
    const sandcastleRun: SandcastleRun = () => {
      sandcastleCalled = true;
      return baseSandcastleRun({} as Parameters<SandcastleRun>[0]);
    };

    const { runner } = buildShellRunner([
      {
        match: (c) => c.cmd === "git" && c.args[0] === "push",
        result: {
          exitCode: 1,
          stdout: "",
          stderr: "remote: Permission to acme/widget.git denied",
        },
      },
    ]);

    const err = await captureError(
      runPrSubmission({
        ghRepo: baseGhRepo,
        branch: "feature/per-32",
        baseBranch: "master",
        parentNumber: 7,
        parentTitle: "PRD",
        subIssues: [],
        repoRoot: "/repo",
        config: baseConfig,
        sandboxEnv: {},
        shellRunner: runner,
        sandcastleRun,
      })
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/git push.*failed/);
    expect(sandcastleCalled).toBe(false);
  });

  it("throws when post-iteration gh pr list returns an empty array", async () => {
    const { runner } = buildShellRunner([
      {
        match: (c) => c.cmd === "git" && c.args[0] === "push",
        result: { exitCode: 0, stdout: "", stderr: "" },
      },
      {
        match: (c) => c.cmd === "gh",
        result: {
          exitCode: 0,
          stdout: "[]",
          stderr: "",
        },
      },
    ]);

    const err = await captureError(
      runPrSubmission({
        ghRepo: baseGhRepo,
        branch: "feature/per-32",
        baseBranch: "master",
        parentNumber: 7,
        parentTitle: "PRD",
        subIssues: [],
        repoRoot: "/repo",
        config: baseConfig,
        sandboxEnv: {},
        shellRunner: runner,
        sandcastleRun: baseSandcastleRun,
      })
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/no PR was found/);
  });

  it("wraps Sandcastle thrown errors with a tide-prefixed message", async () => {
    const { runner } = buildShellRunner([
      {
        match: (c) => c.cmd === "git" && c.args[0] === "push",
        result: { exitCode: 0, stdout: "", stderr: "" },
      },
    ]);

    const sandcastleRun: SandcastleRun = () =>
      Promise.reject(new Error("sandbox failed to start"));

    const err = await captureError(
      runPrSubmission({
        ghRepo: baseGhRepo,
        branch: "feature/per-32",
        baseBranch: "master",
        parentNumber: 7,
        parentTitle: "PRD",
        subIssues: [],
        repoRoot: "/repo",
        config: baseConfig,
        sandboxEnv: {},
        shellRunner: runner,
        sandcastleRun,
      })
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /PR submission iteration threw.*sandbox failed to start/
    );
  });
});

describe("buildPrPromptArgs", () => {
  const baseInput = {
    parentNumber: 7,
    parentTitle: "PRD: example feature",
    parentUrl: "https://github.com/acme/widget/issues/7",
    branch: "feature/per-32",
    baseBranch: "master",
    repoOwner: "acme",
    repoName: "widget",
  };

  it("returns the full set of substitution keys", () => {
    const args = buildPrPromptArgs({
      ...baseInput,
      subIssues: [{ number: 8, title: "Foundation tracer" }],
    });
    expect(Object.keys(args).sort()).toEqual(
      [
        "BASE_BRANCH",
        "BRANCH",
        "PARENT_ID",
        "PARENT_TITLE",
        "PARENT_URL",
        "REPO_NAME",
        "REPO_OWNER",
        "SUB_ISSUES",
      ].sort()
    );
    expect(args.PARENT_ID).toBe(7);
    expect(args.PARENT_TITLE).toBe("PRD: example feature");
    expect(args.PARENT_URL).toBe("https://github.com/acme/widget/issues/7");
    expect(args.BRANCH).toBe("feature/per-32");
    expect(args.BASE_BRANCH).toBe("master");
    expect(args.REPO_OWNER).toBe("acme");
    expect(args.REPO_NAME).toBe("widget");
  });

  it("renders zero sub-issues with a stable placeholder rather than an empty list", () => {
    const args = buildPrPromptArgs({ ...baseInput, subIssues: [] });
    expect(args.SUB_ISSUES).toBe("_(none)_");
  });

  it("renders one sub-issue as a single bullet line", () => {
    const args = buildPrPromptArgs({
      ...baseInput,
      subIssues: [{ number: 42, title: "Wire up the runner" }],
    });
    expect(args.SUB_ISSUES).toBe("- #42 Wire up the runner");
  });

  it("renders many sub-issues in input order, one bullet per", () => {
    const args = buildPrPromptArgs({
      ...baseInput,
      subIssues: [
        { number: 8, title: "Foundation tracer" },
        { number: 9, title: "Pre-flight clack confirm" },
        { number: 10, title: "Rev-list zero-commits gate" },
      ],
    });
    expect(args.SUB_ISSUES).toBe(
      [
        "- #8 Foundation tracer",
        "- #9 Pre-flight clack confirm",
        "- #10 Rev-list zero-commits gate",
      ].join("\n")
    );
  });

  it("collapses newlines in user-controlled titles to spaces (escaping)", () => {
    const args = buildPrPromptArgs({
      ...baseInput,
      parentTitle: "PRD: line one\nline two",
      subIssues: [{ number: 100, title: "Title with\r\nembedded\rnewlines" }],
    });
    expect(args.PARENT_TITLE).toBe("PRD: line one line two");
    expect(args.SUB_ISSUES).toBe("- #100 Title with embedded newlines");
  });

  it("trims surrounding whitespace from titles", () => {
    const args = buildPrPromptArgs({
      ...baseInput,
      parentTitle: "  Padded PRD  ",
      subIssues: [{ number: 1, title: "  spaced  " }],
    });
    expect(args.PARENT_TITLE).toBe("Padded PRD");
    expect(args.SUB_ISSUES).toBe("- #1 spaced");
  });
});
