import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { build, type StreamingRunner } from "./build.ts";

interface RunnerCall {
  cmd: string;
  args: readonly string[];
  cwd: string;
}

interface RunnerStub {
  calls: RunnerCall[];
  exitCode: number;
  stdoutChunks: readonly string[];
  stderrChunks: readonly string[];
}

function buildRunner(stub: RunnerStub): StreamingRunner {
  return (cmd, args, options) => {
    stub.calls.push({ cmd, args: [...args], cwd: options.cwd });
    for (const chunk of stub.stdoutChunks) {
      options.onStdout(chunk);
    }
    for (const chunk of stub.stderrChunks) {
      options.onStderr(chunk);
    }
    return Promise.resolve(stub.exitCode);
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
    pushStdout: (s: string) => {
      void s;
    },
    pushStderr: (s: string) => {
      void s;
    },
  };
  sinks.pushStdout = (s: string) => {
    sinks.stdout.push(s);
  };
  sinks.pushStderr = (s: string) => {
    sinks.stderr.push(s);
  };
  return sinks;
}

describe("tide build", () => {
  let workDir: string;
  let repoRoot: string;
  let tideDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tide-build-"));
    repoRoot = join(workDir, "repo");
    tideDir = join(repoRoot, ".tide");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(tideDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeDockerfile(): void {
    writeFileSync(join(tideDir, "Dockerfile"), "FROM scratch\n");
  }

  function writeValidConfig(): void {
    writeFileSync(
      join(tideDir, "config.ts"),
      `export default { linear: { team: "ENG" } };\n`
    );
  }

  test("happy path invokes docker build with the expected args and exits zero", async () => {
    writeDockerfile();
    writeValidConfig();
    const sinks = makeSinks();
    const stub: RunnerStub = {
      calls: [],
      exitCode: 0,
      stdoutChunks: [
        "Step 1/1 : FROM scratch\n",
        "Successfully built abc123\n",
      ],
      stderrChunks: [],
    };

    const code = await build({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      runner: buildRunner(stub),
    });

    expect(code).toBe(0);
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    if (call === undefined) throw new Error("missing runner call");
    expect(call.cmd).toBe("docker");
    expect(call.args[0]).toBe("build");
    expect(call.args).toContain("-t");
    expect(call.args).toContain("-f");
    // Build context is the repo root (the last positional arg).
    expect(call.args[call.args.length - 1]).toBe(repoRoot);
    expect(call.cwd).toBe(repoRoot);

    const out = sinks.stdout.join("");
    // Docker's stdout is forwarded.
    expect(out).toContain("Successfully built");
  });

  test("image name uses defaultImageName(repoRoot) — sandcastle:<dirname>", async () => {
    writeDockerfile();
    writeValidConfig();
    const sinks = makeSinks();
    const stub: RunnerStub = {
      calls: [],
      exitCode: 0,
      stdoutChunks: [],
      stderrChunks: [],
    };

    const code = await build({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      runner: buildRunner(stub),
    });

    expect(code).toBe(0);
    const call = stub.calls[0];
    if (call === undefined) throw new Error("missing runner call");
    const tIdx = call.args.indexOf("-t");
    expect(tIdx).toBeGreaterThanOrEqual(0);
    const imageName = call.args[tIdx + 1];
    const expected = `sandcastle:${basename(repoRoot).toLowerCase()}`;
    expect(imageName).toBe(expected);
  });

  test("dockerfile arg is the absolute path to <repoRoot>/.tide/Dockerfile", async () => {
    writeDockerfile();
    writeValidConfig();
    const sinks = makeSinks();
    const stub: RunnerStub = {
      calls: [],
      exitCode: 0,
      stdoutChunks: [],
      stderrChunks: [],
    };

    await build({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      runner: buildRunner(stub),
    });

    const call = stub.calls[0];
    if (call === undefined) throw new Error("missing runner call");
    const fIdx = call.args.indexOf("-f");
    expect(fIdx).toBeGreaterThanOrEqual(0);
    const dockerfileArg = call.args[fIdx + 1];
    expect(dockerfileArg).toBe(resolve(join(repoRoot, ".tide", "Dockerfile")));
  });

  test("missing Dockerfile yields a non-zero exit and a clear error", async () => {
    writeValidConfig();
    const sinks = makeSinks();
    const stub: RunnerStub = {
      calls: [],
      exitCode: 0,
      stdoutChunks: [],
      stderrChunks: [],
    };

    const code = await build({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      runner: buildRunner(stub),
    });

    expect(code).toBe(1);
    expect(stub.calls).toHaveLength(0);
    expect(sinks.stderr.join("")).toContain("Dockerfile not found");
  });

  test("missing config.ts yields a non-zero exit before docker is invoked", async () => {
    writeDockerfile();
    const sinks = makeSinks();
    const stub: RunnerStub = {
      calls: [],
      exitCode: 0,
      stdoutChunks: [],
      stderrChunks: [],
    };

    const code = await build({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      runner: buildRunner(stub),
    });

    expect(code).toBe(1);
    expect(stub.calls).toHaveLength(0);
    expect(sinks.stderr.join("")).toContain("config file not found");
  });

  test("malformed config (Zod fails) yields a non-zero exit before docker is invoked", async () => {
    writeDockerfile();
    writeFileSync(
      join(tideDir, "config.ts"),
      `export default { linear: {} };\n`
    );
    const sinks = makeSinks();
    const stub: RunnerStub = {
      calls: [],
      exitCode: 0,
      stdoutChunks: [],
      stderrChunks: [],
    };

    const code = await build({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      runner: buildRunner(stub),
    });

    expect(code).toBe(1);
    expect(stub.calls).toHaveLength(0);
  });

  test("docker build failure propagates the non-zero exit code with stderr forwarded", async () => {
    writeDockerfile();
    writeValidConfig();
    const sinks = makeSinks();
    const stub: RunnerStub = {
      calls: [],
      exitCode: 2,
      stdoutChunks: [],
      stderrChunks: ["Error response from daemon: ...\n"],
    };

    const code = await build({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      runner: buildRunner(stub),
    });

    expect(code).toBe(2);
    expect(sinks.stderr.join("")).toContain("Error response from daemon");
    expect(sinks.stderr.join("")).toContain("docker build failed");
  });

  test("invoked outside any git repo errors clearly without a stack trace", async () => {
    const lonely = join(workDir, "lonely");
    mkdirSync(lonely, { recursive: true });
    const sinks = makeSinks();
    const stub: RunnerStub = {
      calls: [],
      exitCode: 0,
      stdoutChunks: [],
      stderrChunks: [],
    };

    const originalCwd = process.cwd();
    let code: number;
    try {
      process.chdir(lonely);
      code = await build({
        stdout: sinks.pushStdout,
        stderr: sinks.pushStderr,
        runner: buildRunner(stub),
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(code).toBe(1);
    expect(stub.calls).toHaveLength(0);
    expect(sinks.stderr.join("")).toContain("not inside a git repository");
  });

  test("works from a subdirectory of the repo (via repo-discovery)", async () => {
    writeDockerfile();
    writeValidConfig();
    const subDir = join(repoRoot, "deep", "nested");
    mkdirSync(subDir, { recursive: true });
    const sinks = makeSinks();
    const stub: RunnerStub = {
      calls: [],
      exitCode: 0,
      stdoutChunks: [],
      stderrChunks: [],
    };

    const originalCwd = process.cwd();
    let code: number;
    try {
      process.chdir(subDir);
      code = await build({
        // No repoRoot override — exercise discoverRepoRoot.
        stdout: sinks.pushStdout,
        stderr: sinks.pushStderr,
        runner: buildRunner(stub),
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(code).toBe(0);
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    if (call === undefined) throw new Error("missing runner call");
    // Build context is the discovered repo root, not the subdirectory.
    expect(call.args[call.args.length - 1]).toBe(resolve(repoRoot));
  });
});
