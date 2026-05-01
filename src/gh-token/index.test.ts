import { describe, expect, test } from "bun:test";
import { getGhToken, type Runner } from "./index.ts";

function fakeRunner(result: {
  exitCode: number;
  stdout: string;
  stderr?: string;
}): Runner {
  return () =>
    Promise.resolve({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr ?? "",
    });
}

async function captureError<T>(p: Promise<T>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
}

describe("gh-token", () => {
  test("returns the trimmed token on zero exit", async () => {
    const runner = fakeRunner({
      exitCode: 0,
      stdout: "ghp_abc123\n",
    });
    const token = await getGhToken({ repoRoot: "/r" }, runner);
    expect(token).toBe("ghp_abc123");
  });

  test("throws when gh exits non-zero, with hint pointing at gh auth login", async () => {
    const runner = fakeRunner({
      exitCode: 1,
      stdout: "",
      stderr: "no oauth token",
    });
    const err = await captureError(getGhToken({ repoRoot: "/r" }, runner));
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/gh auth token.*failed/);
    expect(msg).toContain("gh auth login");
    expect(msg).toContain("no oauth token");
  });

  test("throws when stdout is empty (zero exit) with hint pointing at gh auth login", async () => {
    const runner = fakeRunner({ exitCode: 0, stdout: "   \n" });
    const err = await captureError(getGhToken({ repoRoot: "/r" }, runner));
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("empty");
    expect(msg).toContain("gh auth login");
  });

  test("invokes gh with the configured cwd and --hostname github.com", async () => {
    let capturedCwd: string | undefined;
    let capturedArgs: readonly string[] | undefined;
    let capturedCmd: string | undefined;
    const runner: Runner = (cmd, args, cwd) => {
      capturedCmd = cmd;
      capturedCwd = cwd;
      capturedArgs = args;
      return Promise.resolve({
        exitCode: 0,
        stdout: "ghp_xyz\n",
        stderr: "",
      });
    };

    await getGhToken({ repoRoot: "/some/repo" }, runner);

    expect(capturedCmd).toBe("gh");
    expect(capturedCwd).toBe("/some/repo");
    expect(capturedArgs).toEqual(["auth", "token", "--hostname", "github.com"]);
  });
});
