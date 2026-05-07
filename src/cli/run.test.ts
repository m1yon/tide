import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateWorktreeOptions, Worktree } from "@ai-hero/sandcastle";
import type {
  BranchOverrideOutcome,
  PromptBranchOverrideInput,
} from "../branch-override/index.ts";
import type {
  PromptPrTargetInput,
  PrTargetOutcome,
} from "../pr-target/index.ts";
import {
  buildOrderedQueue,
  runPrTailStep,
  runQueueAfterPick,
  tideRun,
  type PrTailStepResult,
  type RunPrTailStepOptions,
} from "./run.ts";
import type { BuildOptions } from "./build.ts";
import type { GhIdentity } from "../gh-identity/index.ts";
import type {
  LinearContext,
  PRD,
  StandaloneIssue,
  SubIssue,
} from "../linear/index.ts";
import type {
  PrSubmissionResult,
  ShellResult,
  ShellRunner,
} from "../pr-submission/index.ts";
import type { RootRef } from "../selector/index.ts";
import type { TideConfig } from "../config-loader/index.ts";

/**
 * Stub the `sandcastle.createWorktree(...)` test seam used by
 * `runQueueAfterPick`. The returned `Worktree` shape only carries the
 * fields the runner consumes (`branch`, `worktreePath`); the lifecycle
 * methods are present to satisfy the type but are never reached because
 * tide never calls them.
 */
function makeCreateWorktreeStub(
  worktreePath = "/repo/.tide/worktrees/feature"
): (opts: CreateWorktreeOptions) => Promise<Worktree> {
  return () =>
    Promise.resolve({
      branch: "feature",
      worktreePath,
      run: () => Promise.reject(new Error("worktree.run not stubbed")),
      interactive: () =>
        Promise.reject(new Error("worktree.interactive not stubbed")),
      createSandbox: () =>
        Promise.reject(new Error("worktree.createSandbox not stubbed")),
      close: () => Promise.resolve({}),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    });
}

/**
 * No-op stubs for the feature-branch-release pre-flight added after
 * PER-77's UI gap was fixed. Tests where `featureBranch === currentBranch`
 * (silent override or override-take path) trigger the pre-flight; pass
 * these stubs to keep the prompt + git switch invisible. The pre-flight's
 * own behaviour is covered separately in the "feature-branch release
 * pre-flight" describe block (and end-to-end in
 * `run.feature-branch-collision.test.ts`).
 */
const releaseBranchNoopStubs = {
  confirmReleaseBranch: () => Promise.resolve(true),
  gitSwitch: () => Promise.resolve(),
};

/**
 * Stub the `branch-override.promptBranchOverride` test seam used by
 * `runQueueAfterPick`. Tests that don't care about the override path use
 * the default ("pick Linear's") so behaviour matches today's silent path.
 *
 *   `pick: "linear"` (default) — resolves to Linear's branch (no override)
 *   `pick: "current"`           — resolves to the user's current branch (override taken)
 *   `pick: "cancel"`            — resolves to the cancellation outcome
 */
function makePromptOverrideStub(
  options: { pick?: "linear" | "current" | "cancel" } = {}
): (input: PromptBranchOverrideInput) => Promise<BranchOverrideOutcome> {
  const pick = options.pick ?? "linear";
  return (input) => {
    if (pick === "cancel") {
      return Promise.resolve({ kind: "cancelled" });
    }
    return Promise.resolve({
      kind: "chosen",
      branch: pick === "linear" ? input.linearBranch : input.currentBranch,
    });
  };
}

/**
 * Stub the `pr-target.promptPrTarget` test seam used by `runQueueAfterPick`.
 * Tests that don't care about the PR-target path can pass `currentBranch ===
 * originHead` so the silent path fires and this stub is never invoked. Tests
 * that drive the prompt provide an explicit `branch` (e.g. the `originHead`
 * default) or `"cancel"` for the cancellation path.
 */
function makePromptPrTargetStub(
  options: { branch?: string; cancel?: boolean } = {}
): (input: PromptPrTargetInput) => Promise<PrTargetOutcome> {
  return (input) => {
    if (options.cancel === true) {
      return Promise.resolve({ kind: "cancelled" });
    }
    return Promise.resolve({
      kind: "chosen",
      branch: options.branch ?? input.defaultBranch ?? "master",
    });
  };
}

interface CallLog {
  events: string[];
}

interface BuildStub {
  exitCode: number;
  calls: BuildOptions[];
}

function makeBuild(stub: BuildStub, log: CallLog) {
  return (opts: BuildOptions): Promise<number> => {
    stub.calls.push(opts);
    log.events.push("build");
    return Promise.resolve(stub.exitCode);
  };
}

function makeGhIdentity(log: CallLog) {
  return (): Promise<GhIdentity> => {
    log.events.push("getGhIdentity");
    return Promise.resolve({ owner: "m1yon", repo: "tide" });
  };
}

function makeGhToken(log: CallLog) {
  return (): Promise<string> => {
    log.events.push("getGhToken");
    return Promise.resolve("ghp_test");
  };
}

interface ListPRDsStub {
  prds: PRD[];
  calls: LinearContext[];
  repoNames: string[];
}

function makeListPRDs(stub: ListPRDsStub, log: CallLog) {
  return (ctx: LinearContext, repoName: string): Promise<PRD[]> => {
    stub.calls.push(ctx);
    stub.repoNames.push(repoName);
    log.events.push("listPRDs");
    return Promise.resolve(stub.prds);
  };
}

interface PickRootStub {
  /** Index into the prds list to pick. Mutually exclusive with
   * `standalonePickIndex`. */
  pickIndex?: number;
  /** Index into the standaloneIssues list to pick. */
  standalonePickIndex?: number;
  calls: number;
}

function makePickRoot(stub: PickRootStub, log: CallLog) {
  return (input: {
    prds: readonly PRD[];
    standaloneIssues: readonly StandaloneIssue[];
  }): Promise<RootRef> => {
    stub.calls += 1;
    log.events.push("pickRoot");
    if (stub.standalonePickIndex !== undefined) {
      const issue = input.standaloneIssues[stub.standalonePickIndex];
      if (!issue)
        throw new Error("pickRoot stub: standalone index out of range");
      return Promise.resolve({ kind: "standalone", issue });
    }
    const idx = stub.pickIndex ?? 0;
    const prd = input.prds[idx];
    if (!prd) throw new Error("pickRoot stub: PRD index out of range");
    return Promise.resolve({ kind: "prd", prd });
  };
}

function makePRD(overrides: Partial<PRD> = {}): PRD {
  return {
    id: "uuid-eng-1",
    identifier: "ENG-1",
    title: "Example PRD",
    state: "Backlog",
    branchName: "user/feature/eng-1-example",
    url: "https://linear.app/eng/issue/ENG-1",
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    readyForAgentCount: 2,
    readyForHumanCount: 0,
    ...overrides,
  };
}

function prdRoot(prd: PRD): RootRef {
  return { kind: "prd", prd };
}

function standaloneRoot(issue: StandaloneIssue): RootRef {
  return { kind: "standalone", issue };
}

function makeStandaloneIssue(
  overrides: Partial<StandaloneIssue> = {}
): StandaloneIssue {
  return {
    id: "uuid-iss-7",
    identifier: "ENG-7",
    title: "Fix flaky export",
    state: "Backlog",
    branchName: "user/eng-7-fix-flaky-export",
    url: "https://linear.app/eng/issue/ENG-7",
    updatedAt: new Date("2026-04-10T00:00:00Z"),
    ...overrides,
  };
}

function makeSubIssue(overrides: Partial<SubIssue> = {}): SubIssue {
  return {
    id: "uuid-default",
    identifier: "ENG-100",
    title: "Default sub-issue",
    state: "Backlog",
    stateType: "backlog",
    labels: ["ready-for-agent"],
    blockedBy: [],
    ...overrides,
  };
}

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

// Stub for the host-side `git rev-parse --abbrev-ref HEAD` call that
// resolveCurrentBranch makes before any other work. Tests that don't care
// about current-branch capture use this to keep the early gate happy.
const okCurrentBranchRunner = constShellRunner({
  exitCode: 0,
  stdout: "master\n",
  stderr: "",
});

// Stub for the host-side `git rev-parse --abbrev-ref origin/HEAD` call
// resolveOriginHead makes after the current-branch capture. Defaults to
// origin/master so the smart-silent PR-target path fires for tests that
// don't care about it (currentBranch === originHead).
const okOriginHeadRunner = constShellRunner({
  exitCode: 0,
  stdout: "origin/master\n",
  stderr: "",
});

