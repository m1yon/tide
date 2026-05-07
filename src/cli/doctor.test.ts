import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, type Runner } from "./doctor.ts";

interface RunnerStub {
  // Map "<cmd> <args.joined-by-space>" → result
  responses: Record<
    string,
    { exitCode: number; stdout: string; stderr?: string }
  >;
  calls: { cmd: string; args: readonly string[]; cwd: string | undefined }[];
}

function buildRunner(stub: RunnerStub): Runner {
  return (cmd, args, cwd) => {
    stub.calls.push({ cmd, args: [...args], cwd });
    const key = [cmd, ...args].join(" ");
    const result = stub.responses[key];
    if (result === undefined) {
      throw new Error(`unmocked runner call: ${key}`);
    }
    return Promise.resolve({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr ?? "",
    });
  };
}

describe("tide doctor", () => {
  let workDir: string;
  let repoRoot: string;
  let tideDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tide-doctor-"));
    repoRoot = join(workDir, "repo");
    tideDir = join(repoRoot, ".tide");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(tideDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeValidEnv(): void {
    writeFileSync(
      join(tideDir, ".env"),
      "LINEAR_API_KEY=lk\nANTHROPIC_API_KEY=ak\n"
    );
  }

  function writeValidConfig(): void {
    writeFileSync(
      join(tideDir, "config.ts"),
      `export default { linear: { team: "ENG" } };\n`
    );
  }

  function happyRunnerStub(): RunnerStub {
    return {
      calls: [],
      responses: {
        "gh auth status": { exitCode: 0, stdout: "" },
        "docker info": { exitCode: 0, stdout: "" },
        "gh repo view --json owner,name": {
          exitCode: 0,
          stdout: JSON.stringify({ owner: { login: "m1yon" }, name: "tide" }),
        },
      },
    };
  }

  test("all checks pass — exits zero with each runner check invoked once", async () => {
    writeValidEnv();
    writeValidConfig();
    const stub = happyRunnerStub();
    let viewerCalls = 0;
    let inReviewCalls = 0;

    const code = await doctor({
      repoRoot,
      runner: buildRunner(stub),
      linearViewerCheck: () => {
        viewerCalls += 1;
        return Promise.resolve();
      },
      linearInReviewStateCheck: () => {
        inReviewCalls += 1;
        return Promise.resolve();
      },
    });

    expect(code).toBe(0);
    expect(viewerCalls).toBe(1);
    expect(inReviewCalls).toBe(1);
    const cmds = stub.calls.map((c) => [c.cmd, ...c.args].join(" "));
    expect(cmds).toContain("gh auth status");
    expect(cmds).toContain("docker info");
    expect(cmds).toContain("gh repo view --json owner,name");
  });

  test("all checks pass with CLAUDE_CODE_OAUTH_TOKEN in place of ANTHROPIC_API_KEY", async () => {
    writeFileSync(
      join(tideDir, ".env"),
      "LINEAR_API_KEY=lk\nCLAUDE_CODE_OAUTH_TOKEN=tok\n"
    );
    writeValidConfig();

    const code = await doctor({
      repoRoot,
      runner: buildRunner(happyRunnerStub()),
      linearViewerCheck: () => Promise.resolve(),
      linearInReviewStateCheck: () => Promise.resolve(),
    });

    expect(code).toBe(0);
  });

  test("missing `In Review` state yields non-zero exit; the check is invoked", async () => {
    writeValidEnv();
    writeValidConfig();
    let inReviewCalls = 0;

    const code = await doctor({
      repoRoot,
      runner: buildRunner(happyRunnerStub()),
      linearViewerCheck: () => Promise.resolve(),
      linearInReviewStateCheck: () => {
        inReviewCalls += 1;
        return Promise.reject(
          new Error(
            'Linear team "ENG" has no `started`-type workflow state named "In Review". Run `tide setup` to provision it.'
          )
        );
      },
    });

    expect(code).toBe(1);
    expect(inReviewCalls).toBe(1);
  });

  test("`In Review` check receives the apiKey and teamKey from env+config", async () => {
    writeValidEnv();
    writeValidConfig();
    const calls: { apiKey: string; teamKey: string }[] = [];

    await doctor({
      repoRoot,
      runner: buildRunner(happyRunnerStub()),
      linearViewerCheck: () => Promise.resolve(),
      linearInReviewStateCheck: (ctx) => {
        calls.push({ apiKey: ctx.apiKey, teamKey: ctx.teamKey });
        return Promise.resolve();
      },
    });

    expect(calls).toEqual([{ apiKey: "lk", teamKey: "ENG" }]);
  });

  test("gh auth failure exits non-zero", async () => {
    writeValidEnv();
    writeValidConfig();
    const stub: RunnerStub = {
      calls: [],
      responses: {
        "gh auth status": { exitCode: 1, stdout: "" },
        "docker info": { exitCode: 0, stdout: "" },
        "gh repo view --json owner,name": {
          exitCode: 0,
          stdout: JSON.stringify({ owner: { login: "m1yon" }, name: "tide" }),
        },
      },
    };

    const code = await doctor({
      repoRoot,
      runner: buildRunner(stub),
      linearViewerCheck: () => Promise.resolve(),
      linearInReviewStateCheck: () => Promise.resolve(),
    });

    expect(code).toBe(1);
    const cmds = stub.calls.map((c) => [c.cmd, ...c.args].join(" "));
    expect(cmds).toContain("gh auth status");
  });

  test("missing .tide/.env yields a non-zero exit and skips Linear API check", async () => {
    writeValidConfig();
    let viewerCalls = 0;

    const code = await doctor({
      repoRoot,
      runner: buildRunner(happyRunnerStub()),
      linearViewerCheck: () => {
        viewerCalls += 1;
        return Promise.resolve();
      },
      linearInReviewStateCheck: () => Promise.resolve(),
    });

    expect(code).toBe(1);
    // Linear API check is gated on .env loading; missing .env should skip it.
    expect(viewerCalls).toBe(0);
  });

  test("missing required env key yields non-zero exit and skips Linear API check", async () => {
    writeFileSync(join(tideDir, ".env"), "ANTHROPIC_API_KEY=ak\n");
    writeValidConfig();
    let viewerCalls = 0;

    const code = await doctor({
      repoRoot,
      runner: buildRunner(happyRunnerStub()),
      linearViewerCheck: () => {
        viewerCalls += 1;
        return Promise.resolve();
      },
      linearInReviewStateCheck: () => Promise.resolve(),
    });

    expect(code).toBe(1);
    expect(viewerCalls).toBe(0);
  });

  test("missing .tide/config.ts yields a non-zero exit and skips In Review check", async () => {
    writeValidEnv();
    let inReviewCalls = 0;

    const code = await doctor({
      repoRoot,
      runner: buildRunner(happyRunnerStub()),
      linearViewerCheck: () => Promise.resolve(),
      linearInReviewStateCheck: () => {
        inReviewCalls += 1;
        return Promise.resolve();
      },
    });

    expect(code).toBe(1);
    expect(inReviewCalls).toBe(0);
  });

  test("docker daemon unreachable yields a non-zero exit", async () => {
    writeValidEnv();
    writeValidConfig();
    const stub: RunnerStub = {
      calls: [],
      responses: {
        "gh auth status": { exitCode: 0, stdout: "" },
        "docker info": { exitCode: 1, stdout: "" },
        "gh repo view --json owner,name": {
          exitCode: 0,
          stdout: JSON.stringify({ owner: { login: "m1yon" }, name: "tide" }),
        },
      },
    };

    const code = await doctor({
      repoRoot,
      runner: buildRunner(stub),
      linearViewerCheck: () => Promise.resolve(),
      linearInReviewStateCheck: () => Promise.resolve(),
    });

    expect(code).toBe(1);
    const cmds = stub.calls.map((c) => [c.cmd, ...c.args].join(" "));
    expect(cmds).toContain("docker info");
  });

  test("Linear API failure yields a non-zero exit", async () => {
    writeValidEnv();
    writeValidConfig();
    let viewerCalls = 0;

    const code = await doctor({
      repoRoot,
      runner: buildRunner(happyRunnerStub()),
      linearViewerCheck: () => {
        viewerCalls += 1;
        return Promise.reject(new Error("invalid api key"));
      },
      linearInReviewStateCheck: () => Promise.resolve(),
    });

    expect(code).toBe(1);
    expect(viewerCalls).toBe(1);
  });

  test("gh repo identity failure yields a non-zero exit", async () => {
    writeValidEnv();
    writeValidConfig();
    const stub: RunnerStub = {
      calls: [],
      responses: {
        "gh auth status": { exitCode: 0, stdout: "" },
        "docker info": { exitCode: 0, stdout: "" },
        "gh repo view --json owner,name": {
          exitCode: 1,
          stdout: "",
          stderr: "no remote",
        },
      },
    };

    const code = await doctor({
      repoRoot,
      runner: buildRunner(stub),
      linearViewerCheck: () => Promise.resolve(),
      linearInReviewStateCheck: () => Promise.resolve(),
    });

    expect(code).toBe(1);
    const cmds = stub.calls.map((c) => [c.cmd, ...c.args].join(" "));
    expect(cmds).toContain("gh repo view --json owner,name");
  });

  test("invoked outside any git repo exits non-zero", async () => {
    const lonely = join(workDir, "lonely");
    mkdirSync(lonely, { recursive: true });

    const originalCwd = process.cwd();
    let code: number;
    try {
      process.chdir(lonely);
      code = await doctor({
        runner: buildRunner(happyRunnerStub()),
        linearViewerCheck: () => Promise.resolve(),
        linearInReviewStateCheck: () => Promise.resolve(),
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(code).toBe(1);
  });
});
