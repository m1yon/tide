// `tide run` — full PRD-rooted, Linear-tracked agent flow.
//
// Steps:
//   1. discover repo root → capture base branch (fail fast on detached HEAD)
//      → load config + env → resolve gh identity
//   2. fetch GitHub triage tree, single-select parent
//   3. fetch descendant subtree → topo-sort via dep-graph
//   4. resolve Linear issue (create-or-paste loop)
//   5. preflight summary + Y/n confirm
//   6. run Sandcastle iterations per sub-issue (single shared branch)
//   7. on success: open a PR against the captured base branch
//
// The agent itself closes its sub-issue via the prompt template; the runner
// makes no `gh issue close` call.

import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import {
  intro,
  outro,
  spinner,
  log,
  confirm,
  isCancel,
  cancel,
} from "@clack/prompts";
import { loadConfig, type TideConfig } from "../config-loader/index.ts";
import { loadEnv } from "../env-loader/index.ts";
import { type DepNode, topoSort } from "../dep-graph/index.ts";
import {
  fetchIssueStates,
  fetchSubtreeStates,
  fetchTriageTree,
  type GhRepo,
} from "../github/index.ts";
import { getGhIdentity } from "../gh-identity/index.ts";
import type { ParentForLinear } from "../linear/index.ts";
import {
  resolveBaseBranch,
  runPrSubmission as defaultRunPrSubmission,
  type PrSubmissionResult,
  type RunPrSubmissionOptions,
  type ShellRunner,
} from "../pr-submission/index.ts";
import { discoverRepoRoot } from "../repo-discovery/index.ts";
import { runIssueQueue } from "../runner/index.ts";
import { pickParent, resolveLinearIssue } from "../selector/index.ts";

export interface RunOptions {
  /** Repo root override (defaults to repo-discovery from cwd). */
  repoRoot?: string;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  /**
   * Test seam: shell runner used for the host-side base-branch capture
   * (`git rev-parse --abbrev-ref HEAD`). Defaults to a child_process spawn
   * inside the pr-submission module.
   */
  baseBranchShellRunner?: ShellRunner;
  /**
   * Test seam: PR submission entry point. Tests can stub this to avoid
   * actually pushing or invoking Sandcastle.
   */
  runPrSubmission?: (
    options: RunPrSubmissionOptions
  ) => Promise<PrSubmissionResult>;
}

export interface RunPrTailStepOptions {
  prCreationConfirmed: boolean;
  ghRepo: GhRepo;
  branch: string;
  baseBranch: string;
  parentNumber: number;
  parentTitle: string;
  repoRoot: string;
  config: TideConfig;
  sandboxEnv: Record<string, string>;
  completedCount: number;
  /** Test seam — defaults to the imported `runPrSubmission`. */
  runPrSubmission?: (
    options: RunPrSubmissionOptions
  ) => Promise<PrSubmissionResult>;
}

export type PrTailOutcome =
  | { kind: "opted-out" }
  | { kind: "opened"; url: string }
  | { kind: "failed"; message: string };

export interface PrTailStepResult {
  outcome: PrTailOutcome;
  outroMessage: string;
  exitCode: 0 | 1;
}

/**
 * Decide and execute the post-queue PR-submission tail step. Returns the
 * outro message and exit code so the caller (tideRun) can render UI
 * uniformly. The caller is expected to short-circuit on aborted runs before
 * invoking this helper; the only skip path handled here is the user's
 * pre-flight opt-out.
 */
export async function runPrTailStep(
  opts: RunPrTailStepOptions
): Promise<PrTailStepResult> {
  const completedSummary = `Completed ${String(opts.completedCount)} issue(s) on ${opts.branch}`;

  if (!opts.prCreationConfirmed) {
    return {
      outcome: { kind: "opted-out" },
      outroMessage: `Done. ${completedSummary}. PR step skipped (you opted out at pre-flight).`,
      exitCode: 0,
    };
  }

  const runPrSubmissionFn = opts.runPrSubmission ?? defaultRunPrSubmission;
  try {
    const prResult = await runPrSubmissionFn({
      ghRepo: opts.ghRepo,
      branch: opts.branch,
      baseBranch: opts.baseBranch,
      parentNumber: opts.parentNumber,
      parentTitle: opts.parentTitle,
      repoRoot: opts.repoRoot,
      config: opts.config,
      sandboxEnv: opts.sandboxEnv,
    });
    return {
      outcome: { kind: "opened", url: prResult.url },
      outroMessage: `Done. ${completedSummary}. PR opened: ${prResult.url}`,
      exitCode: 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      outcome: { kind: "failed", message },
      outroMessage: `Done. ${completedSummary}, but PR submission failed.`,
      exitCode: 1,
    };
  }
}