describe("tide run — early gates and Linear PRD selector", () => {
  let workDir: string;
  let repoRoot: string;
  let tideDir: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];
  const captureStdout = (s: string): void => {
    stdoutChunks.push(s);
  };
  const captureStderr = (s: string): void => {
    stderrChunks.push(s);
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tide-run-"));
    repoRoot = join(workDir, "repo");
    tideDir = join(repoRoot, ".tide");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(tideDir, { recursive: true });
    writeFileSync(
      join(tideDir, "config.ts"),
      `export default { linear: { team: "ENG" } };\n`
    );
    writeFileSync(
      join(tideDir, ".env"),
      "LINEAR_API_KEY=lk\nANTHROPIC_API_KEY=ak\n"
    );
    writeFileSync(join(tideDir, "Dockerfile"), "FROM scratch\n");
    stdoutChunks = [];
    stderrChunks = [];
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("invokes build before fetching Linear PRDs", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [], repoNames: [] };

    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      listStandaloneIssues: () => Promise.resolve([]),
      assertInReviewStatePresent: () => Promise.resolve(),
      currentBranchShellRunner: okCurrentBranchRunner,
      originHeadShellRunner: okOriginHeadRunner,
    });

    expect(code).toBe(0);
    expect(buildStub.calls).toHaveLength(1);
    expect(listStub.calls).toHaveLength(1);
    const buildIdx = log.events.indexOf("build");
    const listIdx = log.events.indexOf("listPRDs");
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(listIdx).toBeGreaterThan(buildIdx);
  });

  test("build receives the resolved repoRoot and the same stdout/stderr sinks", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [], repoNames: [] };

    await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      listStandaloneIssues: () => Promise.resolve([]),
      assertInReviewStatePresent: () => Promise.resolve(),
      currentBranchShellRunner: okCurrentBranchRunner,
      originHeadShellRunner: okOriginHeadRunner,
    });

    const call = buildStub.calls[0];
    if (call === undefined) throw new Error("missing build call");
    expect(call.repoRoot).toBe(repoRoot);
    expect(call.stdout).toBe(captureStdout);
    expect(call.stderr).toBe(captureStderr);
  });

  test("build failure short-circuits with the build's exit code; PRD fetch never runs", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 2, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [], repoNames: [] };

    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      listStandaloneIssues: () => Promise.resolve([]),
      assertInReviewStatePresent: () => Promise.resolve(),
      currentBranchShellRunner: okCurrentBranchRunner,
      originHeadShellRunner: okOriginHeadRunner,
    });

    expect(code).toBe(2);
    expect(buildStub.calls).toHaveLength(1);
    expect(listStub.calls).toHaveLength(0);
  });

  test("empty PRD and Standalone Issue lists exit cleanly without invoking the selector", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [], repoNames: [] };
    const pickStub: PickRootStub = { pickIndex: 0, calls: 0 };

    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      listStandaloneIssues: () => Promise.resolve([]),
      pickRoot: makePickRoot(pickStub, log),
      assertInReviewStatePresent: () => Promise.resolve(),
      currentBranchShellRunner: okCurrentBranchRunner,
      originHeadShellRunner: okOriginHeadRunner,
    });

    expect(code).toBe(0);
    expect(pickStub.calls).toBe(0);
  });

  test("threads the gh-identity repo name into both Linear list calls (ADR-0012)", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [], repoNames: [] };
    const standaloneRepoNames: string[] = [];

    await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      listStandaloneIssues: (_ctx, repoName) => {
        standaloneRepoNames.push(repoName);
        return Promise.resolve([]);
      },
      assertInReviewStatePresent: () => Promise.resolve(),
      currentBranchShellRunner: okCurrentBranchRunner,
      originHeadShellRunner: okOriginHeadRunner,
    });

    // makeGhIdentity returns { owner: "m1yon", repo: "tide" }; both list
    // calls must receive that exact repo name as the title-prefix scope.
    expect(listStub.repoNames).toEqual(["tide"]);
    expect(standaloneRepoNames).toEqual(["tide"]);
  });

  test("zero-result outro names the working repo and the `[<repo>] ` prefix form (ADR-0012)", async () => {
    // When neither PRDs nor Standalone Issues match the prefix, the user
    // needs to know which repo's prefix tide is filtering by, plus the two
    // recovery moves (retitle, or create via skill). An empty picker is
    // never silently confusing.
    //
    // clack's `outro` / `log.warn` write directly to `process.stdout`, not
    // to the injected `stdout` callback — intercept the real stream.
    const clackChunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      clackChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    try {
      const log: CallLog = { events: [] };
      const buildStub: BuildStub = { exitCode: 0, calls: [] };
      const listStub: ListPRDsStub = { prds: [], calls: [], repoNames: [] };

      await tideRun({
        repoRoot,
        stdout: captureStdout,
        stderr: captureStderr,
        build: makeBuild(buildStub, log),
        getGhIdentity: makeGhIdentity(log),
        getGhToken: makeGhToken(log),
        listPRDs: makeListPRDs(listStub, log),
        listStandaloneIssues: () => Promise.resolve([]),
        assertInReviewStatePresent: () => Promise.resolve(),
        currentBranchShellRunner: okCurrentBranchRunner,
        originHeadShellRunner: okOriginHeadRunner,
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    const out = clackChunks.join("");
    expect(out).toContain("tide");
    expect(out).toContain("[tide] ");
    // The two recovery moves: retitle existing issues, or create a new one
    // via the triage / to-prd / to-issues skill.
    expect(out).toMatch(/retitle/i);
    expect(out).toMatch(/triage|to-prd|to-issues/);
  });

  test("non-empty PRD list invokes pickRoot and dispatches the picked PRD to runQueueAfterPick", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = {
      prds: [
        makePRD({ identifier: "ENG-7", title: "Search rewrite" }),
        makePRD({ identifier: "ENG-8", title: "Auth migration" }),
      ],
      calls: [],
      repoNames: [],
    };
    const pickStub: PickRootStub = { pickIndex: 1, calls: 0 };
    const queueCalls: RootRef[] = [];

    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      listStandaloneIssues: () => Promise.resolve([]),
      pickRoot: makePickRoot(pickStub, log),
      runQueueAfterPick: (opts) => {
        log.events.push("runQueueAfterPick");
        queueCalls.push(opts.picked);
        return Promise.resolve(0);
      },
      assertInReviewStatePresent: () => Promise.resolve(),
      currentBranchShellRunner: okCurrentBranchRunner,
      originHeadShellRunner: okOriginHeadRunner,
    });

    expect(code).toBe(0);
    expect(pickStub.calls).toBe(1);
    expect(queueCalls).toHaveLength(1);
    const root = queueCalls[0];
    if (root?.kind !== "prd") throw new Error("expected PRD root");
    expect(root.prd.identifier).toBe("ENG-8");

    const pickIdx = log.events.indexOf("pickRoot");
    const queueIdx = log.events.indexOf("runQueueAfterPick");
    expect(pickIdx).toBeGreaterThanOrEqual(0);
    expect(queueIdx).toBeGreaterThan(pickIdx);
  });

  test("non-empty Standalone Issue list invokes pickRoot and dispatches the picked Issue", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [], repoNames: [] };
    const pickStub: PickRootStub = { standalonePickIndex: 0, calls: 0 };
    const queueCalls: RootRef[] = [];

    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      listStandaloneIssues: () =>
        Promise.resolve([
          makeStandaloneIssue({ id: "uuid-iss-7", identifier: "ENG-7" }),
        ]),
      pickRoot: makePickRoot(pickStub, log),
      runQueueAfterPick: (opts) => {
        queueCalls.push(opts.picked);
        return Promise.resolve(0);
      },
      assertInReviewStatePresent: () => Promise.resolve(),
      currentBranchShellRunner: okCurrentBranchRunner,
      originHeadShellRunner: okOriginHeadRunner,
    });

    expect(code).toBe(0);
    expect(queueCalls).toHaveLength(1);
    const root = queueCalls[0];
    if (root?.kind !== "standalone") {
      throw new Error("expected standalone root");
    }
    expect(root.issue.identifier).toBe("ENG-7");
  });

  test("listPRDs receives the LINEAR_API_KEY and team key from config", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [], repoNames: [] };

    await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      listStandaloneIssues: () => Promise.resolve([]),
      assertInReviewStatePresent: () => Promise.resolve(),
      currentBranchShellRunner: okCurrentBranchRunner,
      originHeadShellRunner: okOriginHeadRunner,
    });

    expect(listStub.calls[0]?.apiKey).toBe("lk");
    expect(listStub.calls[0]?.teamKey).toBe("ENG");
  });

  test("LINEAR_API_KEY is not forwarded into the sandbox (it stays host-side)", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [], repoNames: [] };

    // We can't observe the sandbox env directly here (the queue path is out
    // of scope for this slice). The narrower assertion: tideRun does not
    // error out on the LINEAR_API_KEY being absent from sandboxEnv.
    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      listStandaloneIssues: () => Promise.resolve([]),
      assertInReviewStatePresent: () => Promise.resolve(),
      currentBranchShellRunner: okCurrentBranchRunner,
      originHeadShellRunner: okOriginHeadRunner,
    });

    expect(code).toBe(0);
  });

  test("build runs after gh-identity is resolved", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [], repoNames: [] };

    await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      listStandaloneIssues: () => Promise.resolve([]),
      assertInReviewStatePresent: () => Promise.resolve(),
      currentBranchShellRunner: okCurrentBranchRunner,
      originHeadShellRunner: okOriginHeadRunner,
    });

    const ghIdx = log.events.indexOf("getGhIdentity");
    const buildIdx = log.events.indexOf("build");
    expect(ghIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(ghIdx);
  });

  test("getGhToken runs after gh-identity and before docker build", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [], repoNames: [] };

    await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: () => {
        log.events.push("getGhToken");
        return Promise.resolve("ghp_test");
      },
      listPRDs: makeListPRDs(listStub, log),
      listStandaloneIssues: () => Promise.resolve([]),
      assertInReviewStatePresent: () => Promise.resolve(),
      currentBranchShellRunner: okCurrentBranchRunner,
      originHeadShellRunner: okOriginHeadRunner,
    });

    const ghIdx = log.events.indexOf("getGhIdentity");
    const tokenIdx = log.events.indexOf("getGhToken");
    const buildIdx = log.events.indexOf("build");
    expect(ghIdx).toBeGreaterThanOrEqual(0);
    expect(tokenIdx).toBeGreaterThan(ghIdx);
    expect(buildIdx).toBeGreaterThan(tokenIdx);
  });

  test("getGhToken failure short-circuits before build", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [], repoNames: [] };

    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: () =>
        Promise.reject(
          new Error("tide: `gh auth token` failed. Run `gh auth login`")
        ),
      listPRDs: makeListPRDs(listStub, log),
      listStandaloneIssues: () => Promise.resolve([]),
      assertInReviewStatePresent: () => Promise.resolve(),
      currentBranchShellRunner: okCurrentBranchRunner,
      originHeadShellRunner: okOriginHeadRunner,
    });

    expect(code).toBe(1);
    expect(buildStub.calls).toHaveLength(0);
    expect(listStub.calls).toHaveLength(0);
    expect(stderrChunks.join("")).toContain("gh auth login");
  });

  test("Linear fetch failure surfaces a clear error and non-zero exit", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listPRDs = (): Promise<PRD[]> =>
      Promise.reject(new Error("Linear API key invalid"));

    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs,
      listStandaloneIssues: () => Promise.resolve([]),
      assertInReviewStatePresent: () => Promise.resolve(),
      currentBranchShellRunner: okCurrentBranchRunner,
      originHeadShellRunner: okOriginHeadRunner,
    });

    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("Linear API key invalid");
  });

  test("preflight refuses to start when `In Review` is missing — fails before build, gh, or Linear fetch", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [], repoNames: [] };
    let ghIdentityCalls = 0;
    let ghTokenCalls = 0;

    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: () => {
        ghIdentityCalls += 1;
        return Promise.resolve({ owner: "m1yon", repo: "tide" });
      },
      getGhToken: () => {
        ghTokenCalls += 1;
        return Promise.resolve("ghp_test");
      },
      listPRDs: makeListPRDs(listStub, log),
      listStandaloneIssues: () => Promise.resolve([]),
      assertInReviewStatePresent: () =>
        Promise.reject(
          new Error(
            'Linear team "ENG" has no `started`-type workflow state named "In Review". Run `tide setup` to provision it.'
          )
        ),
      currentBranchShellRunner: okCurrentBranchRunner,
      originHeadShellRunner: okOriginHeadRunner,
    });

    expect(code).toBe(1);
    // No further work attempted — preflight short-circuits before build,
    // gh-identity/token resolution, and the Linear PRD fetch.
    expect(buildStub.calls).toHaveLength(0);
    expect(ghIdentityCalls).toBe(0);
    expect(ghTokenCalls).toBe(0);
    expect(listStub.calls).toHaveLength(0);
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("In Review");
    expect(stderr).toContain("tide setup");
  });

  test("preflight receives the LINEAR_API_KEY and team key from config", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [], repoNames: [] };
    const calls: { apiKey: string; teamKey: string }[] = [];

    await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      listStandaloneIssues: () => Promise.resolve([]),
      assertInReviewStatePresent: (ctx) => {
        calls.push({ apiKey: ctx.apiKey, teamKey: ctx.teamKey });
        return Promise.resolve();
      },
      currentBranchShellRunner: okCurrentBranchRunner,
      originHeadShellRunner: okOriginHeadRunner,
    });

    expect(calls).toEqual([{ apiKey: "lk", teamKey: "ENG" }]);
  });
});

