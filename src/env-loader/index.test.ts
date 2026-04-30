import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, parseEnvText } from "./index.ts";

describe("env-loader", () => {
  let workDir: string;
  let repoRoot: string;
  let tideDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tide-env-loader-"));
    repoRoot = join(workDir, "repo");
    tideDir = join(repoRoot, ".tide");
    mkdirSync(tideDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeEnv(content: string): void {
    writeFileSync(join(tideDir, ".env"), content);
  }

  test("file present with both required keys returns the parsed map", () => {
    writeEnv("LINEAR_API_KEY=lk\nANTHROPIC_API_KEY=ak\n");
    const env = loadEnv({ repoRoot });
    expect(env).toEqual({ LINEAR_API_KEY: "lk", ANTHROPIC_API_KEY: "ak" });
  });

  test("file missing yields a clear error naming the path", () => {
    expect(() => loadEnv({ repoRoot })).toThrow(/env file not found/);
    expect(() => loadEnv({ repoRoot })).toThrow(/\.tide\/\.env/);
  });

  test("file present but missing LINEAR_API_KEY yields an error naming the missing key", () => {
    writeEnv("ANTHROPIC_API_KEY=ak\n");
    let err: unknown = null;
    try {
      loadEnv({ repoRoot });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("missing required key");
    expect(msg).toContain("LINEAR_API_KEY");
  });

  test("file present but missing ANTHROPIC_API_KEY yields an error naming the missing key", () => {
    writeEnv("LINEAR_API_KEY=lk\n");
    let err: unknown = null;
    try {
      loadEnv({ repoRoot });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("ANTHROPIC_API_KEY");
  });

  test("malformed lines yield a parse error with line context", () => {
    writeEnv("LINEAR_API_KEY=lk\nthis_is_not_valid\nANTHROPIC_API_KEY=ak\n");
    let err: unknown = null;
    try {
      loadEnv({ repoRoot });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("malformed line");
    expect(msg).toContain("2");
  });

  test("repo-specific keys pass through unchanged", () => {
    writeEnv(
      "LINEAR_API_KEY=lk\nANTHROPIC_API_KEY=ak\nAWS_PROFILE=dev\nAWS_REGION=us-east-1\n"
    );
    const env = loadEnv({ repoRoot });
    expect(env).toEqual({
      LINEAR_API_KEY: "lk",
      ANTHROPIC_API_KEY: "ak",
      AWS_PROFILE: "dev",
      AWS_REGION: "us-east-1",
    });
  });

  test("comments and blank lines are ignored", () => {
    writeEnv(
      [
        "# top comment",
        "",
        "LINEAR_API_KEY=lk",
        "  # indented comment",
        "ANTHROPIC_API_KEY=ak",
        "",
      ].join("\n")
    );
    const env = loadEnv({ repoRoot });
    expect(env).toEqual({ LINEAR_API_KEY: "lk", ANTHROPIC_API_KEY: "ak" });
  });

  test("quoted values have surrounding quotes stripped", () => {
    expect(parseEnvText("A=\"hello\"\nB='world'\n")).toEqual({
      A: "hello",
      B: "world",
    });
  });

  test("empty key yields a parse error", () => {
    expect(() => parseEnvText("=value\n")).toThrow(/empty key/);
  });

  test("parseEnvText reports the file path in errors", () => {
    expect(() => parseEnvText("oops\n", "/x/.tide/.env")).toThrow(
      /\/x\/\.tide\/\.env/
    );
  });
});
