// Short suite — runs always. Exercises both the shared contract (which
// the SDK-backed live arm also runs) and the InMemory-only seed/
// observation surface that tests rely on (scripted `RunResult` queue,
// scripted transcripts, `iterationsRun` / `worktreesCreated` /
// `transcriptsRead` observers, failure injection).

import { describe, expect, test } from "bun:test";
import {
  claudeCode,
  type RunOptions,
  type RunResult,
} from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { InMemorySandcastleService } from "./in-memory.ts";
import { sandcastleServiceContract } from "./contract.ts";

sandcastleServiceContract("InMemorySandcastleService", () => {
  return new InMemorySandcastleService();
});

const baseRunOpts: RunOptions = {
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker({ imageName: "test", mounts: [] }),
};

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    iterations: [],
    stdout: "",
    commits: [],
    branch: "feature",
    ...overrides,
  };
}

describe("InMemorySandcastleService — scripted RunResult queue", () => {
  test("hands out queued RunResults one per run() call in order", async () => {
    const svc = new InMemorySandcastleService({
      runResults: [
        makeRunResult({ branch: "first" }),
        makeRunResult({ branch: "second" }),
      ],
    });
    const r1 = await svc.run({ ...baseRunOpts, name: "tide" });
    const r2 = await svc.run({ ...baseRunOpts, name: "tide-summarizer" });
    expect(r1.branch).toBe("first");
    expect(r2.branch).toBe("second");
  });

  test("returns a default empty RunResult once the queue is exhausted", async () => {
    const svc = new InMemorySandcastleService();
    const r = await svc.run({ ...baseRunOpts, name: "tide" });
    expect(r.commits).toEqual([]);
    expect(r.completionSignal).toBeUndefined();
  });

  test("pushRunResults extends the queue mid-scenario", async () => {
    const svc = new InMemorySandcastleService();
    svc.pushRunResults(makeRunResult({ branch: "late-arrival" }));
    const r = await svc.run({ ...baseRunOpts });
    expect(r.branch).toBe("late-arrival");
  });
});

describe("InMemorySandcastleService — per-call run handler", () => {
  test("a run handler dispatches per call based on opts; replaces the queue", async () => {
    const svc = new InMemorySandcastleService({
      runResults: [makeRunResult({ branch: "queued" })],
    });
    svc.setRunHandler((opts) => {
      if (opts.name === "tide-summarizer") {
        return Promise.resolve(makeRunResult({ branch: "summarizer" }));
      }
      return Promise.resolve(makeRunResult({ branch: "working" }));
    });
    const a = await svc.run({ ...baseRunOpts, name: "tide" });
    const b = await svc.run({ ...baseRunOpts, name: "tide-summarizer" });
    expect(a.branch).toBe("working");
    expect(b.branch).toBe("summarizer");
  });

  test("clearing the handler returns to queue-based dispatch", async () => {
    const svc = new InMemorySandcastleService({
      runResults: [makeRunResult({ branch: "queued" })],
    });
    svc.setRunHandler(() =>
      Promise.resolve(makeRunResult({ branch: "hooked" }))
    );
    svc.setRunHandler(null);
    const r = await svc.run({ ...baseRunOpts });
    expect(r.branch).toBe("queued");
  });
});

describe("InMemorySandcastleService — transcripts", () => {
  test("returns the seeded transcript text for a known log path", async () => {
    const svc = new InMemorySandcastleService({
      transcripts: { "/tmp/working.log": "the agent's final message" },
    });
    const out = await svc.readFinalAssistantMessage("/tmp/working.log");
    expect(out).toBe("the agent's final message");
  });

  test("unknown log paths fall through to an empty string", async () => {
    const svc = new InMemorySandcastleService();
    expect(await svc.readFinalAssistantMessage("/missing")).toBe("");
  });

  test("setTranscript installs a transcript mid-scenario", async () => {
    const svc = new InMemorySandcastleService();
    svc.setTranscript("/tmp/x.log", "added later");
    expect(await svc.readFinalAssistantMessage("/tmp/x.log")).toBe(
      "added later"
    );
  });

  test("a custom read-transcript handler takes precedence over the seed map", async () => {
    const svc = new InMemorySandcastleService({
      transcripts: { "/tmp/seeded.log": "from seed" },
    });
    svc.setReadTranscriptHandler((p) => Promise.resolve(`handler:${p}`));
    expect(await svc.readFinalAssistantMessage("/tmp/seeded.log")).toBe(
      "handler:/tmp/seeded.log"
    );
  });
});