describe("tideRun current-branch capture", () => {
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
      currentBranchShellRunner: constShellRunner({
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
      currentBranchShellRunner: constShellRunner({
        exitCode: 128,
        stdout: "",
        stderr: "fatal: not a git repository",
      }),
    });

    expect(code).toBe(1);
    expect(sinks.stderr.join("")).toContain("git rev-parse");
  });

  test("origin/HEAD-unset (non-zero exit) is non-fatal: tideRun proceeds", async () => {
    // Per ADR-0016: origin/HEAD-unset is a legal repo state (older clones,
    // certain CI setups, `git remote add origin` without a subsequent
    // `git remote set-head`). The capture must not fail the run — the
    // PR-target prompt fires unconditionally with no default later.
    const sinks = makeSinks();
    writeFileSync(
      join(repoRoot, ".tide", "config.ts"),
      `export default { linear: { team: "ENG" } };\n`
    );
    writeFileSync(
      join(repoRoot, ".tide", ".env"),
      "LINEAR_API_KEY=lk\nANTHROPIC_API_KEY=ak\n"
    );
    writeFileSync(join(repoRoot, ".tide", "Dockerfile"), "FROM scratch\n");

    const code = await tideRun({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      build: () => Promise.resolve(0),
      getGhIdentity: () => Promise.resolve({ owner: "m1yon", repo: "tide" }),
      getGhToken: () => Promise.resolve("ghp_test"),
      listPRDs: () => Promise.resolve([]),
      listStandaloneIssues: () => Promise.resolve([]),
      assertInReviewStatePresent: () => Promise.resolve(),
      currentBranchShellRunner: okCurrentBranchRunner,
      // origin/HEAD unset → resolveOriginHead returns undefined; no throw.
      originHeadShellRunner: constShellRunner({
        exitCode: 128,
        stdout: "",
        stderr: "fatal: ambiguous argument 'origin/HEAD'",
      }),
    });

    // Empty PRD/Standalone lists exit cleanly (the test's gate is that the
    // origin/HEAD failure didn't abort the run).
    expect(code).toBe(0);
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
    rootIdentifier: "MEC-123",
    rootTitle: "PRD: example feature",
    rootUrl: "https://linear.app/acme/issue/MEC-123",
    subIssues: [{ number: 8, title: "Foundation tracer" }],
    repoRoot: "/repo",
    featureWorktreePath: "/repo/.tide/worktrees/feature-per-32",
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

describe("buildOrderedQueue", () => {
  test("returns a queue with `ready-for-agent` direct children topo-sorted by blockedBy", () => {
    const subs: SubIssue[] = [
      makeSubIssue({
        id: "uuid-2",
        identifier: "ENG-2",
        title: "Second",
        blockedBy: ["ENG-1"],
      }),
      makeSubIssue({
        id: "uuid-1",
        identifier: "ENG-1",
        title: "First",
        blockedBy: [],
      }),
      makeSubIssue({
        id: "uuid-3",
        identifier: "ENG-3",
        title: "Third",
        blockedBy: ["ENG-2"],
      }),
    ];
    const r = buildOrderedQueue(subs);
    expect(r.kind).toBe("queue");
    if (r.kind === "queue") {
      expect(r.ordered.map((o) => o.identifier)).toEqual([
        "ENG-1",
        "ENG-2",
        "ENG-3",
      ]);
      // The internal UUID is preserved on each ordered entry so the runner
      // can fetch content by id without re-resolving.
      expect(r.ordered.map((o) => o.id)).toEqual([
        "uuid-1",
        "uuid-2",
        "uuid-3",
      ]);
    }
  });

  test("filters out direct children that lack the `ready-for-agent` label", () => {
    const subs: SubIssue[] = [
      makeSubIssue({
        id: "uuid-1",
        identifier: "ENG-1",
        labels: ["ready-for-agent"],
      }),
      makeSubIssue({
        id: "uuid-h",
        identifier: "ENG-2",
        labels: ["ready-for-human"],
      }),
      makeSubIssue({
        id: "uuid-u",
        identifier: "ENG-3",
        labels: [],
      }),
    ];
    const r = buildOrderedQueue(subs);
    expect(r.kind).toBe("queue");
    if (r.kind === "queue") {
      expect(r.ordered.map((o) => o.identifier)).toEqual(["ENG-1"]);
    }
  });

  test("returns standalone when no direct children carry `ready-for-agent`", () => {
    const subs: SubIssue[] = [
      makeSubIssue({
        identifier: "ENG-X",
        labels: ["ready-for-human"],
      }),
    ];
    const r = buildOrderedQueue(subs);
    expect(r.kind).toBe("standalone");
  });

  test("returns standalone when there are zero direct children at all", () => {
    const r = buildOrderedQueue([]);
    expect(r.kind).toBe("standalone");
  });

  test("treats terminal-state direct-child blockers as satisfied", () => {
    // ENG-2 (in scope) is blocked by ENG-1 (a direct child of the PRD that
    // has been completed). The queue should run ENG-2 anyway.
    const subs: SubIssue[] = [
      makeSubIssue({
        identifier: "ENG-1",
        labels: [],
        stateType: "completed",
      }),
      makeSubIssue({
        identifier: "ENG-2",
        labels: ["ready-for-agent"],
        blockedBy: ["ENG-1"],
      }),
    ];
    const r = buildOrderedQueue(subs);
    expect(r.kind).toBe("queue");
    if (r.kind === "queue") {
      expect(r.ordered.map((o) => o.identifier)).toEqual(["ENG-2"]);
    }
  });

  test("errors with the cross-PRD message shape when blockedBy is outside the picked PRD's children", () => {
    // ENG-2 (in scope) is blocked by ENG-99, which is not a direct child of
    // the picked PRD. The queue should refuse to run with an error message
    // mirroring the GitHub-path's "outside the selected parent's subtree"
    // wording.
    const subs: SubIssue[] = [
      makeSubIssue({
        identifier: "ENG-2",
        labels: ["ready-for-agent"],
        blockedBy: ["ENG-99"],
      }),
    ];
    const r = buildOrderedQueue(subs);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain("ENG-2");
      expect(r.message).toContain("ENG-99");
      expect(r.message).toContain("outside the picked PRD's children");
      expect(r.message).toContain("Resolve");
    }
  });

  test("errors with a ready-for-human-direct-child shape when the blocker is a direct child flagged for humans", () => {
    // ENG-2 (in scope) is blocked by ENG-1, which IS a direct child of the
    // picked PRD but carries `ready-for-human` (typically the residue of a
    // previous run's flip). The error must point at the actual fix
    // (re-label / remove relationship) instead of mis-claiming the blocker
    // is outside the PRD.
    const subs: SubIssue[] = [
      makeSubIssue({
        identifier: "ENG-1",
        labels: ["ready-for-human"],
      }),
      makeSubIssue({
        identifier: "ENG-2",
        labels: ["ready-for-agent"],
        blockedBy: ["ENG-1"],
      }),
    ];
    const r = buildOrderedQueue(subs);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain("ENG-2");
      expect(r.message).toContain("ENG-1");
      expect(r.message).toContain("direct child");
      expect(r.message).toContain("ready-for-human");
      expect(r.message).not.toContain("outside the picked PRD's children");
    }
  });

  test("errors with an unlabeled-direct-child shape when the blocker is a direct child missing ready-for-agent", () => {
    // Same as above, but the blocker has no `ready-for-human` label either —
    // it's just unlabeled (paused). The error should still surface the fact
    // that it's a direct child rather than claiming it's outside the PRD.
    const subs: SubIssue[] = [
      makeSubIssue({
        identifier: "ENG-1",
        labels: [],
      }),
      makeSubIssue({
        identifier: "ENG-2",
        labels: ["ready-for-agent"],
        blockedBy: ["ENG-1"],
      }),
    ];
    const r = buildOrderedQueue(subs);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain("ENG-1");
      expect(r.message).toContain("direct child");
      expect(r.message).toContain("ready-for-agent");
      expect(r.message).not.toContain("outside the picked PRD's children");
    }
  });

  test("errors with a cycle message when scoped sub-issues form a cycle", () => {
    const subs: SubIssue[] = [
      makeSubIssue({
        identifier: "ENG-1",
        labels: ["ready-for-agent"],
        blockedBy: ["ENG-2"],
      }),
      makeSubIssue({
        identifier: "ENG-2",
        labels: ["ready-for-agent"],
        blockedBy: ["ENG-1"],
      }),
    ];
    const r = buildOrderedQueue(subs);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain("cycle");
      expect(r.message).toMatch(/ENG-1.*ENG-2|ENG-2.*ENG-1/s);
    }
  });

  test("excludes sub-issues already in a terminal state from the queue", () => {
    const subs: SubIssue[] = [
      makeSubIssue({
        identifier: "ENG-1",
        labels: ["ready-for-agent"],
        stateType: "completed",
      }),
      makeSubIssue({
        identifier: "ENG-2",
        labels: ["ready-for-agent"],
      }),
    ];
    const r = buildOrderedQueue(subs);
    expect(r.kind).toBe("queue");
    if (r.kind === "queue") {
      expect(r.ordered.map((o) => o.identifier)).toEqual(["ENG-2"]);
    }
  });
});

