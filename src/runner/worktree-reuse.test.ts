// Regression test for the patched @ai-hero/sandcastle WorktreeManager.create.
//
// Tide bridges `<repo>/.sandcastle` -> `<repo>/.tide` with a symlink so that
// sandcastle's hardcoded `.sandcastle/worktrees/...` paths land under `.tide/`.
// `git worktree list --porcelain` canonicalizes paths via realpath, so a
// pre-existing managed worktree comes back with a `.tide/` prefix.
//
// Before the patch, sandcastle compared collisions against the un-canonicalized
// `<repo>/.sandcastle/worktrees` prefix and treated the worktree as external,
// causing re-runs on the same parent issue to throw `Branch '<b>' is already
// checked out in worktree at '<path>'`. The patch resolves both prefixes and
// accepts either.
//
// This test sets up the bridge exactly like `ensureSandcastleSymlink` does,
// calls sandcastle's public `createWorktree` twice with the same branch, and
// asserts the second call reuses rather than throws.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree } from "@ai-hero/sandcastle";

function git(repo: string, args: readonly string[]): void {
  execFileSync("git", args as string[], { cwd: repo, stdio: "ignore" });
}

describe("sandcastle createWorktree under .sandcastle -> .tide symlink", () => {
  let workDir: string;
  let repoRoot: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tide-worktree-reuse-"));
    repoRoot = join(workDir, "repo");
    mkdirSync(repoRoot, { recursive: true });

    // Minimal git repo with one commit so worktree creation has a base ref.
    git(repoRoot, ["init", "-q", "-b", "main"]);
    git(repoRoot, ["config", "user.email", "test@example.com"]);
    git(repoRoot, ["config", "user.name", "Test"]);
    writeFileSync(join(repoRoot, "README.md"), "seed\n");
    git(repoRoot, ["add", "README.md"]);
    git(repoRoot, ["commit", "-q", "-m", "seed"]);

    // Mirror ensureSandcastleSymlink: .sandcastle is a relative symlink to .tide.
    mkdirSync(join(repoRoot, ".tide"), { recursive: true });
    symlinkSync(".tide", join(repoRoot, ".sandcastle"), "dir");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("second createWorktree on the same branch reuses the worktree", async () => {
    const branch = "tide/reuse-test";

    const first = await createWorktree({
      cwd: repoRoot,
      branchStrategy: { type: "branch", branch },
    });

    const second = await createWorktree({
      cwd: repoRoot,
      branchStrategy: { type: "branch", branch },
    });

    expect(second.branch).toBe(branch);
    // First returns the un-canonicalized path it joined; second returns the
    // realpath-canonicalized form from `git worktree list`. Both must resolve
    // to the same physical worktree.
    expect(realpathSync(second.worktreePath)).toBe(
      realpathSync(first.worktreePath)
    );

    await first.close();
  });
});
