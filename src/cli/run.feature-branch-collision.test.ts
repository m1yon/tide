// Regression test for the gap PER-77 was supposed to close: invoking
// `tide run` from a feature branch that is already checked out at the main
// repo. PER-77 added the Branch override UI (silent + take paths both
// produce `featureBranch === currentBranch`) but every PER-77 test stubbed
// `createWorktree`, so sandcastle's collision check (`Branch X is already
// checked out in worktree at <main repo>`) was never exercised.
//
// This test sets up a real git repo with `feature/foo` checked out at the
// main worktree, calls `runQueueAfterPick` with the *real* sandcastle
// `createWorktree`, and asserts the pre-flight releases the branch from
// the main checkout so the managed worktree creation succeeds.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PRD, SubIssue } from "../linear/index.ts";
import { InMemoryLinearService } from "../services/linear/index.ts";
import { SandcastleSdkService } from "../services/sandcastle/index.ts";
import type { RootRef } from "../selector/index.ts";
import type { TideConfig } from "../config-loader/index.ts";
import {
  runQueueAfterPick,
  type PrTailStepResult,
  type RunQueueAfterPickOptions,
} from "./run.ts";

interface LinearContext {
  apiKey: string;
  teamKey: string;
}

interface LegacyOpts extends Omit<
  RunQueueAfterPickOptions,
  "linear" | "sandcastle"
> {
  linearCtx?: LinearContext;
  fetchSubIssues?: (
    ctx: LinearContext,
    issueId: string,
    repoName: string
  ) => Promise<SubIssue[]>;
  transitionRootToInProgress?: (
    ctx: LinearContext,
    issueId: string
  ) => Promise<void>;
}

function legacyRunQueueAfterPick(opts: LegacyOpts): Promise<number> {
  const { linearCtx, fetchSubIssues, transitionRootToInProgress, ...rest } =
    opts;
  const ctx = linearCtx ?? { apiKey: "lk", teamKey: "ENG" };
  const linear = new InMemoryLinearService();
  Object.defineProperty(linear, "fetchSubIssues", {
    value: (id: string) =>
      fetchSubIssues?.(ctx, id, rest.ghRepo.repo) ?? Promise.resolve([]),
  });
  Object.defineProperty(linear, "transitionToInProgress", {
    value: (id: string) =>
      transitionRootToInProgress?.(ctx, id) ?? Promise.resolve(),
  });
  // The whole point of this test is the real `createWorktree` against a
  // real git repo + bridge — use the SDK-backed SandcastleService.
  const sandcastle = new SandcastleSdkService();
  return runQueueAfterPick({ ...rest, linear, sandcastle });
}

function git(repo: string, args: readonly string[]): void {
  execFileSync("git", args as string[], { cwd: repo, stdio: "ignore" });
}

function gitOut(repo: string, args: readonly string[]): string {
  return execFileSync("git", args as string[], { cwd: repo })
    .toString("utf8")
    .trim();
}

function makePRD(overrides: Partial<PRD> = {}): PRD {
  return {
    id: "uuid-eng-1",
    identifier: "ENG-1",
    title: "Example PRD",
    state: "Backlog",
    branchName: "feature/foo",
    url: "https://linear.app/eng/issue/ENG-1",
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    readyForAgentCount: 1,
    readyForHumanCount: 0,
    ...overrides,
  };
}

function prdRoot(prd: PRD): RootRef {
  return { kind: "prd", prd };
}

const baseConfig: TideConfig = {
  linear: { team: "ENG" },
  sandbox: { mounts: [] },
  hooks: { onSandboxReady: [] },
};

