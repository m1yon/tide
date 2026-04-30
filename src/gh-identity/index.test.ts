import { describe, expect, test } from "bun:test";
import { getGhIdentity, type Runner } from "./index.ts";

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

describe("gh-identity", () => {
  test("parses object-form owner ({login: ...})", async () => {
    const runner = fakeRunner({
      exitCode: 0,
      stdout: JSON.stringify({ owner: { login: "m1yon" }, name: "tide" }),
    });
    const id = await getGhIdentity({ repoRoot: "/r" }, runner);
    expect(id).toEqual({ owner: "m1yon", repo: "tide" });
  });

  test("parses string-form owner", async () => {
    const runner = fakeRunner({
      exitCode: 0,
      stdout: JSON.stringify({ owner: "m1yon", name: "tide" }),
    });
    const id = await getGhIdentity({ repoRoot: "/r" }, runner);
    expect(id).toEqual({ owner: "m1yon", repo: "tide" });
  });

  test("throws when gh exits non-zero", async () => {
    const runner = fakeRunner({
      exitCode: 1,
      stdout: "",
      stderr: "no remote configured",
    });
    const err = await captureError(getGhIdentity({ repoRoot: "/r" }, runner));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/gh repo view.*failed/);
  });

  test("includes stderr in the error message", async () => {
    const runner = fakeRunner({
      exitCode: 1,
      stdout: "",
      stderr: "no remote configured",
    });
    const err = await captureError(getGhIdentity({ repoRoot: "/r" }, runner));
    expect((err as Error).message).toContain("no remote configured");
  });

  test("throws when stdout is not JSON", async () => {
    const runner = fakeRunner({ exitCode: 0, stdout: "not json" });
    const err = await captureError(getGhIdentity({ repoRoot: "/r" }, runner));
    expect((err as Error).message).toContain("non-JSON");
  });

  test("throws when payload is missing owner", async () => {
    const runner = fakeRunner({
      exitCode: 0,
      stdout: JSON.stringify({ name: "tide" }),
    });
    const err = await captureError(getGhIdentity({ repoRoot: "/r" }, runner));
    expect((err as Error).message).toContain("missing owner");
  });

  test("throws when payload is missing name", async () => {
    const runner = fakeRunner({
      exitCode: 0,
      stdout: JSON.stringify({ owner: { login: "m1yon" } }),
    });
    const err = await captureError(getGhIdentity({ repoRoot: "/r" }, runner));
    expect((err as Error).message).toContain("missing name");
  });

  test("invokes gh with the configured cwd and JSON args", async () => {
    let capturedCwd: string | undefined;
    let capturedArgs: readonly string[] | undefined;
    const runner: Runner = (_cmd, args, cwd) => {
      capturedCwd = cwd;
      capturedArgs = args;
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({ owner: { login: "x" }, name: "y" }),
        stderr: "",
      });
    };

    await getGhIdentity({ repoRoot: "/some/repo" }, runner);

    expect(capturedCwd).toBe("/some/repo");
    expect(capturedArgs).toEqual(["repo", "view", "--json", "owner,name"]);
  });
});
