// PR submission tail-step for `tide run`.
//
// After `runIssueQueue` succeeds, `tideRun` calls `runPrSubmission` to push
// the feature branch host-side and fire a single Sandcastle iteration whose
// only job is to open a PR via `gh pr create`. Success is verified host-side
// via `gh pr list --head <branch>` (the iteration produces no commit, so the
// runner's commit-based isFailedRun heuristic is not reused).
//
// This is the foundation tracer per issue #8 — a placeholder PR body with
// just `Closes #<PRD>` is sufficient. The rich interface-emphasizing
// template lands in a follow-up issue.
//
// Scope: only the "opened" path. The "updated" path (re-run with an existing
// PR), the rev-list gate, the clack confirm, and the bundled rich template
// are all out of scope for this slice.

import { spawn } from "node:child_process";
import { log } from "@clack/prompts";
import { run as defaultSandcastleRun, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import type { TideConfig } from "../config-loader/index.ts";
import type { GhRepo } from "../github/index.ts";

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ShellRunner = (
  cmd: string,
  args: readonly string[],
  cwd: string
) => Promise<ShellResult>;

export type SandcastleRun = typeof defaultSandcastleRun;

export interface RunPrSubmissionOptions {
  ghRepo: GhRepo;
  branch: string;
  baseBranch: string;
  parentNumber: number;
  parentTitle: string;
  repoRoot: string;
  config: TideConfig;
  // Env map intended for the docker sandbox. Caller is responsible for
  // stripping LINEAR_API_KEY (matches the queue runner's contract).
  sandboxEnv: Record<string, string>;
  // Test seams.
  shellRunner?: ShellRunner;
  sandcastleRun?: SandcastleRun;
}

export interface PrSubmissionResult {
  url: string;
  action: "opened";
}

async function defaultShellRunner(
  cmd: string,
  args: readonly string[],
  cwd: string
): Promise<ShellResult> {
  return await new Promise<ShellResult>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * Count how many commits `branch` is ahead of `baseBranch` via
 * `git rev-list --count <baseBranch>..<branch>`. Used host-side as the gate
 * before invoking the PR-submission iteration: a zero-commits branch can't
 * produce a meaningful PR.
 */
export async function countCommitsAhead(
  repoRoot: string,
  baseBranch: string,
  branch: string,
  shellRunner: ShellRunner = defaultShellRunner
): Promise<number> {
  const range = `${baseBranch}..${branch}`;
  const r = await shellRunner("git", ["rev-list", "--count", range], repoRoot);
  if (r.exitCode !== 0) {
    const stderr = r.stderr.trim();
    throw new Error(
      `tide: \`git rev-list --count ${range}\` failed (exit ${String(r.exitCode)})${stderr === "" ? "" : `: ${stderr}`}`
    );
  }
  const trimmed = r.stdout.trim();
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== trimmed) {
    throw new Error(
      `tide: \`git rev-list --count ${range}\` returned non-numeric output: ${trimmed}`
    );
  }
  return n;
}

/**
 * Capture the current branch via `git rev-parse --abbrev-ref HEAD`. Throws
 * with a clear message on detached HEAD ("HEAD") so the caller can fail fast
 * before any Sandcastle work runs.
 */
export async function resolveBaseBranch(
  repoRoot: string,
  shellRunner: ShellRunner = defaultShellRunner
): Promise<string> {
  const r = await shellRunner(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    repoRoot
  );
  if (r.exitCode !== 0) {
    const stderr = r.stderr.trim();
    throw new Error(
      `tide: \`git rev-parse --abbrev-ref HEAD\` failed (exit ${String(r.exitCode)})${stderr === "" ? "" : `: ${stderr}`}`
    );
  }
  const branch = r.stdout.trim();
  if (branch === "" || branch === "HEAD") {
    throw new Error(
      "tide: detached HEAD detected. Check out a branch before running `tide run`."
    );
  }
  return branch;
}

const PR_PROMPT_TEMPLATE = `You are submitting a pull request for parent issue #{{PARENT_ID}}: {{PARENT_TITLE}}.

The current working branch is \`{{BRANCH}}\` (already pushed to origin). Open a pull request against the base branch \`{{BASE_BRANCH}}\` for the repository \`{{REPO_OWNER}}/{{REPO_NAME}}\`.

Use the following exact PR body (it includes the \`Closes #{{PARENT_ID}}\` reference so merging the PR auto-closes the parent issue):

----- BEGIN PR BODY -----
{{PR_BODY}}
----- END PR BODY -----

Suggested PR title (you may refine based on the diff, but keep it concise and descriptive):
  {{PR_TITLE}}

Run \`gh pr create\` against the right base. A safe invocation:

  gh pr create \\
    --repo {{REPO_OWNER}}/{{REPO_NAME}} \\
    --base {{BASE_BRANCH}} \\
    --head {{BRANCH}} \\
    --title "<your title here>" \\
    --body-file <(cat <<'EOF'
{{PR_BODY}}
EOF
)

When the PR has been opened successfully, emit <promise>COMPLETE</promise> and exit. Do not edit any files in the working tree.
`;

function buildPrompt(opts: {
  parentNumber: number;
  parentTitle: string;
  branch: string;
  baseBranch: string;
  ghRepo: GhRepo;
}): string {
  const placeholderTitle = `tide: ${opts.parentTitle}`;
  const placeholderBody = `Closes #${String(opts.parentNumber)}\n\nAutomated submission for parent issue #${String(opts.parentNumber)}: ${opts.parentTitle}.`;
  return PR_PROMPT_TEMPLATE.replaceAll(
    "{{PARENT_ID}}",
    String(opts.parentNumber)
  )
    .replaceAll("{{PARENT_TITLE}}", opts.parentTitle)
    .replaceAll("{{BRANCH}}", opts.branch)
    .replaceAll("{{BASE_BRANCH}}", opts.baseBranch)
    .replaceAll("{{REPO_OWNER}}", opts.ghRepo.owner)
    .replaceAll("{{REPO_NAME}}", opts.ghRepo.repo)
    .replaceAll("{{PR_TITLE}}", placeholderTitle)
    .replaceAll("{{PR_BODY}}", placeholderBody);
}

interface PrListItem {
  url: string;
  number: number;
}

function parsePrList(stdout: string): PrListItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `tide: \`gh pr list\` produced non-JSON output: ${stdout.trim()}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`tide: \`gh pr list\` returned a non-array payload.`);
  }
  const out: PrListItem[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const url = obj.url;
    const number = obj.number;
    if (typeof url === "string" && typeof number === "number") {
      out.push({ url, number });
    }
  }
  return out;
}

