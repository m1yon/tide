import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { run } from "./index.ts";

type WriteFn = typeof process.stdout.write;

describe("tide cli dispatcher", () => {
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

  test("bare invocation prints help and exits 0", () => {
    const code = run(["bun", "tide"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("tide <command>");
  });

  test("--help prints help and exits 0", () => {
    const code = run(["bun", "tide", "--help"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("Usage:");
  });

  test("-h prints help and exits 0", () => {
    const code = run(["bun", "tide", "-h"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("Usage:");
  });

  test("--version prints a non-empty version string and exits 0", () => {
    const code = run(["bun", "tide", "--version"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("").trim().length).toBeGreaterThan(0);
  });

  test("uncompiled invocation reports `dev` for --version", () => {
    const code = run(["bun", "tide", "--version"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("").trim()).toBe("dev");
  });

  test("unknown subcommand prints help to stderr and exits non-zero", () => {
    const code = run(["bun", "tide", "frobnicate"]);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("unknown command");
  });
});
