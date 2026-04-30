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
      // assigned below
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

  function happyRunner(): Runner {
    return buildRunner({
      calls: [],
      responses: {
        "gh auth status": { exitCode: 0, stdout: "" },
        "docker info": { exitCode: 0, stdout: "" },
        "gh repo view --json owner,name": {
          exitCode: 0,
          stdout: JSON.stringify({ owner: { login: "m1yon" }, name: "tide" }),
        },
      },
    });
  }

  test("all checks pass — exits zero, prints version, prints all-passed line", async () => {
    writeValidEnv();
    writeValidConfig();
    const sinks = makeSinks();

    const code = await doctor({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      runner: happyRunner(),
      linearViewerCheck: () => Promise.resolve(),
    });

    expect(code).toBe(0);
    const out = sinks.stdout.join("");
    expect(out).toContain("gh auth");
    expect(out).toContain(".tide/.env");
    expect(out).toContain(".tide/config.ts");
    expect(out).toContain("docker daemon");
    expect(out).toContain("Linear API");
    expect(out).toContain("gh repo identity");
    expect(out).toContain("tide version");
    expect(out).toContain("all checks passed");
  });

  test("gh auth failure exits non-zero with a remediation hint", async () => {
    writeValidEnv();
    writeValidConfig();
    const sinks = makeSinks();
    const runner = buildRunner({
      calls: [],
      responses: {
        "gh auth status": { exitCode: 1, stdout: "" },
        "docker info": { exitCode: 0, stdout: "" },
        "gh repo view --json owner,name": {
          exitCode: 0,
          stdout: JSON.stringify({ owner: { login: "m1yon" }, name: "tide" }),
        },
      },
    });

    const code = await doctor({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      runner,
      linearViewerCheck: () => Promise.resolve(),
    });

    expect(code).toBe(1);
    expect(sinks.stderr.join("")).toContain("gh auth login");
  });

  test("missing .tide/.env yields a non-zero exit and clear hint", async () => {
    writeValidConfig();
    const sinks = makeSinks();

    const code = await doctor({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      runner: happyRunner(),
      linearViewerCheck: () => Promise.resolve(),
    });

    expect(code).toBe(1);
    expect(sinks.stderr.join("")).toContain("env file not found");
  });

  test("missing required env key yields a non-zero exit and names the key", async () => {
    writeFileSync(join(tideDir, ".env"), "ANTHROPIC_API_KEY=ak\n");
    writeValidConfig();
    const sinks = makeSinks();

    const code = await doctor({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      runner: happyRunner(),
      linearViewerCheck: () => Promise.resolve(),
    });

    expect(code).toBe(1);
    expect(sinks.stderr.join("")).toContain("LINEAR_API_KEY");
  });

  test("missing .tide/config.ts yields a non-zero exit", async () => {
    writeValidEnv();
    const sinks = makeSinks();

    const code = await doctor({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      runner: happyRunner(),
      linearViewerCheck: () => Promise.resolve(),
    });

    expect(code).toBe(1);
    expect(sinks.stderr.join("")).toContain("config file not found");
  });

  test("docker daemon unreachable yields a non-zero exit and clear hint", async () => {
    writeValidEnv();
    writeValidConfig();
    const sinks = makeSinks();
    const runner = buildRunner({
      calls: [],
      responses: {
        "gh auth status": { exitCode: 0, stdout: "" },
        "docker info": { exitCode: 1, stdout: "" },
        "gh repo view --json owner,name": {
          exitCode: 0,
          stdout: JSON.stringify({ owner: { login: "m1yon" }, name: "tide" }),
        },
      },
    });

    const code = await doctor({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      runner,
      linearViewerCheck: () => Promise.resolve(),
    });

    expect(code).toBe(1);
    expect(sinks.stderr.join("")).toContain("Docker daemon");
  });

  test("Linear API failure yields a non-zero exit with the underlying message", async () => {
    writeValidEnv();
    writeValidConfig();
    const sinks = makeSinks();

    const code = await doctor({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      runner: happyRunner(),
      linearViewerCheck: () => Promise.reject(new Error("invalid api key")),
    });

    expect(code).toBe(1);
    expect(sinks.stderr.join("")).toContain("invalid api key");
  });

  test("gh repo identity failure yields a non-zero exit", async () => {
    writeValidEnv();
    writeValidConfig();
    const sinks = makeSinks();
    const runner = buildRunner({
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
    });

    const code = await doctor({
      repoRoot,
      stdout: sinks.pushStdout,
      stderr: sinks.pushStderr,
      runner,
      linearViewerCheck: () => Promise.resolve(),
    });

    expect(code).toBe(1);
    expect(sinks.stderr.join("")).toContain("gh repo view");
  });

  test("invoked outside any git repo errors clearly without a stack trace", async () => {
    const lonely = join(workDir, "lonely");
    mkdirSync(lonely, { recursive: true });
    const sinks = makeSinks();

    const originalCwd = process.cwd();
    let code: number;
    try {
      process.chdir(lonely);
      code = await doctor({
        stdout: sinks.pushStdout,
        stderr: sinks.pushStderr,
        runner: happyRunner(),
        linearViewerCheck: () => Promise.resolve(),
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(code).toBe(1);
    expect(sinks.stderr.join("")).toContain("not inside a git repository");
  });
});