describe("runQueueAfterPick — pre-flight gate removal + Branch override", () => {
  type WriteFn = typeof process.stdout.write;
  let stdoutChunks: string[];
  let originalStdoutWrite: WriteFn;

  const baseConfig: TideConfig = {
    linear: { team: "ENG" },
    sandbox: { mounts: [] },
    hooks: { onSandboxReady: [] },
  };

  beforeEach(() => {
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
  });

  test("does not error out when invoked from the picked PRD's feature branch (gate removed)", async () => {
    // PER-80: today's `branchName === baseBranch → error` gate is removed.
    // The Branch override path makes "running from the feature branch" a
    // legitimate state — the silent override fires instead and the run
    // proceeds with Linear's branch as the Feature worktree's branch.
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7-search",
    });

    let fetchSubIssuesCalls = 0;
    let promptCalls = 0;

    await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      // currentBranch matches the PRD's branchName — under today's rules
      // this would have errored out before the picker. The Branch override
      // turns this into a silent-no-prompt success path. originHead is set
      // to the same value so the PR-target prompt is also silent (this
      // test's contract: no prompt fires).
      currentBranch: "user/feature/eng-7-search",
      originHead: "user/feature/eng-7-search",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      ...releaseBranchNoopStubs,
      fetchSubIssues: () => {
        fetchSubIssuesCalls += 1;
        return Promise.resolve([]);
      },
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: () => {
        promptCalls += 1;
        return Promise.resolve({
          kind: "chosen",
          branch: "should-not-be-prompted",
        });
      },
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    // No early-error abort: fetchSubIssues is reached.
    expect(fetchSubIssuesCalls).toBe(1);
    // Silent path — no override prompt fires when current === Linear.
    expect(promptCalls).toBe(0);
    // The legacy gate's error message must not appear anywhere.
    const out = stdoutChunks.join("");
    expect(out).not.toContain("must be invoked from the base branch");
  });

  test("silent path: current === Linear's branch — no prompt fires, Linear's branch is used", async () => {
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    let promptCalls = 0;
    let capturedFeatureBranch: string | undefined;

    await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "user/feature/eng-7",
      originHead: "user/feature/eng-7",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      ...releaseBranchNoopStubs,
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: () => {
        promptCalls += 1;
        return Promise.resolve({ kind: "chosen", branch: "anything" });
      },
      runIssueQueue: (opts) => {
        capturedFeatureBranch = opts.branch;
        return Promise.resolve({ completed: 1, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(promptCalls).toBe(0);
    expect(capturedFeatureBranch).toBe("user/feature/eng-7");
  });

  test("prompt path picks Linear: chosen branch threads through to runIssueQueue and createWorktree", async () => {
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    let promptCalls = 0;
    let promptedWith: PromptBranchOverrideInput | undefined;
    let capturedFeatureBranch: string | undefined;
    const createCalls: CreateWorktreeOptions[] = [];

    await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "main",
      originHead: "main",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: (opts) => {
        createCalls.push(opts);
        return Promise.resolve({
          branch: "user/feature/eng-7",
          worktreePath: "/repo/.tide/worktrees/eng-7",
          run: () => Promise.reject(new Error("not used")),
          interactive: () => Promise.reject(new Error("not used")),
          createSandbox: () => Promise.reject(new Error("not used")),
          close: () => Promise.resolve({}),
          [Symbol.asyncDispose]: () => Promise.resolve(),
        });
      },
      promptBranchOverride: (input) => {
        promptCalls += 1;
        promptedWith = input;
        return Promise.resolve({ kind: "chosen", branch: input.linearBranch });
      },
      runIssueQueue: (opts) => {
        capturedFeatureBranch = opts.branch;
        return Promise.resolve({ completed: 1, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(promptCalls).toBe(1);
    expect(promptedWith).toEqual({
      linearBranch: "user/feature/eng-7",
      currentBranch: "main",
    });
    expect(capturedFeatureBranch).toBe("user/feature/eng-7");
    // createWorktree forks Linear's branch from the user's invoked-from base.
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.branchStrategy).toEqual({
      type: "branch",
      branch: "user/feature/eng-7",
      baseBranch: "main",
    });
  });

  test("prompt path picks current: chosen feature branch threads through; createWorktree's baseBranch is the resolved PR target (originHead), not the user's current branch", async () => {
    // Per ADR-0016: featureBranch and baseBranch are now independent
    // captures. The user's hand-named WIP branch (currentBranch) becomes
    // the Feature worktree's branch via the override; the PR target
    // resolves to `origin/HEAD` (here "master") via the smart-silent /
    // user-confirmed PR-target step. createWorktree's baseBranch is the
    // PR target, not the user's HEAD — the conflated single-capture model
    // (which produced `featureBranch === baseBranch`) is the bug ADR-0016
    // fixes.
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    let capturedFeatureBranch: string | undefined;
    const createCalls: CreateWorktreeOptions[] = [];

    await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "user/wip-experiment",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      ...releaseBranchNoopStubs,
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: (opts) => {
        createCalls.push(opts);
        return Promise.resolve({
          branch:
            opts.branchStrategy.type === "branch"
              ? opts.branchStrategy.branch
              : "x",
          worktreePath: "/repo/.tide/worktrees/wip",
          run: () => Promise.reject(new Error("not used")),
          interactive: () => Promise.reject(new Error("not used")),
          createSandbox: () => Promise.reject(new Error("not used")),
          close: () => Promise.resolve({}),
          [Symbol.asyncDispose]: () => Promise.resolve(),
        });
      },
      promptBranchOverride: (input) =>
        Promise.resolve({ kind: "chosen", branch: input.currentBranch }),
      promptPrTarget: makePromptPrTargetStub(),
      runIssueQueue: (opts) => {
        capturedFeatureBranch = opts.branch;
        return Promise.resolve({ completed: 1, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(capturedFeatureBranch).toBe("user/wip-experiment");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.branchStrategy).toEqual({
      type: "branch",
      branch: "user/wip-experiment",
      baseBranch: "master",
    });
  });

  test("prompt cancellation: clean exit before any Linear write or sandbox launch", async () => {
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    let fetchSubIssuesCalls = 0;
    let createCalls = 0;
    let runIssueQueueCalls = 0;
    let transitionCalls = 0;

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "main",
      originHead: "main",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => {
        fetchSubIssuesCalls += 1;
        return Promise.resolve([] as SubIssue[]);
      },
      createWorktree: () => {
        createCalls += 1;
        return Promise.reject(new Error("should not be reached"));
      },
      promptBranchOverride: makePromptOverrideStub({ pick: "cancel" }),
      runIssueQueue: () => {
        runIssueQueueCalls += 1;
        return Promise.resolve({ completed: 0, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => {
        transitionCalls += 1;
        return Promise.resolve();
      },
    });

    expect(code).toBe(0);
    expect(fetchSubIssuesCalls).toBe(0);
    expect(createCalls).toBe(0);
    expect(runIssueQueueCalls).toBe(0);
    expect(transitionCalls).toBe(0);
  });

  test("fetchSubIssues receives ghRepo.repo as the title-prefix scope (ADR-0012)", async () => {
    // The PRD-root path threads the working repo's GitHub name through to
    // every Sub-issue fetch — the rebuild call site at every iteration
    // boundary delegates to the runner, which carries the same `repoName`
    // it received here.
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7-search",
    });

    const fetchCalls: { issueId: string; repoName: string }[] = [];

    await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: (_ctx, issueId, repoName) => {
        fetchCalls.push({ issueId, repoName });
        return Promise.resolve([]);
      },
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 0, flipped: 0, processed: [] }),
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.repoName).toBe("widget");
  });

  test("Standalone Issue children-validation fetch also receives ghRepo.repo", async () => {
    // The Standalone-Issue "no Linear children" check uses the same
    // fetchSubIssues seam — apply the prefix filter uniformly.
    const issue = makeStandaloneIssue({
      identifier: "ENG-7",
      branchName: "user/eng-7",
    });

    const fetchCalls: { issueId: string; repoName: string }[] = [];

    await runQueueAfterPick({
      picked: standaloneRoot(issue),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: (_ctx, issueId, repoName) => {
        fetchCalls.push({ issueId, repoName });
        return Promise.resolve([]);
      },
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.repoName).toBe("widget");
  });
});

describe("runQueueAfterPick — PR target branch (ADR-0016)", () => {
  type WriteFn = typeof process.stdout.write;
  let stdoutChunks: string[];
  let originalStdoutWrite: WriteFn;

  const baseConfig: TideConfig = {
    linear: { team: "ENG" },
    sandbox: { mounts: [] },
    hooks: { onSandboxReady: [] },
  };

  beforeEach(() => {
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
  });

  test("silent path: currentBranch === originHead — PR-target prompt does not fire", async () => {
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    let prTargetPromptCalls = 0;
    let capturedBaseBranch: string | undefined;
    const createCalls: CreateWorktreeOptions[] = [];

    await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: (opts) => {
        createCalls.push(opts);
        return Promise.resolve({
          branch: "user/feature/eng-7",
          worktreePath: "/repo/.tide/worktrees/feature-eng-7",
          run: () => Promise.reject(new Error("not used")),
          interactive: () => Promise.reject(new Error("not used")),
          createSandbox: () => Promise.reject(new Error("not used")),
          close: () => Promise.resolve({}),
          [Symbol.asyncDispose]: () => Promise.resolve(),
        });
      },
      promptBranchOverride: makePromptOverrideStub(),
      promptPrTarget: () => {
        prTargetPromptCalls += 1;
        return Promise.resolve({ kind: "chosen", branch: "x" });
      },
      runIssueQueue: (opts) => {
        capturedBaseBranch = opts.baseBranch;
        return Promise.resolve({ completed: 1, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(prTargetPromptCalls).toBe(0);
    // Silent path resolves baseBranch to origin/HEAD.
    expect(capturedBaseBranch).toBe("master");
    expect(createCalls[0]?.branchStrategy).toEqual({
      type: "branch",
      branch: "user/feature/eng-7",
      baseBranch: "master",
    });
  });

  test("prompt path: currentBranch !== originHead — PR-target prompt fires with originHead as default", async () => {
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    let promptedWith: PromptPrTargetInput | undefined;
    let capturedBaseBranch: string | undefined;

    await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "user/wip-experiment",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      ...releaseBranchNoopStubs,
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub({ pick: "current" }),
      promptPrTarget: (input) => {
        promptedWith = input;
        return Promise.resolve({
          kind: "chosen",
          branch: input.defaultBranch ?? "fallback",
        });
      },
      runIssueQueue: (opts) => {
        capturedBaseBranch = opts.baseBranch;
        return Promise.resolve({ completed: 1, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(promptedWith).toEqual({
      defaultBranch: "master",
      repoRoot: "/repo",
    });
    expect(capturedBaseBranch).toBe("master");
  });

  test("prompt path: origin/HEAD unset — prompt fires with no default; user-typed value threads through", async () => {
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    let promptedWith: PromptPrTargetInput | undefined;
    let capturedBaseBranch: string | undefined;

    await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "user/wip-experiment",
      originHead: undefined,
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      ...releaseBranchNoopStubs,
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub({ pick: "current" }),
      promptPrTarget: (input) => {
        promptedWith = input;
        return Promise.resolve({ kind: "chosen", branch: "dev" });
      },
      runIssueQueue: (opts) => {
        capturedBaseBranch = opts.baseBranch;
        return Promise.resolve({ completed: 1, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(promptedWith).toEqual({
      defaultBranch: undefined,
      repoRoot: "/repo",
    });
    expect(capturedBaseBranch).toBe("dev");
  });

  test("PR-target prompt cancellation: clean exit before any Linear write or sandbox launch", async () => {
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    let createCalls = 0;
    let runIssueQueueCalls = 0;
    let transitionCalls = 0;

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "user/wip-experiment",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: () => {
        createCalls += 1;
        return Promise.reject(new Error("should not be reached"));
      },
      promptBranchOverride: makePromptOverrideStub({ pick: "current" }),
      promptPrTarget: makePromptPrTargetStub({ cancel: true }),
      runIssueQueue: () => {
        runIssueQueueCalls += 1;
        return Promise.resolve({ completed: 0, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => {
        transitionCalls += 1;
        return Promise.resolve();
      },
    });

    expect(code).toBe(0);
    expect(createCalls).toBe(0);
    expect(runIssueQueueCalls).toBe(0);
    expect(transitionCalls).toBe(0);
  });

  test("PR-target threads through to runPrTailStep's baseBranch", async () => {
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    let capturedTailBaseBranch: string | undefined;

    await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "user/wip-experiment",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      ...releaseBranchNoopStubs,
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub({ pick: "current" }),
      promptPrTarget: makePromptPrTargetStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: (opts) => {
        capturedTailBaseBranch = opts.baseBranch;
        return Promise.resolve({
          outcome: { kind: "opened", url: "https://example/pr/1" },
          outroMessage: "ok",
          exitCode: 0,
        } satisfies PrTailStepResult);
      },
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: () => Promise.resolve(),
    });

    expect(capturedTailBaseBranch).toBe("master");
  });
});

describe("runQueueAfterPick — PRD In Progress transition", () => {
  type WriteFn = typeof process.stdout.write;
  let stdoutChunks: string[];
  let originalStdoutWrite: WriteFn;

  const baseConfig: TideConfig = {
    linear: { team: "ENG" },
    sandbox: { mounts: [] },
    hooks: { onSandboxReady: [] },
  };

  beforeEach(() => {
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
  });

  test("transitions the PRD to In Progress after both confirms before the queue runs", async () => {
    const picked = makePRD({ id: "uuid-eng-7", identifier: "ENG-7" });

    const events: string[] = [];
    const transitionCalls: { ctx: LinearContext; issueId: string }[] = [];

    await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => {
        events.push("fetchSubIssues");
        return Promise.resolve([] as SubIssue[]);
      },
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () => {
        events.push("runIssueQueue");
        return Promise.resolve({ completed: 1, flipped: 0, processed: [] });
      },
      runPrTailStep: () => {
        events.push("runPrTailStep");
        return Promise.resolve({
          outcome: { kind: "opened", url: "https://example/pr/1" },
          outroMessage: "ok",
          exitCode: 0,
        } satisfies PrTailStepResult);
      },
      confirmRun: () => {
        events.push("confirmRun");
        return Promise.resolve(true);
      },
      confirmPr: () => {
        events.push("confirmPr");
        return Promise.resolve(true);
      },
      transitionRootToInProgress: (ctx, issueId) => {
        events.push("transitionRootToInProgress");
        transitionCalls.push({ ctx, issueId });
        return Promise.resolve();
      },
    });

    expect(transitionCalls).toHaveLength(1);
    expect(transitionCalls[0]?.issueId).toBe("uuid-eng-7");
    // Order: confirms run first, THEN PRD transitions, THEN queue starts.
    const tIdx = events.indexOf("transitionRootToInProgress");
    const cRunIdx = events.indexOf("confirmRun");
    const cPrIdx = events.indexOf("confirmPr");
    const qIdx = events.indexOf("runIssueQueue");
    expect(cRunIdx).toBeGreaterThanOrEqual(0);
    expect(cPrIdx).toBeGreaterThan(cRunIdx);
    expect(tIdx).toBeGreaterThan(cPrIdx);
    expect(qIdx).toBeGreaterThan(tIdx);
  });

  test("does not transition the PRD when the user cancels at the run confirm", async () => {
    const picked = makePRD({ id: "uuid-eng-7", identifier: "ENG-7" });
    let transitionCalls = 0;
    let runIssueQueueCalls = 0;

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () => {
        runIssueQueueCalls += 1;
        return Promise.resolve({ completed: 0, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(false),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => {
        transitionCalls += 1;
        return Promise.resolve();
      },
    });

    expect(code).toBe(0);
    expect(transitionCalls).toBe(0);
    expect(runIssueQueueCalls).toBe(0);
  });

  test("aborts cleanly when the PRD transition fails (no queue run)", async () => {
    const picked = makePRD({ id: "uuid-eng-7", identifier: "ENG-7" });
    let runIssueQueueCalls = 0;

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () => {
        runIssueQueueCalls += 1;
        return Promise.resolve({ completed: 0, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () =>
        Promise.reject(new Error("Linear API key invalid")),
    });

    expect(code).toBe(1);
    expect(runIssueQueueCalls).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toContain("Failed to transition PRD to In Progress");
    expect(out).toContain("Linear API key invalid");
  });

  test("forwards baseBranch through to runIssueQueue", async () => {
    const picked = makePRD({
      id: "uuid-eng-7",
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    let capturedBaseBranch: string | undefined;

    await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "main",
      originHead: "main",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: (opts) => {
        capturedBaseBranch = opts.baseBranch;
        return Promise.resolve({ completed: 1, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(capturedBaseBranch).toBe("main");
  });
});

describe("runQueueAfterPick — Feature worktree creation", () => {
  type WriteFn = typeof process.stdout.write;
  let stdoutChunks: string[];
  let originalStdoutWrite: WriteFn;

  const baseConfig: TideConfig = {
    linear: { team: "ENG" },
    sandbox: { mounts: [] },
    hooks: { onSandboxReady: [] },
  };

  beforeEach(() => {
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
  });

  test("creates the Feature worktree once on the picked branch and threads worktreePath into runIssueQueue", async () => {
    const picked = makePRD({
      id: "uuid-eng-7",
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    const createCalls: CreateWorktreeOptions[] = [];
    let capturedFeaturePath: string | undefined;
    let capturedTailFeaturePath: string | undefined;

    await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "main",
      originHead: "main",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: (opts) => {
        createCalls.push(opts);
        return Promise.resolve({
          branch: "user/feature/eng-7",
          worktreePath: "/repo/.tide/worktrees/feature-eng-7",
          run: () => Promise.reject(new Error("not used")),
          interactive: () => Promise.reject(new Error("not used")),
          createSandbox: () => Promise.reject(new Error("not used")),
          close: () => Promise.resolve({}),
          [Symbol.asyncDispose]: () => Promise.resolve(),
        });
      },
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: (opts) => {
        capturedFeaturePath = opts.featureWorktreePath;
        return Promise.resolve({ completed: 1, flipped: 0, processed: [] });
      },
      runPrTailStep: (opts) => {
        capturedTailFeaturePath = opts.featureWorktreePath;
        return Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult);
      },
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(createCalls).toHaveLength(1);
    const opts = createCalls[0];
    if (!opts) throw new Error("unreachable");
    // 'branch' strategy on the picked root's auto-generated branchName,
    // forking from the user's invoked-from base branch.
    expect(opts.branchStrategy).toEqual({
      type: "branch",
      branch: "user/feature/eng-7",
      baseBranch: "main",
    });
    expect(opts.cwd).toBe("/repo");
    // The handle's worktreePath is the value runIssueQueue receives.
    expect(capturedFeaturePath).toBe("/repo/.tide/worktrees/feature-eng-7");
    // The same worktreePath flows into the PR-tail step so the PR-submission
    // iteration runs inside the Feature worktree under `head` strategy.
    expect(capturedTailFeaturePath).toBe("/repo/.tide/worktrees/feature-eng-7");
  });

  test("aborts cleanly when createWorktree fails (no queue run)", async () => {
    const picked = makePRD({
      id: "uuid-eng-7",
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });
    let runIssueQueueCalls = 0;

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "main",
      originHead: "main",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: () =>
        Promise.reject(new Error("worktree creation rejected")),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () => {
        runIssueQueueCalls += 1;
        return Promise.resolve({ completed: 0, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(code).toBe(1);
    expect(runIssueQueueCalls).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toContain("Feature worktree");
    expect(out).toContain("worktree creation rejected");
  });
});

describe("runQueueAfterPick — feature-branch release pre-flight", () => {
  type WriteFn = typeof process.stdout.write;
  let stdoutChunks: string[];
  let originalStdoutWrite: WriteFn;

  const baseConfig: TideConfig = {
    linear: { team: "ENG" },
    sandbox: { mounts: [] },
    hooks: { onSandboxReady: [] },
  };

  beforeEach(() => {
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
  });

  test("does not fire on override-not-taken path (currentBranch !== featureBranch)", async () => {
    // User picks Linear's branch over their current one. featureBranch =
    // root.branchName !== currentBranch. No collision possible at
    // repoRoot, so the pre-flight is a no-op.
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    let confirmReleaseCalls = 0;
    let gitSwitchCalls = 0;
    let createCalls = 0;

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "user/wip-other",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      // promptBranchOverride defaults to "linear" → featureBranch =
      // "user/feature/eng-7" ≠ currentBranch "user/wip-other".
      promptBranchOverride: makePromptOverrideStub({ pick: "linear" }),
      promptPrTarget: makePromptPrTargetStub({ branch: "master" }),
      confirmReleaseBranch: () => {
        confirmReleaseCalls += 1;
        return Promise.resolve(true);
      },
      gitSwitch: () => {
        gitSwitchCalls += 1;
        return Promise.resolve();
      },
      createWorktree: (opts) => {
        createCalls += 1;
        return Promise.resolve({
          branch:
            opts.branchStrategy.type === "branch"
              ? opts.branchStrategy.branch
              : "x",
          worktreePath: "/repo/.tide/worktrees/feature",
          run: () => Promise.reject(new Error("not used")),
          interactive: () => Promise.reject(new Error("not used")),
          createSandbox: () => Promise.reject(new Error("not used")),
          close: () => Promise.resolve({}),
          [Symbol.asyncDispose]: () => Promise.resolve(),
        });
      },
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(code).toBe(0);
    expect(confirmReleaseCalls).toBe(0);
    expect(gitSwitchCalls).toBe(0);
    expect(createCalls).toBe(1);
  });

  test("user cancels the release prompt: clean exit, no Linear writes, no createWorktree", async () => {
    // Silent override path (currentBranch === picked.branchName === featureBranch).
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    let gitSwitchCalls = 0;
    let createCalls = 0;
    let runIssueQueueCalls = 0;
    let transitionCalls = 0;

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "user/feature/eng-7",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      promptPrTarget: makePromptPrTargetStub({ branch: "master" }),
      confirmReleaseBranch: () => Promise.resolve(false),
      gitSwitch: () => {
        gitSwitchCalls += 1;
        return Promise.resolve();
      },
      createWorktree: () => {
        createCalls += 1;
        return Promise.reject(new Error("should not be reached"));
      },
      runIssueQueue: () => {
        runIssueQueueCalls += 1;
        return Promise.resolve({ completed: 0, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => {
        transitionCalls += 1;
        return Promise.resolve();
      },
    });

    expect(code).toBe(0);
    expect(gitSwitchCalls).toBe(0);
    expect(createCalls).toBe(0);
    expect(runIssueQueueCalls).toBe(0);
    expect(transitionCalls).toBe(0);
  });

  test("gitSwitch failure: aborts with exit 1, no Linear writes, no createWorktree, hint surfaced", async () => {
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    let createCalls = 0;
    let runIssueQueueCalls = 0;
    let transitionCalls = 0;

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "user/feature/eng-7",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      promptPrTarget: makePromptPrTargetStub({ branch: "master" }),
      confirmReleaseBranch: () => Promise.resolve(true),
      gitSwitch: () =>
        Promise.reject(
          new Error("git switch master failed: uncommitted changes")
        ),
      createWorktree: () => {
        createCalls += 1;
        return Promise.reject(new Error("should not be reached"));
      },
      runIssueQueue: () => {
        runIssueQueueCalls += 1;
        return Promise.resolve({ completed: 0, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => {
        transitionCalls += 1;
        return Promise.resolve();
      },
    });

    expect(code).toBe(1);
    expect(createCalls).toBe(0);
    expect(runIssueQueueCalls).toBe(0);
    expect(transitionCalls).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toContain("uncommitted changes");
    expect(out).toContain("Commit or stash");
  });

  test("override-take path: featureBranch === currentBranch triggers the pre-flight; gitSwitch called with the resolved baseBranch", async () => {
    // Picker's branchName differs from current; user takes the override
    // (`pick: "current"`). featureBranch = currentBranch, collision possible.
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    let confirmReleaseCalls = 0;
    let capturedSwitchTarget: string | undefined;
    let capturedSwitchRepoRoot: string | undefined;

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "user/wip-experiment",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      promptBranchOverride: makePromptOverrideStub({ pick: "current" }),
      promptPrTarget: makePromptPrTargetStub({ branch: "master" }),
      confirmReleaseBranch: (input) => {
        confirmReleaseCalls += 1;
        expect(input.branch).toBe("user/wip-experiment");
        expect(input.baseBranch).toBe("master");
        return Promise.resolve(true);
      },
      gitSwitch: (repoRoot, branch) => {
        capturedSwitchRepoRoot = repoRoot;
        capturedSwitchTarget = branch;
        return Promise.resolve();
      },
      createWorktree: makeCreateWorktreeStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(code).toBe(0);
    expect(confirmReleaseCalls).toBe(1);
    expect(capturedSwitchRepoRoot).toBe("/repo");
    expect(capturedSwitchTarget).toBe("master");
  });
});

describe("runQueueAfterPick — ready-for-human preflight skip log", () => {
  type WriteFn = typeof process.stdout.write;
  let stdoutChunks: string[];
  let originalStdoutWrite: WriteFn;

  const baseConfig: TideConfig = {
    linear: { team: "ENG" },
    sandbox: { mounts: [] },
    hooks: { onSandboxReady: [] },
  };

  beforeEach(() => {
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
  });

  test("logs a one-line skip notice for each `ready-for-human` direct child", async () => {
    const picked = makePRD({ identifier: "ENG-7" });

    // Two ready-for-agent items (queued) plus two ready-for-human items
    // (skipped — typically the residue of a previous run's flip).
    const subIssues: SubIssue[] = [
      makeSubIssue({
        id: "uuid-1",
        identifier: "ENG-1",
        title: "First",
        labels: ["ready-for-agent"],
      }),
      makeSubIssue({
        id: "uuid-skip-a",
        identifier: "ENG-99",
        title: "Previously blocked",
        labels: ["ready-for-human"],
      }),
      makeSubIssue({
        id: "uuid-2",
        identifier: "ENG-2",
        title: "Second",
        labels: ["ready-for-agent"],
      }),
      makeSubIssue({
        id: "uuid-skip-b",
        identifier: "ENG-100",
        title: "Previously failed",
        labels: ["ready-for-human"],
      }),
    ];

    await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve(subIssues),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 2, flipped: 0, processed: [] }),
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    const out = stdoutChunks.join("");
    expect(out).toContain("Skipping ENG-99: ready-for-human");
    expect(out).toContain("Skipping ENG-100: ready-for-human");
    // Queued items are not surfaced as skips. (`:` after the identifier is
    // the skip-line separator and disambiguates ENG-1 from ENG-100.)
    expect(out).not.toContain("Skipping ENG-1:");
    expect(out).not.toContain("Skipping ENG-2:");
  });

  test("logs no skip notices when there are no ready-for-human direct children", async () => {
    const picked = makePRD({ identifier: "ENG-7" });

    const subIssues: SubIssue[] = [
      makeSubIssue({
        id: "uuid-1",
        identifier: "ENG-1",
        title: "First",
        labels: ["ready-for-agent"],
      }),
    ];

    await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve(subIssues),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    const out = stdoutChunks.join("");
    expect(out).not.toContain("ready-for-human");
  });
});

describe("runQueueAfterPick — end-of-run no-merge warning", () => {
  type WriteFn = typeof process.stdout.write;
  let stdoutChunks: string[];
  let originalStdoutWrite: WriteFn;

  const baseConfig: TideConfig = {
    linear: { team: "ENG" },
    sandbox: { mounts: [] },
    hooks: { onSandboxReady: [] },
  };

  beforeEach(() => {
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
  });

  function makeBaseOpts(
    picked: PRD,
    tail: (opts: RunPrTailStepOptions) => Promise<PrTailStepResult>
  ) {
    return {
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: tail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
    };
  }

  test("logs the no-merge warning when PR creation was opted out", async () => {
    const picked = makePRD({ identifier: "ENG-7" });

    const code = await runQueueAfterPick(
      makeBaseOpts(picked, () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "Done. PR step skipped (you opted out at pre-flight).",
          exitCode: 0,
        } satisfies PrTailStepResult)
      )
    );

    // Warning is informational only — exit code is unchanged.
    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toContain("PRD ENG-7 will not auto-transition");
    expect(out).toContain("Transition manually in Linear");
  });

  test("logs the no-merge warning when the rev-list gate skipped an empty branch", async () => {
    const picked = makePRD({ identifier: "ENG-7" });

    const code = await runQueueAfterPick(
      makeBaseOpts(picked, () =>
        Promise.resolve({
          outcome: { kind: "skipped-empty" },
          outroMessage: "Done. PR step skipped (no commits ahead of master).",
          exitCode: 0,
        } satisfies PrTailStepResult)
      )
    );

    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toContain("PRD ENG-7 will not auto-transition");
  });

  test("logs the no-merge warning in addition to the existing PR-failure error", async () => {
    const picked = makePRD({ identifier: "ENG-7" });

    const code = await runQueueAfterPick(
      makeBaseOpts(picked, () =>
        Promise.resolve({
          outcome: { kind: "failed", message: "push refused by remote" },
          outroMessage: "Done. PR submission failed.",
          exitCode: 1,
        } satisfies PrTailStepResult)
      )
    );

    // Warning is informational only — does not change the failure exit code.
    expect(code).toBe(1);
    const out = stdoutChunks.join("");
    // Existing PR-failure error is still surfaced.
    expect(out).toContain("push refused by remote");
    // ...and the no-merge warning is logged on top.
    expect(out).toContain("PRD ENG-7 will not auto-transition");
  });

  test("does not log the no-merge warning when a PR was opened", async () => {
    const picked = makePRD({ identifier: "ENG-7" });

    const code = await runQueueAfterPick(
      makeBaseOpts(picked, () =>
        Promise.resolve({
          outcome: {
            kind: "opened",
            url: "https://github.com/acme/widget/pull/42",
          },
          outroMessage:
            "Done. PR opened: https://github.com/acme/widget/pull/42",
          exitCode: 0,
        } satisfies PrTailStepResult)
      )
    );

    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).not.toContain("will not auto-transition");
  });
});

describe("runQueueAfterPick — override-induced no-Done warning", () => {
  type WriteFn = typeof process.stdout.write;
  let stdoutChunks: string[];
  let originalStdoutWrite: WriteFn;

  const baseConfig: TideConfig = {
    linear: { team: "ENG" },
    sandbox: { mounts: [] },
    hooks: { onSandboxReady: [] },
  };

  beforeEach(() => {
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
  });

  function openedTail(): Promise<PrTailStepResult> {
    return Promise.resolve({
      outcome: {
        kind: "opened",
        url: "https://github.com/acme/widget/pull/42",
      },
      outroMessage: "Done. PR opened: https://github.com/acme/widget/pull/42",
      exitCode: 0,
    } satisfies PrTailStepResult);
  }

  function optedOutTail(): Promise<PrTailStepResult> {
    return Promise.resolve({
      outcome: { kind: "opted-out" },
      outroMessage: "Done. PR step skipped (you opted out at pre-flight).",
      exitCode: 0,
    } satisfies PrTailStepResult);
  }

  test("override taken + PR opened → emits the override-induced no-Done warning naming the root", async () => {
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "user/wip-experiment",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      ...releaseBranchNoopStubs,
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub({ pick: "current" }),
      promptPrTarget: makePromptPrTargetStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: openedTail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: () => Promise.resolve(),
    });

    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    // Names the root and references the override.
    expect(out).toContain("ENG-7");
    expect(out).toContain("Branch override");
    // Identifies the offending branch and the Linear branch.
    expect(out).toContain("user/wip-experiment");
    expect(out).toContain("user/feature/eng-7");
    // Spells out the consequence and the manual-transition fix.
    expect(out).toContain("In Review");
    expect(out).toContain("Done");
    expect(out).toMatch(/transition manually in Linear/i);
  });

  test("override NOT taken (prompt picked Linear) + PR opened → does NOT emit the override warning", async () => {
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "main",
      originHead: "main",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub({ pick: "linear" }),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: openedTail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: () => Promise.resolve(),
    });

    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).not.toContain("Branch override");
    expect(out).not.toContain("will not auto-transition");
  });

  test("silent path (current === Linear) + PR opened → does NOT emit the override warning", async () => {
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "user/feature/eng-7",
      originHead: "user/feature/eng-7",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      ...releaseBranchNoopStubs,
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: openedTail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: () => Promise.resolve(),
    });

    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).not.toContain("Branch override");
    expect(out).not.toContain("will not auto-transition");
  });

  test("override taken + no PR opened → BOTH warnings fire (no-merge + override-active)", async () => {
    // Per ADR-0016: the override-active warning loses its
    // `tail.outcome.kind === 'opened'` gate. The gate existed to suppress
    // the warning on the silent-no-PR path that the conflated single-
    // capture model produced (currentBranch === baseBranch made the rev-
    // list gate skip PR creation). With currentBranch and baseBranch now
    // captured independently, that silent path is gone and the override
    // warning fires whenever the override was taken — regardless of tail
    // outcome.
    const picked = makePRD({
      identifier: "ENG-7",
      branchName: "user/feature/eng-7",
    });

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "user/wip-experiment",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      ...releaseBranchNoopStubs,
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub({ pick: "current" }),
      promptPrTarget: makePromptPrTargetStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: optedOutTail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: () => Promise.resolve(),
    });

    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    // No-merge warning still fires on the no-PR branch.
    expect(out).toContain("PRD ENG-7 will not auto-transition");
    // Override-active warning ALSO fires (was previously suppressed under
    // the conflated model — see ADR-0016).
    expect(out).toContain("Branch override");
    expect(out).toContain("user/wip-experiment");
  });

  test("override taken on a Standalone Issue + PR opened → emits the warning with 'Issue' label", async () => {
    const issue = makeStandaloneIssue({
      id: "uuid-iss-7",
      identifier: "ENG-7",
      branchName: "user/eng-7",
    });

    const code = await runQueueAfterPick({
      picked: standaloneRoot(issue),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "user/wip-experiment",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      ...releaseBranchNoopStubs,
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub({ pick: "current" }),
      promptPrTarget: makePromptPrTargetStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: openedTail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: () => Promise.resolve(),
    });

    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toContain("Issue ENG-7");
    expect(out).toContain("Branch override");
    expect(out).not.toContain("PRD ENG-7");
  });
});

describe("runQueueAfterPick — Standalone Issue root", () => {
  type WriteFn = typeof process.stdout.write;
  let stdoutChunks: string[];
  let originalStdoutWrite: WriteFn;

  const baseConfig: TideConfig = {
    linear: { team: "ENG" },
    sandbox: { mounts: [] },
    hooks: { onSandboxReady: [] },
  };

  beforeEach(() => {
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
  });

  test("transitions the Issue itself to In Progress (not a separate PRD) before the queue runs", async () => {
    const issue = makeStandaloneIssue({
      id: "uuid-iss-7",
      identifier: "ENG-7",
    });
    const transitionCalls: { ctx: LinearContext; issueId: string }[] = [];

    await runQueueAfterPick({
      picked: standaloneRoot(issue),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      // No children — the no-children validator must succeed.
      fetchSubIssues: () => Promise.resolve([]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opened", url: "https://example/pr/1" },
          outroMessage: "ok",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: (ctx, issueId) => {
        transitionCalls.push({ ctx, issueId });
        return Promise.resolve();
      },
    });

    expect(transitionCalls).toHaveLength(1);
    expect(transitionCalls[0]?.issueId).toBe("uuid-iss-7");
  });

  test("dispatches a one-element queue carrying the Standalone Issue itself", async () => {
    const issue = makeStandaloneIssue({
      id: "uuid-iss-7",
      identifier: "ENG-7",
      title: "Fix flaky export",
    });
    let capturedOrdered: { id: string; identifier: string; title: string }[] =
      [];
    let capturedRoot: { kind: string } | undefined;

    await runQueueAfterPick({
      picked: standaloneRoot(issue),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: (opts) => {
        capturedOrdered = opts.orderedIssues;
        capturedRoot = opts.root;
        return Promise.resolve({ completed: 1, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opened", url: "https://example/pr/1" },
          outroMessage: "ok",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(capturedOrdered).toEqual([
      { id: "uuid-iss-7", identifier: "ENG-7", title: "Fix flaky export" },
    ]);
    expect(capturedRoot).toEqual({ kind: "standalone" });
  });

  test("aborts on confirm when the Standalone Issue has Linear children, before any Linear write", async () => {
    const issue = makeStandaloneIssue({ identifier: "ENG-7" });
    let runIssueQueueCalls = 0;
    let transitionCalls = 0;

    const code = await runQueueAfterPick({
      picked: standaloneRoot(issue),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () =>
        Promise.resolve([
          {
            id: "uuid-child",
            identifier: "ENG-77",
            title: "Sub-task",
            state: "Backlog",
            stateType: "backlog",
            labels: [],
            blockedBy: [],
          },
        ] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () => {
        runIssueQueueCalls += 1;
        return Promise.resolve({ completed: 0, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => {
        transitionCalls += 1;
        return Promise.resolve();
      },
    });

    expect(code).toBe(1);
    expect(runIssueQueueCalls).toBe(0);
    expect(transitionCalls).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toContain("ENG-7");
    expect(out).toContain("Standalone Issue");
    expect(out).toContain("non-PRD with children");
  });

  test("does not surface the children-error when the user cancels at the pre-flight (standalone with children)", async () => {
    // PER-56 acceptance: the children-check happens AFTER the user confirms
    // the pre-flight. Cancelling the run at the confirm prompt — even when
    // the picked Standalone Issue would otherwise fail validation — must
    // exit cleanly with no structural error message.
    const issue = makeStandaloneIssue({ identifier: "ENG-7" });
    let fetchSubIssuesCalls = 0;
    let runIssueQueueCalls = 0;
    let transitionCalls = 0;

    const code = await runQueueAfterPick({
      picked: standaloneRoot(issue),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => {
        fetchSubIssuesCalls += 1;
        return Promise.resolve([
          {
            id: "uuid-child",
            identifier: "ENG-77",
            title: "Sub-task",
            state: "Backlog",
            stateType: "backlog",
            labels: [],
            blockedBy: [],
          },
        ] as SubIssue[]);
      },
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () => {
        runIssueQueueCalls += 1;
        return Promise.resolve({ completed: 0, flipped: 0, processed: [] });
      },
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "x",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(false),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => {
        transitionCalls += 1;
        return Promise.resolve();
      },
    });

    expect(code).toBe(0);
    expect(fetchSubIssuesCalls).toBe(0);
    expect(runIssueQueueCalls).toBe(0);
    expect(transitionCalls).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).not.toContain("non-PRD with children");
  });

  test("logs the BLOCKED warning when the standalone iteration ends on a flip (no completion)", async () => {
    const issue = makeStandaloneIssue({ identifier: "ENG-7" });

    const code = await runQueueAfterPick({
      picked: standaloneRoot(issue),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 0, flipped: 1, processed: [] }),
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "Done. PR step skipped (you opted out at pre-flight).",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toContain("Issue ENG-7 is flipped to `ready-for-human`");
    // No-merge warning for "Issue" rather than "PRD".
    expect(out).toContain("Issue ENG-7 will not auto-transition");
    // BLOCKED hand-off warning fires BEFORE the no-merge warning so it's
    // the first thing the user reads after the queue ends.
    const flippedIdx = out.indexOf("is flipped to `ready-for-human`");
    const noMergeIdx = out.indexOf("will not auto-transition");
    expect(flippedIdx).toBeGreaterThanOrEqual(0);
    expect(noMergeIdx).toBeGreaterThan(flippedIdx);
  });

  test("does not log the BLOCKED warning when the standalone iteration completes (DONE)", async () => {
    const issue = makeStandaloneIssue({ identifier: "ENG-7" });

    const code = await runQueueAfterPick({
      picked: standaloneRoot(issue),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opened", url: "https://example/pr/1" },
          outroMessage: "Done. PR opened: https://example/pr/1",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).not.toContain("is flipped to `ready-for-human`");
  });

  test("PRD-rooted run with a flipped sub-issue does not log the Standalone BLOCKED warning", async () => {
    const picked = makePRD({ identifier: "ENG-1", title: "Example PRD" });

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () =>
        Promise.resolve([
          makeSubIssue({
            id: "uuid-sub-1",
            identifier: "ENG-2",
            title: "Sub-task",
          }),
        ]),
      // The PRD-rooted queue ran one sub-issue and flipped it to
      // `ready-for-human`. The Standalone-specific warning must not fire —
      // the per-sub-issue warning (logged inside the runner, not here) is
      // the only BLOCKED hand-off the user should see.
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 0, flipped: 1, processed: [] }),
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opted-out" },
          outroMessage: "Done. PR step skipped (you opted out at pre-flight).",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).not.toContain("is flipped to `ready-for-human`");
    // The PRD's existing no-merge warning is still expected.
    expect(out).toContain("PRD ENG-1 will not auto-transition");
  });

  test("pre-flight summary text branches per root kind: 'Standalone Issue: 1 iteration'", async () => {
    const issue = makeStandaloneIssue({ identifier: "ENG-7" });

    await runQueueAfterPick({
      picked: standaloneRoot(issue),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: () =>
        Promise.resolve({
          outcome: { kind: "opened", url: "https://example/pr/1" },
          outroMessage: "ok",
          exitCode: 0,
        } satisfies PrTailStepResult),
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    const out = stdoutChunks.join("");
    expect(out).toContain("Standalone Issue: 1 iteration");
    // PRD-rooted summary text must not appear.
    expect(out).not.toContain("PRD-rooted:");
  });

  test("PR-tail receives an empty subIssues list (the body's `Sub-issues addressed` block is omitted by buildPrPromptArgs)", async () => {
    const issue = makeStandaloneIssue({ identifier: "ENG-7" });
    let capturedSubIssues: { number: number; title: string }[] | undefined;

    await runQueueAfterPick({
      picked: standaloneRoot(issue),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: (opts) => {
        capturedSubIssues = opts.subIssues;
        return Promise.resolve({
          outcome: { kind: "opened", url: "https://example/pr/1" },
          outroMessage: "ok",
          exitCode: 0,
        } satisfies PrTailStepResult);
      },
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
    });

    expect(capturedSubIssues).toEqual([]);
  });
});

describe("runQueueAfterPick — PR-tail subIssueRefs come from runner.processed (ADR-0010)", () => {
  const baseConfig: TideConfig = {
    linear: { team: "ENG" },
    sandbox: { mounts: [] },
    hooks: { onSandboxReady: [] },
  };

  test("PRD root: PR body's Sub-issues addressed block is built from result.processed, not the pre-flight orderedIssues", async () => {
    const picked = makePRD({ id: "uuid-eng-1", identifier: "ENG-1" });
    let capturedSubIssues: { number: number; title: string }[] | undefined;

    await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      // Pre-flight returns one ready-for-agent sub-issue.
      fetchSubIssues: () =>
        Promise.resolve([
          {
            id: "uuid-2",
            identifier: "ENG-2",
            title: "Initial",
            state: "Backlog",
            stateType: "backlog",
            labels: ["ready-for-agent"],
            blockedBy: [],
          },
        ] as SubIssue[]),
      // Runner reports it processed two — initial + one absorbed via the
      // mid-run queue rebuild (ENG-3). The PR-tail step must reflect both.
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({
          completed: 2,
          flipped: 0,
          processed: [
            { id: "uuid-2", identifier: "ENG-2", title: "Initial" },
            { id: "uuid-3", identifier: "ENG-3", title: "Absorbed" },
          ],
        }),
      runPrTailStep: (opts) => {
        capturedSubIssues = opts.subIssues;
        return Promise.resolve({
          outcome: { kind: "opened", url: "https://example/pr/1" },
          outroMessage: "ok",
          exitCode: 0,
        } satisfies PrTailStepResult);
      },
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: () => Promise.resolve(),
    });

    expect(capturedSubIssues).toEqual([
      { number: 1, title: "ENG-2 Initial" },
      { number: 2, title: "ENG-3 Absorbed" },
    ]);
  });
});

describe("runQueueAfterPick — post-submission In Review hook", () => {
  type WriteFn = typeof process.stdout.write;
  let stdoutChunks: string[];
  let originalStdoutWrite: WriteFn;

  const baseConfig: TideConfig = {
    linear: { team: "ENG" },
    sandbox: { mounts: [] },
    hooks: { onSandboxReady: [] },
  };

  beforeEach(() => {
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
  });

  function openedTail(): Promise<PrTailStepResult> {
    return Promise.resolve({
      outcome: { kind: "opened", url: "https://example/pr/1" },
      outroMessage: "Done. PR opened: https://example/pr/1",
      exitCode: 0,
    } satisfies PrTailStepResult);
  }

  function optedOutTail(): Promise<PrTailStepResult> {
    return Promise.resolve({
      outcome: { kind: "opted-out" },
      outroMessage: "Done. PR step skipped (you opted out at pre-flight).",
      exitCode: 0,
    } satisfies PrTailStepResult);
  }

  test("clean queue + PR opened → transitions the picked PRD to In Review", async () => {
    const picked = makePRD({ id: "uuid-eng-1", identifier: "ENG-1" });
    const calls: { ctx: LinearContext; issueId: string }[] = [];

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: openedTail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: (ctx, issueId) => {
        calls.push({ ctx, issueId });
        return Promise.resolve();
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      { ctx: { apiKey: "lk", teamKey: "ENG" }, issueId: "uuid-eng-1" },
    ]);
  });

  test("clean queue + no PR opened → does not transition; existing no-merge warning still fires", async () => {
    const picked = makePRD({ id: "uuid-eng-1", identifier: "ENG-1" });
    let calls = 0;

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: optedOutTail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: () => {
        calls += 1;
        return Promise.resolve();
      },
    });

    expect(code).toBe(0);
    expect(calls).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toContain("PRD ENG-1 will not auto-transition");
  });

  test("dirty queue (flipped > 0) + PR opened → does not transition; emits skip warning", async () => {
    const picked = makePRD({ id: "uuid-eng-1", identifier: "ENG-1" });
    let calls = 0;

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 1, processed: [] }),
      runPrTailStep: openedTail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: () => {
        calls += 1;
        return Promise.resolve();
      },
    });

    expect(code).toBe(0);
    expect(calls).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toContain("ENG-1");
    expect(out).toContain("In Review");
  });

  test("dirty queue + no PR → does not transition; existing no-merge warning still fires", async () => {
    const picked = makePRD({ id: "uuid-eng-1", identifier: "ENG-1" });
    let calls = 0;

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 0, flipped: 1, processed: [] }),
      runPrTailStep: optedOutTail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: () => {
        calls += 1;
        return Promise.resolve();
      },
    });

    expect(code).toBe(0);
    expect(calls).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toContain("PRD ENG-1 will not auto-transition");
  });

  test("In Review transition failure preserves the PR and earlier Linear writes; warning surfaces in summary", async () => {
    const picked = makePRD({ id: "uuid-eng-1", identifier: "ENG-1" });

    const code = await runQueueAfterPick({
      picked: prdRoot(picked),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: openedTail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: () =>
        Promise.reject(new Error("Linear API timeout")),
    });

    // PR was opened — exit code stays 0 even though the In Review
    // transition failed afterwards.
    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    // PR URL still surfaced (PR not unwound).
    expect(out).toContain("https://example/pr/1");
    // Failure surfaces in the run output.
    expect(out).toContain("In Review");
    expect(out).toContain("Linear API timeout");
  });
});

describe("runQueueAfterPick — post-submission In Review hook (Standalone Issue root)", () => {
  type WriteFn = typeof process.stdout.write;
  let stdoutChunks: string[];
  let originalStdoutWrite: WriteFn;

  const baseConfig: TideConfig = {
    linear: { team: "ENG" },
    sandbox: { mounts: [] },
    hooks: { onSandboxReady: [] },
  };

  beforeEach(() => {
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
  });

  function openedTail(): Promise<PrTailStepResult> {
    return Promise.resolve({
      outcome: { kind: "opened", url: "https://example/pr/1" },
      outroMessage: "Done. PR opened: https://example/pr/1",
      exitCode: 0,
    } satisfies PrTailStepResult);
  }

  function optedOutTail(): Promise<PrTailStepResult> {
    return Promise.resolve({
      outcome: { kind: "opted-out" },
      outroMessage: "Done. PR step skipped (you opted out at pre-flight).",
      exitCode: 0,
    } satisfies PrTailStepResult);
  }

  test("clean iteration + PR opened → transitions the Standalone Issue to In Review", async () => {
    const issue = makeStandaloneIssue({
      id: "uuid-iss-7",
      identifier: "ENG-7",
    });
    const calls: { ctx: LinearContext; issueId: string }[] = [];

    const code = await runQueueAfterPick({
      picked: standaloneRoot(issue),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: openedTail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: (ctx, issueId) => {
        calls.push({ ctx, issueId });
        return Promise.resolve();
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      { ctx: { apiKey: "lk", teamKey: "ENG" }, issueId: "uuid-iss-7" },
    ]);
  });

  test("clean iteration + no PR opened → does NOT transition; existing no-merge warning still fires", async () => {
    const issue = makeStandaloneIssue({ identifier: "ENG-7" });
    let calls = 0;

    const code = await runQueueAfterPick({
      picked: standaloneRoot(issue),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: optedOutTail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: () => {
        calls += 1;
        return Promise.resolve();
      },
    });

    expect(code).toBe(0);
    expect(calls).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toContain("Issue ENG-7 will not auto-transition");
  });

  test("dirty iteration (flipped > 0) + PR opened → does NOT transition", async () => {
    const issue = makeStandaloneIssue({ identifier: "ENG-7" });
    let calls = 0;

    const code = await runQueueAfterPick({
      picked: standaloneRoot(issue),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 0, flipped: 1, processed: [] }),
      runPrTailStep: openedTail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: () => {
        calls += 1;
        return Promise.resolve();
      },
    });

    expect(code).toBe(0);
    expect(calls).toBe(0);
    // The existing standalone BLOCKED warning communicates the skip; no
    // new "not transitioned" warning is required for this cell.
    const out = stdoutChunks.join("");
    expect(out).toContain("Issue ENG-7 is flipped to `ready-for-human`");
  });

  test("dirty iteration + no PR → does NOT transition", async () => {
    const issue = makeStandaloneIssue({ identifier: "ENG-7" });
    let calls = 0;

    const code = await runQueueAfterPick({
      picked: standaloneRoot(issue),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 0, flipped: 1, processed: [] }),
      runPrTailStep: optedOutTail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(false),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: () => {
        calls += 1;
        return Promise.resolve();
      },
    });

    expect(code).toBe(0);
    expect(calls).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toContain("Issue ENG-7 is flipped to `ready-for-human`");
    expect(out).toContain("Issue ENG-7 will not auto-transition");
  });

  test("In Review transition failure preserves the PR and earlier Linear writes; warning surfaces in summary", async () => {
    const issue = makeStandaloneIssue({ identifier: "ENG-7" });

    const code = await runQueueAfterPick({
      picked: standaloneRoot(issue),
      ghRepo: { owner: "acme", repo: "widget" },
      currentBranch: "master",
      originHead: "master",
      linearCtx: { apiKey: "lk", teamKey: "ENG" },
      repoRoot: "/repo",
      config: baseConfig,
      sandboxEnv: {},
      fetchSubIssues: () => Promise.resolve([] as SubIssue[]),
      createWorktree: makeCreateWorktreeStub(),
      promptBranchOverride: makePromptOverrideStub(),
      runIssueQueue: () =>
        Promise.resolve({ completed: 1, flipped: 0, processed: [] }),
      runPrTailStep: openedTail,
      confirmRun: () => Promise.resolve(true),
      confirmPr: () => Promise.resolve(true),
      transitionRootToInProgress: () => Promise.resolve(),
      transitionRootToInReview: () =>
        Promise.reject(new Error("Linear API timeout")),
    });

    // PR was opened — exit code stays 0 even though the In Review
    // transition failed afterwards.
    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    // PR URL still surfaced (PR not unwound).
    expect(out).toContain("https://example/pr/1");
    // Failure surfaces in the run output, citing both the issue identifier
    // and the In Review transition.
    expect(out).toContain("ENG-7");
    expect(out).toContain("In Review");
    expect(out).toContain("Linear API timeout");
  });
});