describe("runQueueAfterPick — feature branch checked out at main repo", () => {
  type WriteFn = typeof process.stdout.write;
  let workDir: string;
  let repoRoot: string;
  let stdoutChunks: string[];
  let originalStdoutWrite: WriteFn;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tide-feature-branch-collision-"));
    repoRoot = join(workDir, "repo");
    mkdirSync(repoRoot, { recursive: true });

    git(repoRoot, ["init", "-q", "-b", "master"]);
    git(repoRoot, ["config", "user.email", "test@example.com"]);
    git(repoRoot, ["config", "user.name", "Test"]);
    writeFileSync(join(repoRoot, "README.md"), "seed\n");
    git(repoRoot, ["add", "README.md"]);
    git(repoRoot, ["commit", "-q", "-m", "seed"]);
    git(repoRoot, ["checkout", "-q", "-b", "feature/foo"]);

    // Mirror the sandcastle bridge that `createBridgeIfMissing` would set up.
    mkdirSync(join(repoRoot, ".tide"), { recursive: true });
    symlinkSync(".tide", join(repoRoot, ".sandcastle"), "dir");

    stdoutChunks = [];
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const captureStdout: WriteFn = (chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };
    process.stdout.write = captureStdout;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    rmSync(workDir, { recursive: true, force: true });
  });

  test("silent override path: releases feature/foo from main checkout, then sandcastle creates the managed worktree", async () => {
    // Pre-condition: main checkout is on feature/foo. Sandcastle's
    // createWorktree against feature/foo would otherwise refuse with
    // "Branch 'feature/foo' is already checked out in worktree at ...".
    expect(gitOut(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      "feature/foo"
    );

    const picked = makePRD({ branchName: "feature/foo" });
    let releasePromptCalls = 0;

    const code = await legacyRunQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      // Silent override path: currentBranch === picked.branchName, so
      // `featureBranch` resolves to "feature/foo" without prompting.
      currentBranch: "feature/foo",
      // PR target prompt fires (currentBranch !== originHead); the stub
      // resolves to "master" without rendering UI.
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot,
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      promptPrTarget: () =>
        Promise.resolve({ kind: "chosen", branch: "master" }),
      confirmReleaseBranch: (input) => {
        releasePromptCalls += 1;
        expect(input.branch).toBe("feature/foo");
        expect(input.baseBranch).toBe("master");
        expect(input.repoRoot).toBe(repoRoot);
        return Promise.resolve(true);
      },
      // Real createWorktree (no stub) — this is the whole point.
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "ok",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(code).toBe(0);
    expect(releasePromptCalls).toBe(1);

    // Main checkout was switched off the feature branch.
    expect(gitOut(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      "master"
    );

    // The managed worktree exists under .tide/worktrees/ on feature/foo.
    const wtList = gitOut(repoRoot, ["worktree", "list", "--porcelain"]);
    expect(wtList).toContain("feature/foo");
    expect(wtList).toMatch(/\.tide\/worktrees\/feature-foo/);
    // Filesystem check: the worktree dir was actually materialized.
    expect(
      existsSync(join(repoRoot, ".tide", "worktrees", "feature-foo"))
    ).toBe(true);
  });

  test("override-take path: featureBranch === currentBranch (user picked their own branch), recovery still fires", async () => {
    // Picker's branchName differs from the user's current branch; the
    // override prompt fires and the user picks `current`. Result:
    // featureBranch = currentBranch = "feature/foo", same collision.
    const picked = makePRD({ branchName: "user/some/other-branch" });

    const code = await legacyRunQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "feature/foo",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot,
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      promptBranchOverride: (input) =>
        Promise.resolve({ kind: "chosen", branch: input.currentBranch }),
      promptPrTarget: () =>
        Promise.resolve({ kind: "chosen", branch: "master" }),
      confirmReleaseBranch: () => Promise.resolve(true),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "ok",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(code).toBe(0);
    expect(gitOut(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      "master"
    );
    const wtList = gitOut(repoRoot, ["worktree", "list", "--porcelain"]);
    expect(wtList).toContain("feature/foo");
    expect(wtList).toMatch(/\.tide\/worktrees\/feature-foo/);
  });
});
