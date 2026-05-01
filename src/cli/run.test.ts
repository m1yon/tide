import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tideRun } from "./run.ts";
import type { BuildOptions } from "./build.ts";
import type { GhRepo, TreeNode } from "../github/index.ts";
import type { GhIdentity } from "../gh-identity/index.ts";

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

interface FetchStub {
  tree: TreeNode[];
  calls: GhRepo[];
}

function makeFetchTriageTree(stub: FetchStub, log: CallLog) {
  return (ghRepo: GhRepo): Promise<TreeNode[]> => {
    stub.calls.push(ghRepo);
    log.events.push("fetchTriageTree");
    return Promise.resolve(stub.tree);
  };
}

describe("tide run — build step", () => {
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

  test("invokes build before fetching the triage tree", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const fetchStub: FetchStub = { tree: [], calls: [] };

    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      fetchTriageTree: makeFetchTriageTree(fetchStub, log),
    });

    expect(code).toBe(0);
    expect(buildStub.calls).toHaveLength(1);
    expect(fetchStub.calls).toHaveLength(1);
    const buildIdx = log.events.indexOf("build");
    const fetchIdx = log.events.indexOf("fetchTriageTree");
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeGreaterThan(buildIdx);
  });

  test("build receives the resolved repoRoot and the same stdout/stderr sinks", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const fetchStub: FetchStub = { tree: [], calls: [] };

    await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      fetchTriageTree: makeFetchTriageTree(fetchStub, log),
    });

    const call = buildStub.calls[0];
    if (call === undefined) throw new Error("missing build call");
    expect(call.repoRoot).toBe(repoRoot);
    expect(call.stdout).toBe(captureStdout);
    expect(call.stderr).toBe(captureStderr);
  });

  test("build failure short-circuits with the build's exit code; triage tree fetch never runs", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 2, calls: [] };
    const fetchStub: FetchStub = { tree: [], calls: [] };

    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      fetchTriageTree: makeFetchTriageTree(fetchStub, log),
    });

    expect(code).toBe(2);
    expect(buildStub.calls).toHaveLength(1);
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("build success allows the existing flow to proceed", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const fetchStub: FetchStub = { tree: [], calls: [] };

    const code = await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      fetchTriageTree: makeFetchTriageTree(fetchStub, log),
    });

    // Empty triage tree → "Nothing to triage" branch returns 0.
    expect(code).toBe(0);
    expect(buildStub.calls).toHaveLength(1);
    expect(fetchStub.calls).toHaveLength(1);
  });

  test("build runs after gh-identity is resolved", async () => {
    const log: CallLog = { events: [] };
    const buildStub: BuildStub = { exitCode: 0, calls: [] };
    const fetchStub: FetchStub = { tree: [], calls: [] };

    await tideRun({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
      build: makeBuild(buildStub, log),
      getGhIdentity: makeGhIdentity(log),
      fetchTriageTree: makeFetchTriageTree(fetchStub, log),
    });

    const ghIdx = log.events.indexOf("getGhIdentity");
    const buildIdx = log.events.indexOf("build");
    expect(ghIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(ghIdx);
  });
});
