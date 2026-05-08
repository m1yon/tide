import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AppDependencies } from "../app-dependencies/index.ts";
import { InMemoryLinearService } from "../services/linear/index.ts";
import { InMemorySandcastleService } from "../services/sandcastle/index.ts";
import { runCli } from "./run-cli.ts";

type WriteFn = typeof process.stdout.write;

const placeholderDeps: AppDependencies = {
  linear: new InMemoryLinearService(),
  sandcastle: new InMemorySandcastleService(),
  gh: undefined,
};

describe("runCli", () => {
  let stdoutChunks: string[] = [];
  let stderrChunks: string[] = [];
  let originalStdoutWrite: WriteFn;
  let originalStderrWrite: WriteFn;

  beforeEach(() => {
    stdoutChunks = [];
    stderrChunks = [];
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    originalStderrWrite = process.stderr.write.bind(process.stderr);

    const captureStdout: WriteFn = (chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    const captureStderr: WriteFn = (chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    process.stdout.write = captureStdout;
    process.stderr.write = captureStderr;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  });

  test("empty argv prints help and exits 0", async () => {
    const code = await runCli([], placeholderDeps);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("tide <command>");
  });

  test("--help prints help and exits 0", async () => {
    const code = await runCli(["--help"], placeholderDeps);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("Usage:");
  });

  test("-h prints help and exits 0", async () => {
    const code = await runCli(["-h"], placeholderDeps);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("Usage:");
  });

  test("--version prints a non-empty version string and exits 0", async () => {
    const code = await runCli(["--version"], placeholderDeps);
    expect(code).toBe(0);
    expect(stdoutChunks.join("").trim().length).toBeGreaterThan(0);
  });

  test("uncompiled invocation reports `dev` for --version", async () => {
    const code = await runCli(["--version"], placeholderDeps);
    expect(code).toBe(0);
    expect(stdoutChunks.join("").trim()).toBe("dev");
  });

  test("unknown subcommand prints help to stderr and exits non-zero", async () => {
    const code = await runCli(["frobnicate"], placeholderDeps);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("unknown command");
  });

  test("help text lists the setup subcommand", async () => {
    const code = await runCli(["--help"], placeholderDeps);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("setup");
  });
});