/**
 * Ensure that Sandcastle's hardcoded `.sandcastle/` directory points at the
 * tide-conventional `.tide/`. Sandcastle writes worktrees and logs under
 * `<repoRoot>/.sandcastle/{worktrees,logs}/`; we want them under `.tide/`
 * per the PRD. A symlink is the cleanest available mechanism — Sandcastle
 * already calls `realPath` to handle the symlinked case.
 */
function ensureSandcastleSymlink(repoRoot: string): void {
  const tideDir = path.join(repoRoot, ".tide");
  if (!existsSync(tideDir)) {
    // The .tide directory should always exist by the time `tide run` is
    // invoked (loadConfig would have errored otherwise), but be defensive.
    mkdirSync(tideDir, { recursive: true });
  }

  const sandcastleDir = path.join(repoRoot, ".sandcastle");
  if (existsSync(sandcastleDir)) {
    // If it exists, it's either our own symlink (good) or something the user
    // put there. If it's a symlink we trust it; if it's a real directory we
    // leave it alone (don't clobber user state).
    const stat = lstatSync(sandcastleDir);
    if (stat.isSymbolicLink()) return;
    return;
  }

  // Relative symlink so the repo can be moved without breaking the link.
  symlinkSync(".tide", sandcastleDir, "dir");
}

