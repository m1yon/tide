import { describe, it, expect } from "bun:test";
import {
  buildPrPromptArgs,
  buildPrTitle,
  countCommitsAhead,
  resolveBaseBranch,
  runPrSubmission,
  type ShellResult,
  type ShellRunner,
} from "./index.ts";
import type { TideConfig } from "../config-loader/index.ts";
import type { RunOptions, RunResult } from "@ai-hero/sandcastle";
import type { SandcastleRunFn } from "../runner/index.ts";

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

const baseSandcastleRun: SandcastleRunFn = () =>
  Promise.resolve({
    iterations: [],
    stdout: "",
    commits: [],
    branch: "feature/per-32",
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
  it("happy path: fires the iteration, verifies via gh pr list, returns opened+url", async () => {
    const { runner, calls } = buildShellRunner([
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

    let receivedRunOptions: RunOptions | undefined;
    const sandcastleRun: SandcastleRunFn = (opts) => {
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
      rootIdentifier: "MEC-123",
      rootTitle: "PRD: example feature",
      rootUrl: "https://linear.app/acme/issue/MEC-123",
      subIssues: [
        { number: 8, title: "Foundation tracer" },
        { number: 9, title: "Pre-flight clack confirm" },
      ],
      repoRoot: "/repo",
      featureWorktreePath: "/repo/.tide/worktrees/feature-per-32",
      config: baseConfig,
      sandboxEnv: {},
      shellRunner: runner,
      sandcastleRun,
    });

    expect(result).toEqual({
      url: "https://github.com/acme/widget/pull/42",
      action: "opened",
    });

    // No `git push` is fired by pr-submission — the runner pushes
    // per-iteration. Only `gh pr list` runs through the shell.
    expect(calls.every((c) => c.cmd !== "git")).toBe(true);

    // The iteration was fired with the right shape. The PR-submission
    // iteration runs directly inside the Feature worktree under sandcastle's
    // `head` branch strategy — no per-call worktree, no merge step.
    expect(receivedRunOptions).toBeDefined();
    if (!receivedRunOptions) throw new Error("missing run options");
    expect(receivedRunOptions.branchStrategy).toEqual({ type: "head" });
    expect(receivedRunOptions.cwd).toBe("/repo/.tide/worktrees/feature-per-32");
    expect(receivedRunOptions.maxIterations).toBe(1);
    expect(receivedRunOptions.completionSignal).toEqual([
      "<promise>DONE</promise>",
    ]);
    expect(typeof receivedRunOptions.prompt).toBe("string");
    expect(receivedRunOptions.promptFile).toBeUndefined();
    // No closing magic word — neither GitHub nor Linear. The branch name
    // alone links the PR to the Linear PRD on merge.
    expect(receivedRunOptions.prompt).not.toContain("Closes #");
    expect(receivedRunOptions.prompt).not.toMatch(/Fixes\s+MEC-/);
    // Linear identifier surfaces in the body for human readers.
    expect(receivedRunOptions.prompt).toContain("MEC-123");
    // Branch and base must be substituted.
    expect(receivedRunOptions.prompt).toContain("feature/per-32");
    expect(receivedRunOptions.prompt).toContain("master");
    // Repo identifier is injected so the agent can pass --repo correctly.
    expect(receivedRunOptions.prompt).toContain("acme/widget");
    // Linear PRD URL is threaded through verbatim from the caller.
    expect(receivedRunOptions.prompt).toContain(
      "https://linear.app/acme/issue/MEC-123"
    );
    // No GitHub-issues URL leaks into the body.
    expect(receivedRunOptions.prompt).not.toContain(
      "https://github.com/acme/widget/issues/"
    );
    // The bundled rich template ships all five body sections.
    expect(receivedRunOptions.prompt).toContain("🚩 The Problem");
    expect(receivedRunOptions.prompt).toContain("💡 The Solution");
    expect(receivedRunOptions.prompt).toContain("🏗 Interface Movements");
    expect(receivedRunOptions.prompt).toContain("📦 Package Breakdowns");
    expect(receivedRunOptions.prompt).toContain(
      "🧹 Housekeeping & Secondary Changes"
    );
    // The `# Title` section reduces to a one-line directive wiring the
    // host-computed `{{PR_TITLE}}` (ADR-0013). Conventional Commits and the
    // type/scope/subject vocabulary are gone.
    expect(receivedRunOptions.prompt).toContain(
      "Use this exact title: [MEC-123] PRD: example feature"
    );
    expect(receivedRunOptions.prompt).not.toContain("Conventional Commits");
    expect(receivedRunOptions.prompt).not.toContain("<type>(<scope>)");
    expect(receivedRunOptions.prompt).not.toContain("<subject>");
    // The example `gh pr create` substitutes the title in single-quoted form.
    expect(receivedRunOptions.prompt).toContain(
      "--title '[MEC-123] PRD: example feature'"
    );
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

  it("throws when post-iteration gh pr list returns an empty array", async () => {
    const { runner } = buildShellRunner([
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
        rootIdentifier: "MEC-123",
        rootTitle: "PRD",
        rootUrl: "https://linear.app/acme/issue/MEC-123",
        subIssues: [],
        repoRoot: "/repo",
        featureWorktreePath: "/repo/.tide/worktrees/feature-per-32",
        config: baseConfig,
        sandboxEnv: {},
        shellRunner: runner,
        sandcastleRun: baseSandcastleRun,
      })
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/no PR was found/);
  });

  it("wraps sandcastle thrown errors with a tide-prefixed message", async () => {
    const { runner } = buildShellRunner([]);

    const sandcastleRun: SandcastleRunFn = () =>
      Promise.reject(new Error("sandbox failed to start"));

    const err = await captureError(
      runPrSubmission({
        ghRepo: baseGhRepo,
        branch: "feature/per-32",
        baseBranch: "master",
        rootIdentifier: "MEC-123",
        rootTitle: "PRD",
        rootUrl: "https://linear.app/acme/issue/MEC-123",
        subIssues: [],
        repoRoot: "/repo",
        featureWorktreePath: "/repo/.tide/worktrees/feature-per-32",
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
    rootIdentifier: "MEC-123",
    rootTitle: "PRD: example feature",
    rootUrl: "https://linear.app/acme/issue/MEC-123",
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
        "FEATURE_BRANCH",
        "PR_TITLE",
        "REPO_NAME",
        "REPO_OWNER",
        "ROOT_ID",
        "ROOT_TITLE",
        "ROOT_URL",
        "SUB_ISSUES_BLOCK",
      ].sort()
    );
    expect(args.ROOT_ID).toBe("MEC-123");
    expect(args.ROOT_TITLE).toBe("PRD: example feature");
    expect(args.ROOT_URL).toBe("https://linear.app/acme/issue/MEC-123");
    expect(args.FEATURE_BRANCH).toBe("feature/per-32");
    expect(args.BASE_BRANCH).toBe("master");
    expect(args.REPO_OWNER).toBe("acme");
    expect(args.REPO_NAME).toBe("widget");
    expect(args.PR_TITLE).toBe("[MEC-123] PRD: example feature");
  });

  it("computes PR_TITLE with the working repo's `[<repoName>] ` prefix stripped", () => {
    const args = buildPrPromptArgs({
      ...baseInput,
      rootTitle: "[widget] PRD: example feature",
      subIssues: [],
    });
    expect(args.PR_TITLE).toBe("[MEC-123] PRD: example feature");
  });

  it("omits the entire `Sub-issues addressed` block when subIssues is empty (Standalone Issue root)", () => {
    const args = buildPrPromptArgs({ ...baseInput, subIssues: [] });
    expect(args.SUB_ISSUES_BLOCK).toBe("");
  });

  it("renders one sub-issue under the `Sub-issues addressed` heading", () => {
    const args = buildPrPromptArgs({
      ...baseInput,
      subIssues: [{ number: 42, title: "Wire up the runner" }],
    });
    expect(args.SUB_ISSUES_BLOCK).toBe(
      "- Sub-issues addressed (in order):\n- #42 Wire up the runner"
    );
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
    expect(args.SUB_ISSUES_BLOCK).toBe(
      [
        "- Sub-issues addressed (in order):",
        "- #8 Foundation tracer",
        "- #9 Pre-flight clack confirm",
        "- #10 Rev-list zero-commits gate",
      ].join("\n")
    );
  });

  it("collapses newlines in user-controlled titles to spaces (escaping)", () => {
    const args = buildPrPromptArgs({
      ...baseInput,
      rootTitle: "PRD: line one\nline two",
      subIssues: [{ number: 100, title: "Title with\r\nembedded\rnewlines" }],
    });
    expect(args.ROOT_TITLE).toBe("PRD: line one line two");
    expect(args.SUB_ISSUES_BLOCK).toBe(
      "- Sub-issues addressed (in order):\n- #100 Title with embedded newlines"
    );
  });

  it("trims surrounding whitespace from titles", () => {
    const args = buildPrPromptArgs({
      ...baseInput,
      rootTitle: "  Padded PRD  ",
      subIssues: [{ number: 1, title: "  spaced  " }],
    });
    expect(args.ROOT_TITLE).toBe("Padded PRD");
    expect(args.SUB_ISSUES_BLOCK).toBe(
      "- Sub-issues addressed (in order):\n- #1 spaced"
    );
  });
});

describe("buildPrTitle", () => {
  it("composes `[<rootIdentifier>] <root-title>` for a bare title with no Repo prefix", () => {
    expect(
      buildPrTitle({
        rootIdentifier: "PER-76",
        rootTitle: "add linear issue prefix to PR title",
        repoName: "tide",
      })
    ).toBe("[PER-76] add linear issue prefix to PR title");
  });

  it("strips the working repo's `[<repoName>] ` prefix before composing the title", () => {
    expect(
      buildPrTitle({
        rootIdentifier: "PER-76",
        rootTitle: "[tide] add linear issue prefix to PR title",
        repoName: "tide",
      })
    ).toBe("[PER-76] add linear issue prefix to PR title");
  });

  it("is idempotent: titles already lacking the Repo prefix pass through unchanged", () => {
    const first = buildPrTitle({
      rootIdentifier: "PER-76",
      rootTitle: "add linear issue prefix to PR title",
      repoName: "tide",
    });
    const second = buildPrTitle({
      rootIdentifier: "PER-76",
      rootTitle: first.replace(/^\[PER-76\] /, ""),
      repoName: "tide",
    });
    expect(second).toBe(first);
  });

  it("preserves a non-matching bracketed prefix (`[other] ` where other !== repoName)", () => {
    expect(
      buildPrTitle({
        rootIdentifier: "PER-76",
        rootTitle: "[other] add linear issue prefix to PR title",
        repoName: "tide",
      })
    ).toBe("[PER-76] [other] add linear issue prefix to PR title");
  });

  it("collapses internal whitespace (newlines, tabs, multiple spaces) and trims, before composing", () => {
    expect(
      buildPrTitle({
        rootIdentifier: "PER-76",
        rootTitle: "  add\tlinear\nissue   prefix  ",
        repoName: "tide",
      })
    ).toBe("[PER-76] add linear issue prefix");
  });

  it("strips Repo prefix even when whitespace inside the title was originally awkward", () => {
    // Sanitization runs before the prefix strip, so a title like
    // `[tide]\nfoo` collapses to `[tide] foo` and then gets stripped to
    // `foo`. Matches the byte-for-byte form the triage skill writes.
    expect(
      buildPrTitle({
        rootIdentifier: "PER-76",
        rootTitle: "[tide]\nfoo",
        repoName: "tide",
      })
    ).toBe("[PER-76] foo");
  });

  it("strips the prefix only once — never double-strips a `[<repo>] [<repo>] ` chain", () => {
    expect(
      buildPrTitle({
        rootIdentifier: "PER-76",
        rootTitle: "[tide] [tide] foo",
        repoName: "tide",
      })
    ).toBe("[PER-76] [tide] foo");
  });
});
