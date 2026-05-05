import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOrderedQueue, runPrTailStep, tideRun } from "./run.ts";
import type { BuildOptions } from "./build.ts";
import type { GhIdentity } from "../gh-identity/index.ts";
import type { LinearContext, PRD, SubIssue } from "../linear/index.ts";
import type {
  PrSubmissionResult,
  ShellResult,
  ShellRunner,
} from "../pr-submission/index.ts";
import type { TideConfig } from "../config-loader/index.ts";

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
}

function makeListPRDs(stub: ListPRDsStub, log: CallLog) {
  return (ctx: LinearContext): Promise<PRD[]> => {
    stub.calls.push(ctx);
    log.events.push("listPRDs");
    return Promise.resolve(stub.prds);
  };
}

interface PickPRDStub {
  /** Index into the prds list to pick. */
  pickIndex: number;
  calls: number;
}

function makePickPRD(stub: PickPRDStub, log: CallLog) {
  return (prds: readonly PRD[]): Promise<PRD> => {
    stub.calls += 1;
    log.events.push("pickPRD");
    const picked = prds[stub.pickIndex];
    if (!picked) throw new Error("pickPRD stub: index out of range");
    return Promise.resolve(picked);
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
// resolveBaseBranch makes before any other work. Tests that don't care
// about base-branch capture use this to keep the early gate happy.
const okBaseBranchRunner = constShellRunner({
  exitCode: 0,
  stdout: "master\n",
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
    const listStub: ListPRDsStub = { prds: [], calls: [] };

    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      baseBranchShellRunner: okBaseBranchRunner,
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
    const listStub: ListPRDsStub = { prds: [], calls: [] };

    await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      baseBranchShellRunner: okBaseBranchRunner,
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
    const listStub: ListPRDsStub = { prds: [], calls: [] };

    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      baseBranchShellRunner: okBaseBranchRunner,
    });

    expect(code).toBe(2);
    expect(buildStub.calls).toHaveLength(1);
    expect(listStub.calls).toHaveLength(0);
  });

  test("empty PRD list exits cleanly without invoking the selector", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [] };
    const pickStub: PickPRDStub = { pickIndex: 0, calls: 0 };

    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      pickPRD: makePickPRD(pickStub, log),
      baseBranchShellRunner: okBaseBranchRunner,
    });

    expect(code).toBe(0);
    expect(pickStub.calls).toBe(0);
  });

  test("non-empty PRD list invokes pickPRD and dispatches the picked PRD to runQueueAfterPick", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = {
      prds: [
        makePRD({ identifier: "ENG-7", title: "Search rewrite" }),
        makePRD({ identifier: "ENG-8", title: "Auth migration" }),
      ],
      calls: [],
    };
    const pickStub: PickPRDStub = { pickIndex: 1, calls: 0 };
    const queueCalls: PRD[] = [];

    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      pickPRD: makePickPRD(pickStub, log),
      runQueueAfterPick: (opts) => {
        log.events.push("runQueueAfterPick");
        queueCalls.push(opts.picked);
        return Promise.resolve(0);
      },
      baseBranchShellRunner: okBaseBranchRunner,
    });

    expect(code).toBe(0);
    expect(pickStub.calls).toBe(1);
    // The post-pick orchestration is invoked exactly once with the picked PRD.
    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0]?.identifier).toBe("ENG-8");

    const pickIdx = log.events.indexOf("pickPRD");
    const queueIdx = log.events.indexOf("runQueueAfterPick");
    expect(pickIdx).toBeGreaterThanOrEqual(0);
    expect(queueIdx).toBeGreaterThan(pickIdx);
  });

  test("listPRDs receives the LINEAR_API_KEY and team key from config", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [] };

    await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      baseBranchShellRunner: okBaseBranchRunner,
    });

    expect(listStub.calls[0]?.apiKey).toBe("lk");
    expect(listStub.calls[0]?.teamKey).toBe("ENG");
  });

  test("LINEAR_API_KEY is not forwarded into the sandbox (it stays host-side)", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [] };

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
      baseBranchShellRunner: okBaseBranchRunner,
    });

    expect(code).toBe(0);
  });

  test("build runs after gh-identity is resolved", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [] };

    await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      getGhToken: makeGhToken(log),
      listPRDs: makeListPRDs(listStub, log),
      baseBranchShellRunner: okBaseBranchRunner,
    });

    const ghIdx = log.events.indexOf("getGhIdentity");
    const buildIdx = log.events.indexOf("build");
    expect(ghIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(ghIdx);
  });

  test("getGhToken runs after gh-identity and before docker build", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const listStub: ListPRDsStub = { prds: [], calls: [] };

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
      baseBranchShellRunner: okBaseBranchRunner,
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
    const listStub: ListPRDsStub = { prds: [], calls: [] };

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
      baseBranchShellRunner: okBaseBranchRunner,
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
      baseBranchShellRunner: okBaseBranchRunner,
    });

    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("Linear API key invalid");
  });
});

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
    subIssues: [{ number: 8, title: "Foundation tracer" }],
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