/**
 * Push the branch to origin, fire a single Sandcastle iteration whose only
 * job is to open the PR via `gh pr create`, and verify the result by listing
 * PRs for the branch on the host. Throws on push failure, iteration error,
 * or empty post-iteration PR list.
 */
export async function runPrSubmission(
  options: RunPrSubmissionOptions
): Promise<PrSubmissionResult> {
  const {
    ghRepo,
    branch,
    baseBranch,
    parentNumber,
    parentTitle,
    repoRoot,
    config,
    sandboxEnv,
    shellRunner = defaultShellRunner,
    sandcastleRun = defaultSandcastleRun,
  } = options;

  // Step 1: push the branch to origin host-side. Surfacing push errors here
  // (rather than wrapping them inside an LLM iteration failure) keeps the
  // failure mode legible.
  log.info(`Pushing ${branch} to origin`);
  const pushResult = await shellRunner(
    "git",
    ["push", "-u", "origin", branch],
    repoRoot
  );
  if (pushResult.exitCode !== 0) {
    const stderr = pushResult.stderr.trim();
    throw new Error(
      `tide: \`git push -u origin ${branch}\` failed (exit ${String(pushResult.exitCode)})${stderr === "" ? "" : `: ${stderr}`}`
    );
  }

  // Step 2: fire the Sandcastle iteration with the bundled placeholder
  // prompt. Inline `prompt` (not `promptFile`) — the template ships in tide
  // source and is not user-editable.
  const prompt = buildPrompt({
    parentNumber,
    parentTitle,
    branch,
    baseBranch,
    ghRepo,
  });

  const sandbox = docker({
    mounts: config.sandbox.mounts,
    env: sandboxEnv,
  });

  try {
    // The iteration produces no commit by design — its output is observable
    // via `gh pr list` below, not via the RunResult, so we discard the result.
    await sandcastleRun({
      name: "tide-pr",
      cwd: repoRoot,
      sandbox,
      agent: claudeCode("claude-opus-4-7"),
      prompt,
      maxIterations: 1,
      branchStrategy: { type: "branch", branch },
      logging: { type: "stdout" },
      hooks: {
        sandbox: {
          onSandboxReady: config.hooks.onSandboxReady,
        },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`tide: PR submission iteration threw: ${msg}`, {
      cause: err,
    });
  }

  // Step 3: verify host-side that a PR now exists for the branch.
  const listResult = await shellRunner(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      `${ghRepo.owner}/${ghRepo.repo}`,
      "--head",
      branch,
      "--json",
      "number,url",
    ],
    repoRoot
  );
  if (listResult.exitCode !== 0) {
    const stderr = listResult.stderr.trim();
    throw new Error(
      `tide: \`gh pr list --head ${branch}\` failed (exit ${String(listResult.exitCode)})${stderr === "" ? "" : `: ${stderr}`}`
    );
  }

  const prs = parsePrList(listResult.stdout);
  const first = prs[0];
  if (first === undefined) {
    throw new Error(
      `tide: PR submission iteration completed but no PR was found on origin for branch ${branch}. Inspect the iteration log and re-run.`
    );
  }

  return { url: first.url, action: "opened" };
}
