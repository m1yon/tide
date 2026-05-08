import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create a fresh temp directory, run `git init` inside it, make an
 * initial commit, hand the directory to `body`, and clean up afterwards
 * — on both the success and the failure path. Used by the e2e harness
 * (Phase 5) and any module test that needs a real git repo on disk.
 *
 * The initial commit is required so that downstream operations like
 * `git rev-parse HEAD`, `git log`, and worktree creation see a valid
 * history. The committer identity is set with `-c` flags so the helper
 * works on machines where the user's global git config has not been
 * configured.
 */
export async function withTempRepo<T>(
  body: (repoRoot: string) => Promise<T>
): Promise<T> {
  const repoRoot = mkdtempSync(join(tmpdir(), "tide-test-repo-"));
  try {
    runGit(repoRoot, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repoRoot, ".gitkeep"), "");
    runGit(repoRoot, ["add", ".gitkeep"]);
    runGit(repoRoot, [
      "-c",
      "user.email=tide-test@example.invalid",
      "-c",
      "user.name=tide test",
      "commit",
      "-q",
      "-m",
      "initial commit",
    ]);
    return await body(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

/**
 * Strip git-related environment variables before invoking the child
 * process. When tests run inside a git pre-commit hook, git sets
 * `GIT_DIR` / `GIT_INDEX_FILE` / etc. on the child env; those override
 * the `-C` flag and make `git init` operate on the host repo. Removing
 * them keeps the helper usable from `bun run test` invoked by husky.
 */
function gitCleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_")) continue;
    env[k] = v;
  }
  return env;
}

function runGit(repoRoot: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    env: gitCleanEnv(),
  });
  if (result.status !== 0) {
    throw new Error(
      `withTempRepo: git ${args.join(" ")} failed (exit ${String(
        result.status ?? "null"
      )}): ${result.stderr.trim()}`
    );
  }
}
