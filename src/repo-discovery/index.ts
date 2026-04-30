import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Walks up from `startDir` to the first directory containing a `.git/`
 * entry and returns its absolute path. Throws if no ancestor contains
 * `.git/` (i.e. we are not inside a git repository).
 *
 * `.git` may be a directory (normal repo) or a file (git worktrees use
 * a plain text file pointer). Both count as "this is a git repo."
 */
export function discoverRepoRoot(startDir: string = process.cwd()): string {
  const start = resolve(startDir);
  let current = start;

  // Walk up until we hit the filesystem root.
  for (;;) {
    const gitPath = resolve(current, ".git");
    if (existsSync(gitPath)) {
      // Either a directory (normal repo) or a file (worktree). Both are valid.
      const stat = statSync(gitPath);
      if (stat.isDirectory() || stat.isFile()) {
        return current;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `tide: not inside a git repository (searched from ${start} up to filesystem root)`
      );
    }
    current = parent;
  }
}