describe("InMemorySandcastleService — createWorktree", () => {
  test("returns a stub Worktree whose branch matches a `branch` strategy", async () => {
    const svc = new InMemorySandcastleService();
    const wt = await svc.createWorktree({
      branchStrategy: {
        type: "branch",
        branch: "feature/foo",
        baseBranch: "master",
      },
      cwd: "/repo",
    });
    expect(wt.branch).toBe("feature/foo");
    expect(typeof wt.worktreePath).toBe("string");
  });

  test("worktreePath defaults to a deterministic stub path; seed override wins", async () => {
    const svc = new InMemorySandcastleService({ worktreePath: "/seed/path" });
    const wt = await svc.createWorktree({
      branchStrategy: {
        type: "branch",
        branch: "feature/foo",
        baseBranch: "master",
      },
      cwd: "/repo",
    });
    expect(wt.worktreePath).toBe("/seed/path");
  });

  test("a custom create-worktree handler controls the returned shape", async () => {
    const svc = new InMemorySandcastleService();
    svc.setCreateWorktreeHandler((opts) =>
      Promise.resolve({
        branch:
          opts.branchStrategy.type === "branch"
            ? opts.branchStrategy.branch
            : "x",
        worktreePath: "/custom/wt",
        run: () => Promise.reject(new Error("not used")),
        interactive: () => Promise.reject(new Error("not used")),
        createSandbox: () => Promise.reject(new Error("not used")),
        close: () => Promise.resolve({}),
        [Symbol.asyncDispose]: () => Promise.resolve(),
      })
    );
    const wt = await svc.createWorktree({
      branchStrategy: { type: "branch", branch: "f", baseBranch: "master" },
      cwd: "/repo",
    });
    expect(wt.worktreePath).toBe("/custom/wt");
  });
});

describe("InMemorySandcastleService — observation methods", () => {
  test("iterationsRun captures every run() call's options in order", async () => {
    const svc = new InMemorySandcastleService();
    await svc.run({ ...baseRunOpts, name: "first" });
    await svc.run({ ...baseRunOpts, name: "second" });
    const seen = svc.iterationsRun().map((o) => o.name);
    expect(seen).toEqual(["first", "second"]);
  });

  test("worktreesCreated captures every createWorktree() call's options in order", async () => {
    const svc = new InMemorySandcastleService();
    await svc.createWorktree({
      branchStrategy: { type: "branch", branch: "a", baseBranch: "master" },
      cwd: "/repo",
    });
    await svc.createWorktree({
      branchStrategy: { type: "merge-to-head" },
      cwd: "/repo",
    });
    const calls = svc.worktreesCreated();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.branchStrategy.type).toBe("branch");
    expect(calls[1]?.branchStrategy.type).toBe("merge-to-head");
  });

  test("transcriptsRead captures every readFinalAssistantMessage call", async () => {
    const svc = new InMemorySandcastleService({
      transcripts: { "/a": "x", "/b": "y" },
    });
    await svc.readFinalAssistantMessage("/a");
    await svc.readFinalAssistantMessage("/b");
    expect(svc.transcriptsRead()).toEqual(["/a", "/b"]);
  });
});

describe("InMemorySandcastleService — failure injection", () => {
  test("failNext('run') makes the next run() reject; subsequent calls succeed", async () => {
    const svc = new InMemorySandcastleService();
    svc.failNext("run", new Error("docker daemon down"));
    const err = await svc
      .run({ ...baseRunOpts })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) throw new Error("unreachable");
    expect(err.message).toContain("docker daemon down");
    // Next call recovers cleanly.
    const r = await svc.run({ ...baseRunOpts });
    expect(r.commits).toEqual([]);
  });

  test("failNext('readFinalAssistantMessage') makes the next read reject", async () => {
    const svc = new InMemorySandcastleService();
    svc.failNext("readFinalAssistantMessage", new Error("transcript missing"));
    const err = await svc
      .readFinalAssistantMessage("/anywhere")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });

  test("failNext('createWorktree') makes the next createWorktree reject", async () => {
    const svc = new InMemorySandcastleService();
    svc.failNext("createWorktree", new Error("disk full"));
    const err = await svc
      .createWorktree({
        branchStrategy: { type: "branch", branch: "f", baseBranch: "master" },
        cwd: "/repo",
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });
});