export async function tideRun(options: RunOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = options.stderr ?? ((s: string) => process.stderr.write(s));

  let repoRoot: string;
  try {
    repoRoot = options.repoRoot ?? discoverRepoRoot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  // Capture the base branch *before* any other work. This is the branch the
  // user invoked `tide run` from — it becomes the base for the PR opened at
  // the tail of the run. Failing fast on detached HEAD here avoids burning a
  // queue's worth of work only to discover the PR step can't proceed.
  let baseBranch: string;
  try {
    baseBranch = await resolveBaseBranch(
      repoRoot,
      options.baseBranchShellRunner
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  // Load config + env up front so failures surface before any UI.
  let config: TideConfig;
  try {
    config = await loadConfig({ repoRoot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  let envMap: Record<string, string>;
  try {
    envMap = loadEnv({ repoRoot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  // Host CLI uses LINEAR_API_KEY; do not forward it to the docker sandbox.
  const linearApiKey = envMap.LINEAR_API_KEY;
  if (typeof linearApiKey !== "string" || linearApiKey === "") {
    stderr(`tide: LINEAR_API_KEY is empty in .tide/.env\n`);
    return 1;
  }
  const sandboxEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(envMap)) {
    if (k === "LINEAR_API_KEY") continue;
    sandboxEnv[k] = v;
  }

  // Resolve GitHub identity from `gh repo view`.
  let ghRepo: GhRepo;
  try {
    ghRepo = await getGhIdentity({ repoRoot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  // Sandcastle writes worktrees/logs under `.sandcastle/`. Tide's convention
  // is `.tide/`. Bridge with a symlink so the SDK paths land in the right
  // place. (See PRD: "Sandcastle worktrees and logs land at .tide/...".)
  ensureSandcastleSymlink(repoRoot);

  intro("tide run");

  // Fetch the triage tree.
  const fetchSpin = spinner();
  fetchSpin.start("Fetching ready-for-agent issues from GitHub");
  let tree: Awaited<ReturnType<typeof fetchTriageTree>>;
  try {
    tree = await fetchTriageTree(ghRepo);
  } catch (err) {
    fetchSpin.stop("GitHub fetch failed");
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }
  fetchSpin.stop(`Fetched ${String(tree.length)} top-level issue(s)`);

  if (tree.length === 0) {
    outro("Nothing to triage. No open `ready-for-agent` issues.");
    stdout("");
    return 0;
  }

  const picked = await pickParent(tree);

  // Hydrate the descendant chain via GitHub (closed sub-issues may not be in
  // the labelled set if the label was dropped on close).
  const subtreeSpin = spinner();
  subtreeSpin.start(`Fetching descendants of #${String(picked.root.number)}`);
  let descendants: Awaited<ReturnType<typeof fetchSubtreeStates>>;
  try {
    descendants = await fetchSubtreeStates(ghRepo, picked.root.number);
  } catch (err) {
    subtreeSpin.stop("Descendant fetch failed");
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }
  subtreeSpin.stop(`Found ${String(descendants.length)} descendant(s)`);

  // If the parent has no descendants in GitHub, treat the parent itself as
  // the unit of work. Resolve closed blockers off its blockedBy list (those
  // can't block anything).
  let depNodes: DepNode[];
  if (descendants.length === 0) {
    let parentBlockedBy = picked.root.blockedBy;
    if (parentBlockedBy.length > 0) {
      const states = await fetchIssueStates(ghRepo, parentBlockedBy);
      parentBlockedBy = parentBlockedBy.filter((n) => states.get(n) === "OPEN");
    }
    depNodes = [
      {
        number: picked.root.number,
        blockedBy: parentBlockedBy,
        closed: picked.root.state === "CLOSED",
      },
    ];
  } else {
    depNodes = descendants.map((d) => ({
      number: d.number,
      blockedBy: d.blockedBy,
      closed: d.state === "CLOSED",
    }));
  }

  const allClosed = depNodes.every((n) => n.closed);
  if (allClosed) {
    outro("Nothing to do. All sub-issues under the picked parent are closed.");
    return 0;
  }

  const result = topoSort(depNodes);
  if (!result.ok) {
    if (result.error.kind === "cycle") {
      stderr("\nDependency graph contains a cycle. Offending edges:\n");
      for (const e of result.error.edges) {
        stderr(`  #${String(e.from)} -> #${String(e.to)}\n`);
      }
      stderr(
        "\nResolve by removing one of the `blocked by` relationships in GitHub, then re-run.\n"
      );
    } else {
      stderr(
        `\nIssue #${String(result.error.issue)} is blocked by #${String(result.error.blocker)}, ` +
          `which is open and outside the selected parent's subtree.\n`
      );
      stderr(
        "Resolve by closing the blocker, removing the relationship, or expanding scope.\n"
      );
    }
    return 1;
  }

  // Linear integration: create or paste -> verbatim branch name. The body of
  // the new issue (and the print at the end) lists in-scope sub-issues by
  // topo order with their titles.
  const titlesByNumber = new Map<number, string>();
  for (const d of descendants) titlesByNumber.set(d.number, d.title);
  if (descendants.length === 0) {
    titlesByNumber.set(picked.root.number, picked.root.title);
  }

  const orderedSubsForLinear = result.order.map((n) => ({
    number: n,
    title: titlesByNumber.get(n) ?? `#${String(n)}`,
  }));
  const parentForLinear: ParentForLinear = {
    number: picked.root.number,
    title: picked.root.title,
    url: `https://github.com/${ghRepo.owner}/${ghRepo.repo}/issues/${String(picked.root.number)}`,
    subIssues: orderedSubsForLinear,
  };

  const linearCtx = {
    apiKey: linearApiKey,
    teamKey: config.linear.team,
    ghIssueUrl: (n: number): string =>
      `https://github.com/${ghRepo.owner}/${ghRepo.repo}/issues/${String(n)}`,
  };
  const linear = await resolveLinearIssue(linearCtx, parentForLinear);

  // Pre-flight summary: branch name + ordered queue, with Y/n confirm.
  log.info(`Branch: ${linear.branchName}`);
  log.info("Topo-ordered queue:");
  for (const n of result.order) {
    const title = titlesByNumber.get(n);
    log.message(title ? `  #${String(n)} ${title}` : `  #${String(n)}`);
  }

  const proceed = await confirm({
    message: `Run ${String(result.order.length)} issue(s) on branch ${linear.branchName}?`,
    initialValue: true,
  });
  if (isCancel(proceed) || !proceed) {
    cancel("Cancelled before any run() invocation.");
    return 0;
  }

  // Pre-flight opt-out for the tail PR step. Captured here (not at the tail)
  // so the run remains autonomous after kickoff. Cancelling the prompt is
  // treated like answering "no".
  const prCreationAnswer = await confirm({
    message: "Create a PR at the end?",
    initialValue: true,
  });
  const prCreationConfirmed = !isCancel(prCreationAnswer) && prCreationAnswer;

  const orderedForRunner = result.order.map((n) => ({
    number: n,
    title: titlesByNumber.get(n) ?? `#${String(n)}`,
  }));

  const runResult = await runIssueQueue({
    ghRepo,
    orderedIssues: orderedForRunner,
    branch: linear.branchName,
    parentNumber: picked.root.number,
    repoRoot,
    config,
    sandboxEnv,
  });

  if (runResult.abortedAt) {
    const a = runResult.abortedAt;
    log.error(`Aborted at #${String(a.number)}: ${a.reason}`);
    if (a.preservedWorktreePath !== undefined) {
      log.info(`Preserved worktree at ${a.preservedWorktreePath}`);
    }
    log.info(
      `Completed ${String(runResult.completed)} of ${String(orderedForRunner.length)} issue(s) before abort.`
    );
    outro("Aborted. Inspect the worktree, fix, and re-run on the same parent.");
    return 1;
  }

  // Queue succeeded — hand the post-queue decision to the tail-step helper,
  // which gates on the pre-flight PR confirm and (if confirmed) invokes the
  // PR-submission module. The helper returns the outro message + exit code
  // so opt-out, opened, and failed paths render uniformly here.
  const tail = await runPrTailStep({
    prCreationConfirmed,
    ghRepo,
    branch: linear.branchName,
    baseBranch,
    parentNumber: picked.root.number,
    parentTitle: picked.root.title,
    repoRoot,
    config,
    sandboxEnv,
    completedCount: runResult.completed,
    runPrSubmission: options.runPrSubmission,
  });

  if (tail.outcome.kind === "failed") {
    log.error(tail.outcome.message);
  }
  outro(tail.outroMessage);
  return tail.exitCode;
}
