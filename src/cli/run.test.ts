import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrTailStep, tideRun } from "./run.ts";
import type {
  PrSubmissionResult,
  ShellResult,
  ShellRunner,
} from "../pr-submission/index.ts";
import type { TideConfig } from "../config-loader/index.ts";

interface Sinks {
  stdout: string[];
  stderr: string[];
  pushStdout: (s: string) => void;
  pushStderr: (s: string) => void;
}

function makeSinks(): Sinks {
  const sinks: Sinks = {
    stdout: [],
    stderr: [],
    pushStdout: () => undefined,
    pushStderr: () => undefined,
  };
  sinks.pushStdout = (s) => sinks.stdout.push(s);
  sinks.pushStderr = (s) => sinks.stderr.push(s);
  return sinks;
}

function constShellRunner(result: ShellResult): ShellRunner {
  return () => Promise.resolve(result);
}

describe("tideRun base-branch capture", () => {
  let workDir: string;
  let repoRoot: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tide-run-"));
    repoRoot = join(workDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(join(repoRoot, ".tide"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("detached HEAD fails fast before any queue work runs", async () => {
    const sinks = makeSinks();
    const code = await tideRun({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      // Simulate `git rev-parse --abbrev-ref HEAD` returning "HEAD" — the
      // sentinel git uses for detached-HEAD state.
      baseBranchShellRunner: constShellRunner({
        exitCode: 0,
        stdout: "HEAD\n",
        stderr: "",
      }),
    });

    expect(code).toBe(1);
    expect(sinks.stderr.join("")).toContain("detached HEAD");
  });

  test("git rev-parse failure also fails fast with a clear error", async () => {
    const sinks = makeSinks();
    const code = await tideRun({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      baseBranchShellRunner: constShellRunner({
        exitCode: 128,
        stdout: "",
        stderr: "fatal: not a git repository",
      }),
    });

    expect(code).toBe(1);
    expect(sinks.stderr.join("")).toContain("git rev-parse");
  });
});

describe("runPrTailStep", () => {
  const baseConfig: TideConfig = {
    linear: { team: "ENG" },
    sandbox: { mounts: [] },
    hooks: { onSandboxReady: [] },
  };
  const baseGhRepo = { owner: "acme", repo: "widget" };

  const baseInput = {
    ghRepo: baseGhRepo,
    branch: "feature/per-32",
    baseBranch: "master",
    parentNumber: 7,
    parentTitle: "PRD: example feature",
    repoRoot: "/repo",
    config: baseConfig,
    sandboxEnv: {},
    completedCount: 3,
    // Default to non-zero so tests that don't care about the rev-list gate
    // exercise the runPrSubmission path.
    countCommitsAhead: () => Promise.resolve(5),
  };

  test("confirm=no: skips runPrSubmission, returns opted-out outcome with distinct outro", async () => {
    let calls = 0;
    const runPrSubmission = (): Promise<PrSubmissionResult> => {
      calls += 1;
      return Promise.resolve({
        url: "should-not-be-called",
        action: "opened",
      });
    };

    const result = await runPrTailStep({
      ...baseInput,
      prCreationConfirmed: false,
      runPrSubmission,
    });

    expect(calls).toBe(0);
    expect(result.outcome).toEqual({ kind: "opted-out" });
    expect(result.exitCode).toBe(0);
    // Distinct outro: contains a recognizable opt-out marker, not the
    // "PR opened" or "PR submission failed" wording used on other paths.
    expect(result.outroMessage).toContain("PR step skipped");
    expect(result.outroMessage).not.toContain("PR opened");
    expect(result.outroMessage).not.toContain("PR submission failed");
  });

  test("confirm=yes + zero commits ahead: skips runPrSubmission, returns skipped-empty outcome with distinct outro", async () => {
    let prCalls = 0;
    const runPrSubmission = (): Promise<PrSubmissionResult> => {
      prCalls += 1;
      return Promise.resolve({
        url: "should-not-be-called",
        action: "opened",
      });
    };

    let countCalls = 0;
    const countCommitsAhead = (): Promise<number> => {
      countCalls += 1;
      return Promise.resolve(0);
    };

    const result = await runPrTailStep({
      ...baseInput,
      prCreationConfirmed: true,
      countCommitsAhead,
      runPrSubmission,
    });

    expect(prCalls).toBe(0);
    expect(countCalls).toBe(1);
    expect(result.outcome).toEqual({ kind: "skipped-empty" });
    expect(result.exitCode).toBe(0);
    // Distinct outro: identifies zero-commits as the reason, not opt-out
    // and not failure.
    expect(result.outroMessage).toContain("PR step skipped");
    expect(result.outroMessage).toContain("no commits ahead");
    expect(result.outroMessage).not.toContain("opted out");
    expect(result.outroMessage).not.toContain("PR submission failed");
  });

  test("confirm=no: rev-list gate is not run (opt-out short-circuits)", async () => {
    let countCalls = 0;
    const countCommitsAhead = (): Promise<number> => {
      countCalls += 1;
      return Promise.resolve(0);
    };

    const result = await runPrTailStep({
      ...baseInput,
      prCreationConfirmed: false,
      countCommitsAhead,
    });

    expect(countCalls).toBe(0);
    expect(result.outcome).toEqual({ kind: "opted-out" });
  });

  test("confirm=yes: invokes runPrSubmission and returns opened outcome", async () => {
    const runPrSubmission = (): Promise<PrSubmissionResult> =>
      Promise.resolve({
        url: "https://github.com/acme/widget/pull/42",
        action: "opened",
      });

    const result = await runPrTailStep({
      ...baseInput,
      prCreationConfirmed: true,
      runPrSubmission,
    });

    expect(result.outcome).toEqual({
      kind: "opened",
      url: "https://github.com/acme/widget/pull/42",
    });
    expect(result.exitCode).toBe(0);
    expect(result.outroMessage).toContain("PR opened");
    expect(result.outroMessage).toContain(
      "https://github.com/acme/widget/pull/42"
    );
  });

  test("confirm=yes but runPrSubmission throws: returns failed outcome with exitCode 1", async () => {
    const runPrSubmission = (): Promise<PrSubmissionResult> =>
      Promise.reject(new Error("push refused by remote"));

    const result = await runPrTailStep({
      ...baseInput,
      prCreationConfirmed: true,
      runPrSubmission,
    });

    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") {
      expect(result.outcome.message).toMatch(/push refused/);
    }
    expect(result.exitCode).toBe(1);
    expect(result.outroMessage).toContain("PR submission failed");
  });
});
