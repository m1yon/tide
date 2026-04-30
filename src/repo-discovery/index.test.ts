import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverRepoRoot } from "./index.ts";

describe("repo-discovery", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tide-repo-discovery-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("cwd at repo root with `.git/` directory returns repo root", () => {
    const repoRoot = join(workDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });

    expect(discoverRepoRoot(repoRoot)).toBe(resolve(repoRoot));
  });

  test("cwd in nested subdirectory walks up to repo root", () => {
    const repoRoot = join(workDir, "repo");
    const nested = join(repoRoot, "a", "b", "c");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    expect(discoverRepoRoot(nested)).toBe(resolve(repoRoot));
  });

  test("cwd in a git worktree (where `.git` is a file, not a dir) returns repo root", () => {
    const repoRoot = join(workDir, "repo");
    mkdirSync(repoRoot, { recursive: true });
    // Worktrees have a `.git` file containing `gitdir: <path>` rather than a directory.
    writeFileSync(join(repoRoot, ".git"), "gitdir: /elsewhere\n");

    expect(discoverRepoRoot(repoRoot)).toBe(resolve(repoRoot));
  });

  test("cwd outside any git repo throws a clear error", () => {
    // workDir itself has no `.git/` and (assuming the system tmpdir is not
    // inside a git repo) no ancestor will either.
    const noRepo = join(workDir, "lonely");
    mkdirSync(noRepo, { recursive: true });

    expect(() => discoverRepoRoot(noRepo)).toThrow(
      /not inside a git repository/
    );
  });

  test("error message names the directory the search started from", () => {
    const noRepo = join(workDir, "lonely");
    mkdirSync(noRepo, { recursive: true });

    expect(() => discoverRepoRoot(noRepo)).toThrow(resolve(noRepo));
  });
});
