import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "./init.ts";

describe("tide init", () => {
  let workDir: string;
  let repoRoot: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];
  const captureStdout = (s: string): void => {
    stdoutChunks.push(s);
  };
  const captureStderr = (s: string): void => {
    stderrChunks.push(s);
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tide-init-"));
    repoRoot = join(workDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    stdoutChunks = [];
    stderrChunks = [];
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("creates .tide/ with all five files at the discovered repo root", () => {
    const code = init({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
    });
    expect(code).toBe(0);

    const tideDir = join(repoRoot, ".tide");
    expect(existsSync(join(tideDir, "config.ts"))).toBe(true);
    expect(existsSync(join(tideDir, "Dockerfile"))).toBe(true);
    expect(existsSync(join(tideDir, "prompt.md"))).toBe(true);
    expect(existsSync(join(tideDir, ".env.example"))).toBe(true);
    expect(existsSync(join(tideDir, ".gitignore"))).toBe(true);
  });

  test("config.ts template references linear.team as the required field", () => {
    init({ repoRoot, stdout: captureStdout, stderr: captureStderr });
    const config = readFileSync(join(repoRoot, ".tide", "config.ts"), "utf8");
    expect(config).toContain("linear");
    expect(config).toContain("team");
    expect(config).toContain("REPLACE_ME");
  });

  test("Dockerfile template is debian-based and includes bun, git, gh, claude-code", () => {
    init({ repoRoot, stdout: captureStdout, stderr: captureStderr });
    const dockerfile = readFileSync(
      join(repoRoot, ".tide", "Dockerfile"),
      "utf8"
    );
    expect(dockerfile).toContain("FROM debian");
    expect(dockerfile.toLowerCase()).toContain("bun");
    expect(dockerfile).toContain("git");
    expect(dockerfile).toContain("gh");
    expect(dockerfile.toLowerCase()).toContain("claude-code");
  });

  test("prompt.md template contains all six placeholders", () => {
    init({ repoRoot, stdout: captureStdout, stderr: captureStderr });
    const prompt = readFileSync(join(repoRoot, ".tide", "prompt.md"), "utf8");
    expect(prompt).toContain("{{ISSUE_ID}}");
    expect(prompt).toContain("{{ISSUE_TITLE}}");
    expect(prompt).toContain("{{ISSUE_CONTENT}}");
    expect(prompt).toContain("{{PRD_CONTENT}}");
    expect(prompt).toContain("{{PARENT_ID}}");
    expect(prompt).toContain("{{BRANCH}}");
  });

  test(".env.example documents the required key plus both auth alternatives", () => {
    init({ repoRoot, stdout: captureStdout, stderr: captureStderr });
    const envExample = readFileSync(
      join(repoRoot, ".tide", ".env.example"),
      "utf8"
    );
    expect(envExample).toContain("LINEAR_API_KEY");
    expect(envExample).toContain("ANTHROPIC_API_KEY");
    expect(envExample).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(envExample).toContain("Set ONE");
  });

  test(".gitignore excludes .env, worktrees/, logs/", () => {
    init({ repoRoot, stdout: captureStdout, stderr: captureStderr });
    const gitignore = readFileSync(
      join(repoRoot, ".tide", ".gitignore"),
      "utf8"
    );
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain("worktrees/");
    expect(gitignore).toContain("logs/");
  });

  test("refuses and exits non-zero when any target file already exists", () => {
    const tideDir = join(repoRoot, ".tide");
    mkdirSync(tideDir, { recursive: true });
    writeFileSync(join(tideDir, "config.ts"), "// pre-existing\n");

    const code = init({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
    });
    expect(code).toBe(1);
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("config.ts");
    expect(stderr.toLowerCase()).toContain("refus");
  });

  test("error message lists all conflicting files when multiple exist", () => {
    const tideDir = join(repoRoot, ".tide");
    mkdirSync(tideDir, { recursive: true });
    writeFileSync(join(tideDir, "config.ts"), "// x\n");
    writeFileSync(join(tideDir, "Dockerfile"), "# x\n");

    const code = init({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
    });
    expect(code).toBe(1);
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("config.ts");
    expect(stderr).toContain("Dockerfile");
  });

  test("does not require .tide/config.ts to exist before running", () => {
    // Implicit in the basic happy path, but stated explicitly here.
    expect(existsSync(join(repoRoot, ".tide", "config.ts"))).toBe(false);
    const code = init({
      repoRoot,
      stdout: captureStdout,
      stderr: captureStderr,
    });
    expect(code).toBe(0);
    expect(existsSync(join(repoRoot, ".tide", "config.ts"))).toBe(true);
  });

  test("errors with a non-zero exit code when not inside a git repo", () => {
    const lonely = join(workDir, "lonely");
    mkdirSync(lonely, { recursive: true });

    // Use the real repo-discovery (no repoRoot override) by changing cwd.
    const originalCwd = process.cwd();
    try {
      process.chdir(lonely);
      const code = init({
        stdout: captureStdout,
        stderr: captureStderr,
      });
      expect(code).toBe(1);
      expect(stderrChunks.join("")).toContain("not inside a git repository");
    } finally {
      process.chdir(originalCwd);
    }
  });
});
