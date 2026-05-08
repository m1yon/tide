// `tide run` — Linear-native PRD-rooted runner.
//
// Steps:
//   1. discover repo root → capture base branch (fail fast on detached HEAD)
//      → load config + env → resolve gh identity + token → build sandbox image
//   2. fetch the team's PRDs and Standalone Issues from Linear in parallel
//      (PRDs: `prd` label + at least one `ready-for-agent` direct child;
//      Standalone Issues: `ready-for-agent` label, no parent, no `prd`),
//      then clack-select a single root
//   3. dispatch on root kind:
//        - PRD root: fetch the picked PRD's direct sub-issues, build the
//          topo-ordered queue (filter to `ready-for-agent`)
//        - Standalone Issue root: validate no Linear children exist, then
//          build a one-element queue from the issue itself
//   4. preflight summary + Y/n confirms, transition the root to *In
//      Progress*, then run the queue
//   5. push the feature branch and open a PR (or skip cleanly)
//
// All Linear writes happen from the host (ADR-0005). The branch name is
// the sole PR↔root link — Linear's GitHub integration auto-transitions
// the root on merge (ADR-0006).

import {
  intro,
  outro,
  spinner,
  log,
  confirm,
  isCancel,
  cancel,
} from "@clack/prompts";
import { spawn } from "node:child_process";
import {
  createWorktree as defaultCreateWorktree,
  type CreateWorktreeOptions,
  type Worktree,
} from "@ai-hero/sandcastle";
import {
  decideBranchOverride,
  promptBranchOverride as defaultPromptBranchOverride,
  type BranchOverrideOutcome,
  type PromptBranchOverrideInput,
} from "../branch-override/index.ts";
import {
  decidePrTarget,
  promptPrTarget as defaultPromptPrTarget,
  type PrTargetOutcome,
  type PromptPrTargetInput,
} from "../pr-target/index.ts";
import { createBridgeIfMissing } from "../sandcastle-bridge/index.ts";
import { build as defaultBuild, type BuildOptions } from "./build.ts";
import { loadConfig, type TideConfig } from "../config-loader/index.ts";
import { loadEnv } from "../env-loader/index.ts";
import {
  buildOrderedQueue,
  type BuildOrderedQueueResult,
  type OrderedSubIssue,
} from "../queue-build/index.ts";
import {
  getGhIdentity as defaultGetGhIdentity,
  type GetGhIdentityOptions,
  type GhIdentity,
} from "../gh-identity/index.ts";
import {
  getGhToken as defaultGetGhToken,
  type GetGhTokenOptions,
} from "../gh-token/index.ts";
import type { GhRepo } from "../github/index.ts";
import type { PRD, StandaloneIssue, SubIssue } from "../linear/index.ts";
import {
  LinearSdkService,
  type LinearService,
} from "../services/linear/index.ts";
import {
  countCommitsAhead as defaultCountCommitsAhead,
  resolveCurrentBranch,
  resolveOriginHead,
  runPrSubmission as defaultRunPrSubmission,
  type PrSubmissionResult,
  type RunPrSubmissionOptions,
  type ShellRunner,
  type SubIssueRef,
} from "../pr-submission/index.ts";
import { discoverRepoRoot } from "../repo-discovery/index.ts";
import {
  runIssueQueue as defaultRunIssueQueue,
  type OrderedIssue,
  type RunIssueQueueOptions,
  type RunIssueQueueResult,
} from "../runner/index.ts";
import {
  pickRoot as defaultPickRoot,
  type RootRef,
} from "../selector/index.ts";

const READY_FOR_HUMAN = "ready-for-human";

/**
 * Build the user-facing message tide prints when a Linear list query
 * returns zero issues for the working repo. Names the repo and surfaces
 * the two recovery moves so an empty picker / queue is never silently
 * confusing (ADR-0012).
 */
function emptyListMessage(
  kind: "PRD" | "Standalone Issue" | "sub-issue" | "root",
  repoName: string
): string {
  const noun = kind === "root" ? "PRD or Standalone Issue" : kind;
  return (
    `No ${noun}(s) for repo "${repoName}". ` +
    `Tide filters Linear titles by the \`[${repoName}] \` prefix. ` +
    `Either retitle existing Linear issues to start with that prefix, ` +
    `or create one with the triage / to-prd / to-issues skill.`
  );
}

export { buildOrderedQueue };
export type { BuildOrderedQueueResult, OrderedSubIssue };

export interface RunOptions {
  /** Repo root override (defaults to repo-discovery from cwd). */
  repoRoot?: string;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  /** Build step. Tests stub this to avoid spawning docker. */
  build?: (options: BuildOptions) => Promise<number>;
  /** gh-identity resolver. Tests stub this to avoid spawning `gh`. */
  getGhIdentity?: (options: GetGhIdentityOptions) => Promise<GhIdentity>;
  /** gh-token resolver. Tests stub this to avoid spawning `gh`. */
  getGhToken?: (options: GetGhTokenOptions) => Promise<string>;
  /**
   * Linear-facing service. Tests inject an `InMemoryLinearService`;
   * production constructs a `LinearSdkService` inline from the loaded env
   * + config + gh-identity. Optional only because the production path
   * cannot construct it before env/config have been loaded — when absent,
   * `tideRun` builds it after every other piece of context is in place.
   */
  linear?: LinearService;
  /** Root selector prompt. Tests stub this to bypass the clack UI. */
  pickRoot?: (input: {
    prds: readonly PRD[];
    standaloneIssues: readonly StandaloneIssue[];
  }) => Promise<RootRef>;
  /**
   * Test seam: post-pick orchestration (queue build + confirms + queue run +
   * PR tail). Defaults to the in-module `runQueueAfterPick`.
   */
  runQueueAfterPick?: (opts: RunQueueAfterPickOptions) => Promise<number>;
  /**
   * Test seam: shell runner used for the host-side current-branch capture
   * (`git rev-parse --abbrev-ref HEAD`). Defaults to a child_process spawn
   * inside the pr-submission module.
   */
  currentBranchShellRunner?: ShellRunner;
  /**
   * Test seam: shell runner used for the host-side `origin/HEAD` capture
   * (`git rev-parse --abbrev-ref origin/HEAD`). Defaults to a child_process
   * spawn inside the pr-submission module. A non-zero exit here is legal
   * (origin/HEAD-unset clones); the resolver returns `undefined` and the
   * PR-target prompt fires unconditionally with no default.
   */
  originHeadShellRunner?: ShellRunner;
}

export interface RunQueueAfterPickOptions {
  /** Tagged-union root reference returned by the picker. */
  picked: RootRef;
  ghRepo: GhRepo;
  /** The user's current branch (`git rev-parse --abbrev-ref HEAD`) — input
   * to both the **Branch override** decision and the **PR target branch**
   * decision. Independent of `originHead`. */
  currentBranch: string;
  /** The remote's default branch (`git rev-parse --abbrev-ref origin/HEAD`,
   * with `origin/` stripped) or `undefined` when `origin/HEAD` is unset.
   * Input to the **PR target branch** decision; the prompt fires
   * unconditionally with no default when `undefined`. */
  originHead: string | undefined;
  /** Linear-facing service. Threaded through to the runner unchanged. */
  linear: LinearService;
  repoRoot: string;
  config: TideConfig;
  sandboxEnv: Record<string, string>;
  /** Test seam — defaults to the runner module's `runIssueQueue`. */
  runIssueQueue?: (opts: RunIssueQueueOptions) => Promise<RunIssueQueueResult>;
  /** Test seam — defaults to the in-module `runPrTailStep`. */
  runPrTailStep?: (opts: RunPrTailStepOptions) => Promise<PrTailStepResult>;
  /** Test seam — clack `confirm` for "Run N issue(s)?". */
  confirmRun?: (count: number, branch: string) => Promise<boolean>;
  /** Test seam — clack `confirm` for "Create a PR at the end?". */
  confirmPr?: () => Promise<boolean>;
  /**
   * Test seam — defaults to sandcastle's top-level `createWorktree`. Used
   * to create the long-lived Feature worktree once per `tide run`, after
   * the user's pre-flight confirms succeed and before `runIssueQueue`
   * fires. Tide never closes the returned `Worktree` handle, so the
   * worktree directory persists across runs (sandcastle's collision
   * detection reuses an existing managed worktree on the next invocation).
   */
  createWorktree?: (opts: CreateWorktreeOptions) => Promise<Worktree>;
  /**
   * Test seam — defaults to the `branch-override` module's clack `select`
   * wrapper. Fires only when the user's current branch differs from the
   * picked root's `branchName`; tests stub it to drive the prompted-Linear,
   * prompted-current, and cancelled paths without rendering UI.
   */
  promptBranchOverride?: (
    input: PromptBranchOverrideInput
  ) => Promise<BranchOverrideOutcome>;
  /**
   * Test seam — defaults to the `pr-target` module's clack `select`+`text`
   * wrapper. Fires only when the user's current branch differs from
   * `origin/HEAD` (or unconditionally when `origin/HEAD` is unset); tests
   * stub it to drive the prompted-default, prompted-typed-valid,
   * prompted-typed-invalid, prompted-cancel, and origin-HEAD-unset paths
   * without rendering UI.
   */
  promptPrTarget?: (input: PromptPrTargetInput) => Promise<PrTargetOutcome>;
  /**
   * Test seam — defaults to a clack `confirm`. Fires when the resolved
   * `featureBranch` matches the user's `currentBranch` (silent override or
   * override-take path). The user's main checkout has the branch, which
   * sandcastle's `createWorktree` would otherwise refuse with "Branch is
   * already checked out". Returning `true` releases the branch via
   * `gitSwitch(repoRoot, baseBranch)`; `false` cancels the run cleanly with
   * no Linear writes.
   */
  confirmReleaseBranch?: (input: {
    branch: string;
    baseBranch: string;
    repoRoot: string;
  }) => Promise<boolean>;
  /**
   * Test seam — defaults to a child_process `git -C <repoRoot> switch
   * <branch>`. Throws with the git stderr on non-zero exit (typical:
   * uncommitted changes that would be overwritten). Used by the pre-flight
   * release step described on `confirmReleaseBranch`.
   */
  gitSwitch?: (repoRoot: string, branch: string) => Promise<void>;
}

export interface RunPrTailStepOptions {
  prCreationConfirmed: boolean;
  ghRepo: GhRepo;
  branch: string;
  baseBranch: string;
  /** Linear root identifier (e.g. "MEC-123"). PRD identifier for PRD
   * roots; Standalone Issue identifier for Standalone roots. */
  rootIdentifier: string;
  rootTitle: string;
  /** Linear root URL. */
  rootUrl: string;
  /** Topo-ordered sub-issues addressed by this PR. Empty for Standalone
   * Issue roots. */
  subIssues: SubIssueRef[];
  repoRoot: string;
  /** Path to the long-lived Feature worktree on the host. The PR-submission
   * iteration runs directly inside it under sandcastle's `head` branch
   * strategy. The host-side `gh pr list --head <branch>` and the rev-list
   * gate continue to run from `repoRoot`. */
  featureWorktreePath: string;
  config: TideConfig;
  sandboxEnv: Record<string, string>;
  completedCount: number;
  /** Test seam — defaults to the imported `runPrSubmission`. */
  runPrSubmission?: (
    options: RunPrSubmissionOptions
  ) => Promise<PrSubmissionResult>;
  /** Test seam — defaults to the imported `countCommitsAhead`. */
  countCommitsAhead?: (
    repoRoot: string,
    baseBranch: string,
    branch: string
  ) => Promise<number>;
}

export type PrTailOutcome =
  | { kind: "opted-out" }
  | { kind: "skipped-empty" }
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

  // Rev-list gate: if the branch is not ahead of base, there is nothing to
  // submit. Run after the opt-out check so we don't shell out when the user
  // already declined.
  const countCommitsAheadFn =
    opts.countCommitsAhead ?? defaultCountCommitsAhead;
  let commitsAhead: number;
  try {
    commitsAhead = await countCommitsAheadFn(
      opts.repoRoot,
      opts.baseBranch,
      opts.branch
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      outcome: { kind: "failed", message },
      outroMessage: `Done. ${completedSummary}, but PR submission failed.`,
      exitCode: 1,
    };
  }

  if (commitsAhead === 0) {
    log.warn(
      `Branch ${opts.branch} has no commits ahead of ${opts.baseBranch}. Skipping PR step — there is nothing to submit.`
    );
    return {
      outcome: { kind: "skipped-empty" },
      outroMessage: `Done. ${completedSummary}. PR step skipped (no commits ahead of ${opts.baseBranch}).`,
      exitCode: 0,
    };
  }

  const runPrSubmissionFn = opts.runPrSubmission ?? defaultRunPrSubmission;
  try {
    const prResult = await runPrSubmissionFn({
      ghRepo: opts.ghRepo,
      branch: opts.branch,
      baseBranch: opts.baseBranch,
      rootIdentifier: opts.rootIdentifier,
      rootTitle: opts.rootTitle,
      rootUrl: opts.rootUrl,
      subIssues: opts.subIssues,
      repoRoot: opts.repoRoot,
      featureWorktreePath: opts.featureWorktreePath,
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

async function defaultConfirmRun(
  count: number,
  branch: string
): Promise<boolean> {
  const answer = await confirm({
    message: `Run ${String(count)} issue(s) on branch ${branch}?`,
    initialValue: true,
  });
  if (isCancel(answer)) return false;
  return answer;
}

async function defaultConfirmPr(): Promise<boolean> {
  const answer = await confirm({
    message: "Create a PR at the end?",
    initialValue: true,
  });
  return !isCancel(answer) && answer;
}

async function defaultConfirmReleaseBranch(input: {
  branch: string;
  baseBranch: string;
  repoRoot: string;
}): Promise<boolean> {
  const answer = await confirm({
    message:
      `Branch '${input.branch}' is checked out at ${input.repoRoot}. ` +
      `Switch this checkout to '${input.baseBranch}' so tide can take the branch?`,
    initialValue: true,
  });
  if (isCancel(answer)) return false;
  return answer;
}

function defaultGitSwitch(repoRoot: string, branch: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repoRoot, "switch", branch], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const trimmed = stderr.trim();
      reject(
        new Error(
          `git switch ${branch} (in ${repoRoot}) failed (exit ${String(code ?? 0)})${
            trimmed === "" ? "" : `: ${trimmed}`
          }`
        )
      );
    });
  });
}

interface RootMeta {
  /** Linear UUID of the picked root. */
  id: string;
  identifier: string;
  title: string;
  branchName: string;
  url: string;
}

function rootMetaFromPicked(picked: RootRef): RootMeta {
  if (picked.kind === "prd") {
    return {
      id: picked.prd.id,
      identifier: picked.prd.identifier,
      title: picked.prd.title,
      branchName: picked.prd.branchName,
      url: picked.prd.url,
    };
  }
  return {
    id: picked.issue.id,
    identifier: picked.issue.identifier,
    title: picked.issue.title,
    branchName: picked.issue.branchName,
    url: picked.issue.url,
  };
}

/**
 * Post-pick orchestration: fetch sub-issues (PRD root) or validate
 * structure (Standalone Issue root), build the queue, run pre-flight
 * confirms, run the queue, and dispatch to `runPrTailStep` for the PR
 * step. Surfaced as a named export so tests can stub it for early-gate
 * coverage and exercise it directly with stubs for orchestration coverage.
 */
export async function runQueueAfterPick(
  opts: RunQueueAfterPickOptions
): Promise<number> {
  const linear = opts.linear;
  const runIssueQueueFn = opts.runIssueQueue ?? defaultRunIssueQueue;
  const runPrTailStepFn = opts.runPrTailStep ?? runPrTailStep;
  const confirmRunFn = opts.confirmRun ?? defaultConfirmRun;
  const confirmPrFn = opts.confirmPr ?? defaultConfirmPr;
  const createWorktreeFn = opts.createWorktree ?? defaultCreateWorktree;
  const promptBranchOverrideFn =
    opts.promptBranchOverride ?? defaultPromptBranchOverride;
  const promptPrTargetFn = opts.promptPrTarget ?? defaultPromptPrTarget;
  const confirmReleaseBranchFn =
    opts.confirmReleaseBranch ?? defaultConfirmReleaseBranch;
  const gitSwitchFn = opts.gitSwitch ?? defaultGitSwitch;

  const root = rootMetaFromPicked(opts.picked);

  // Branch override: when the user's current branch matches the picked
  // root's auto-generated `branchName`, proceed silently with Linear's
  // branch (the "I'm on the right branch already" path doesn't waste a
  // keystroke). Otherwise prompt with Linear's branch as the default and
  // the user's current branch as the second option — the chosen value
  // becomes the Feature worktree's branch. Replaces the prior pre-flight
  // gate that errored out when the user's current branch was the picked
  // root's feature branch.
  const overrideDecision = decideBranchOverride({
    currentBranch: opts.currentBranch,
    pickedBranchName: root.branchName,
  });
  let featureBranch: string;
  if (overrideDecision.kind === "silent") {
    featureBranch = overrideDecision.branch;
  } else {
    const result = await promptBranchOverrideFn({
      linearBranch: overrideDecision.linearBranch,
      currentBranch: overrideDecision.currentBranch,
    });
    if (result.kind === "cancelled") {
      cancel("Cancelled at branch selection.");
      return 0;
    }
    featureBranch = result.branch;
  }
  // The override is "taken" when the user picked their own branch instead
  // of Linear's. Used at end-of-run to flag the merge-driven Done
  // transition that won't fire (Linear's GitHub integration cannot match
  // a non-Linear branch back to the root).
  const overrideTaken = featureBranch !== root.branchName;

  // PR target branch: smart-silent when the user's current branch matches
  // `origin/HEAD` (typical: invoked from trunk). Otherwise prompt with
  // `origin/HEAD` as the default; user-typed alternatives are validated
  // against the local repo. When `origin/HEAD` is unset the prompt fires
  // unconditionally with no default. See ADR-0016 — splitting this from
  // the override decision is what makes the override path actually open a
  // PR (the conflated single-capture model produced `featureBranch ===
  // baseBranch` on the override-take path, silently skipping PR creation
  // via the rev-list gate).
  const prTargetDecision = decidePrTarget({
    currentBranch: opts.currentBranch,
    originHead: opts.originHead,
  });
  let baseBranch: string;
  if (prTargetDecision.kind === "silent") {
    baseBranch = prTargetDecision.branch;
  } else {
    const result = await promptPrTargetFn({
      defaultBranch: prTargetDecision.defaultBranch,
      repoRoot: opts.repoRoot,
    });
    if (result.kind === "cancelled") {
      cancel("Cancelled at PR target selection.");
      return 0;
    }
    baseBranch = result.branch;
  }

  // Pre-flight: when the resolved feature branch is the branch checked out
  // at `repoRoot` (silent override path or override-take path), sandcastle's
  // `createWorktree` below would refuse with "Branch is already checked out
  // in worktree at <repoRoot>". The recovery is mechanical — switch the
  // main checkout to `baseBranch` and proceed. Fires before any Linear
  // writes, the queue-confirm prompt, the PR-confirm prompt, and the queue
  // build, so a cancel here costs no keystrokes downstream and leaves no
  // state to unwind. The "checked out in some *other* worktree" case (manual
  // `git worktree add` elsewhere) is intentionally not handled here —
  // sandcastle's collision error remains the correct abort path for that.
  if (featureBranch === opts.currentBranch) {
    const release = await confirmReleaseBranchFn({
      branch: featureBranch,
      baseBranch,
      repoRoot: opts.repoRoot,
    });
    if (!release) {
      cancel("Cancelled at branch release.");
      return 0;
    }
    try {
      await gitSwitchFn(opts.repoRoot, baseBranch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(msg);
      log.info(
        `Commit or stash any uncommitted changes in ${opts.repoRoot}, then re-run.`
      );
      outro("Aborted.");
      return 1;
    }
  }

  let orderedIssues: OrderedIssue[];

  if (opts.picked.kind === "prd") {
    const subSpin = spinner();
    subSpin.start("Fetching sub-issues from Linear");
    let subIssues: SubIssue[];
    try {
      subIssues = await linear.fetchSubIssues(root.id);
    } catch (err) {
      subSpin.stop("Linear sub-issue fetch failed");
      const msg = err instanceof Error ? err.message : String(err);
      log.error(msg);
      outro("Aborted.");
      return 1;
    }
    subSpin.stop(`Fetched ${String(subIssues.length)} sub-issue(s)`);

    if (subIssues.length === 0) {
      log.warn(emptyListMessage("sub-issue", opts.ghRepo.repo));
    }

    const queue = buildOrderedQueue(subIssues);
    if (queue.kind === "error") {
      log.error(queue.message);
      outro("Aborted.");
      return 1;
    }
    orderedIssues =
      queue.kind === "standalone"
        ? [{ id: root.id, identifier: root.identifier, title: root.title }]
        : queue.ordered;

    log.info(`Branch: ${featureBranch}`);
    if (queue.kind === "standalone") {
      log.info(
        "Standalone PRD (no `ready-for-agent` direct children) — running the PRD itself."
      );
    } else {
      log.info(
        `PRD-rooted: ${String(queue.ordered.length)} sub-issue(s) in topo order:`
      );
      for (const o of queue.ordered) {
        log.message(`  ${o.identifier} ${o.title}`);
      }
    }

    // Surface direct children flagged `ready-for-human` (typically the
    // residue of a previous run's BLOCKED / agent-FAIL flip) as a one-line
    // skip notice so the user knows what is *not* in the queue. These are
    // already excluded from `queue.ordered` by `buildOrderedQueue`.
    for (const s of subIssues) {
      if (s.labels.includes(READY_FOR_HUMAN)) {
        log.info(`Skipping ${s.identifier}: ready-for-human`);
      }
    }
  } else {
    // Standalone Issue root: build a one-element queue. The no-children
    // contract is validated post-confirm (below) so that a user who cancels
    // out of the pre-flight does not see a structural error message.
    orderedIssues = [
      { id: root.id, identifier: root.identifier, title: root.title },
    ];
    log.info(`Branch: ${featureBranch}`);
    log.info(`Standalone Issue: 1 iteration on ${root.identifier}.`);
  }

  const proceed = await confirmRunFn(orderedIssues.length, featureBranch);
  if (!proceed) {
    cancel("Cancelled before any run() invocation.");
    return 0;
  }

  // Standalone Issue contract: no Linear children. Validated only after the
  // user has confirmed the pre-flight, so a cancel at the confirm prompt
  // does not surface this structural error. No Linear writes have happened
  // yet, so the abort path stays clean.
  if (opts.picked.kind === "standalone") {
    const childSpin = spinner();
    childSpin.start("Verifying Standalone Issue has no Linear children");
    let children: SubIssue[];
    try {
      children = await linear.fetchSubIssues(root.id);
    } catch (err) {
      childSpin.stop("Linear child fetch failed");
      const msg = err instanceof Error ? err.message : String(err);
      log.error(msg);
      outro("Aborted.");
      return 1;
    }
    childSpin.stop("Verified");
    if (children.length > 0) {
      log.error(
        `${root.identifier} is a Standalone Issue but has ${String(children.length)} Linear ` +
          "child issue(s) — non-PRD with children. Label the parent as `prd` or remove the children, then re-run."
      );
      outro("Aborted.");
      return 1;
    }
  }

  const prCreationConfirmed = await confirmPrFn();

  // Transition the picked root to *In Progress* once the user has committed
  // to running the queue. A cancelled pre-flight (above) leaves it
  // untouched. A failure here is an infra failure — no Linear writes have
  // happened on iteration units yet, so we abort cleanly.
  try {
    await linear.transitionToInProgress(root.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const label = opts.picked.kind === "prd" ? "PRD" : "Issue";
    log.error(`Failed to transition ${label} to In Progress: ${msg}`);
    outro("Aborted.");
    return 1;
  }

  // Create (or reuse) the long-lived Feature worktree before running the
  // queue. The worktree persists across `tide run` invocations on the same
  // root — sandcastle's collision detection reuses an existing managed
  // worktree at `<repoRoot>/.tide/worktrees/<sanitized-feature-branch>/`.
  // Tide never closes the returned handle. Each iteration runs in its own
  // ephemeral worktree beneath this one (see runner module).
  let featureWorktree: Worktree;
  try {
    featureWorktree = await createWorktreeFn({
      branchStrategy: {
        type: "branch",
        branch: featureBranch,
        baseBranch,
      },
      cwd: opts.repoRoot,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to create Feature worktree: ${msg}`);
    outro("Aborted.");
    return 1;
  }

  const queueResult = await runIssueQueueFn({
    root:
      opts.picked.kind === "prd"
        ? { kind: "prd", id: root.id, identifier: root.identifier }
        : { kind: "standalone" },
    orderedIssues,
    branch: featureBranch,
    baseBranch,
    linear,
    repoRoot: opts.repoRoot,
    featureWorktreePath: featureWorktree.worktreePath,
    config: opts.config,
    sandboxEnv: opts.sandboxEnv,
  });

  if (queueResult.abortedAt) {
    const a = queueResult.abortedAt;
    log.error(`Aborted at ${a.identifier}: ${a.reason}`);
    if (a.preservedWorktreePath !== undefined) {
      log.info(`Preserved worktree at ${a.preservedWorktreePath}`);
    }
    log.info(
      `Completed ${String(queueResult.completed)} of ${String(orderedIssues.length)} issue(s) before abort.`
    );
    outro("Aborted. Inspect the worktree, fix, and re-run on the same root.");
    return 1;
  }

  // Convert the runner's ordered list of *actually-processed* sub-issues
  // (initial + any absorbed mid-run via ADR-0010's queue rebuild) into the
  // PR-tail's SubIssueRef shape. For PRD roots we surface them as numbered
  // bullets so the template renders the "Sub-issues addressed" block; for
  // Standalone Issue roots we pass an empty list — the block is omitted
  // entirely.
  const subIssueRefs: SubIssueRef[] =
    opts.picked.kind === "prd"
      ? queueResult.processed.map((o, i) => ({
          number: i + 1,
          title: `${o.identifier} ${o.title}`,
        }))
      : [];

  const tail = await runPrTailStepFn({
    prCreationConfirmed,
    ghRepo: opts.ghRepo,
    branch: featureBranch,
    baseBranch,
    rootIdentifier: root.identifier,
    rootTitle: root.title,
    rootUrl: root.url,
    subIssues: subIssueRefs,
    repoRoot: opts.repoRoot,
    featureWorktreePath: featureWorktree.worktreePath,
    config: opts.config,
    sandboxEnv: opts.sandboxEnv,
    completedCount: queueResult.completed,
  });

  if (tail.outcome.kind === "failed") {
    log.error(tail.outcome.message);
  } else if (tail.outcome.kind === "opened") {
    log.success(tail.outcome.url);
  }

  // Post-submission *In Review* hand-off. Fires when the queue ran cleanly
  // (every queued unit completed, none flipped) AND the PR was opened. Any
  // other combination skips: PRD roots get an explicit "not transitioned"
  // warning; Standalone Issue roots fall through to the existing BLOCKED
  // warning below. Transition failure preserves the PR and the queue's
  // existing Linear writes — the failure surfaces as a warning, not a
  // non-zero exit.
  if (tail.outcome.kind === "opened") {
    const queueClean = queueResult.completed > 0 && queueResult.flipped === 0;
    const rootLabel = opts.picked.kind === "prd" ? "PRD" : "Issue";
    if (queueClean) {
      try {
        await linear.transitionToInReview(root.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          `Failed to transition ${rootLabel} ${root.identifier} to In Review: ${msg}. PR was opened; transition manually in Linear.`
        );
      }
    } else if (opts.picked.kind === "prd") {
      log.warn(
        `PRD ${root.identifier} not transitioned to In Review — queue had flipped or incomplete sub-issues. Transition manually in Linear if appropriate.`
      );
    }
  }

  // Standalone-Issue end-of-run BLOCKED warning: when no commits landed on
  // the iteration the issue is now flipped to `ready-for-human` and stays
  // *In Progress* until the user resolves it. Fire alongside the no-merge
  // warning below.
  if (
    opts.picked.kind === "standalone" &&
    queueResult.completed === 0 &&
    queueResult.flipped > 0
  ) {
    log.warn(
      `Issue ${root.identifier} is flipped to \`ready-for-human\` and stays *In Progress* until you resolve it.`
    );
  }

  // No-merge warning: any tail outcome other than `opened` means no PR was
  // opened on this run, so Linear's GitHub integration won't auto-transition
  // the root to Done on merge. Surface this as a yellow warning so the user
  // can transition manually if they're shipping outside this run.
  if (tail.outcome.kind !== "opened") {
    const label = opts.picked.kind === "prd" ? "PRD" : "Issue";
    log.warn(
      `${label} ${root.identifier} will not auto-transition. Transition manually in Linear if shipping outside this run.`
    );
  }

  // Override-active warning: when the user took the Branch override, the
  // eventual PR's head branch is not Linear's auto-generated `branchName`,
  // so Linear's GitHub integration cannot match the PR back to the root on
  // merge — the merge-driven *In Review → Done* transition will not fire.
  // The host-driven *Triage → In Progress → In Review* chain (ADR-0009) is
  // branch-name-independent and continues to fire.
  //
  // Per ADR-0016 the warning fires whenever override was taken, regardless
  // of tail outcome — the prior `tail.outcome.kind === 'opened'` gate
  // existed to suppress this on the silent-no-PR path that the conflated
  // single-capture model produced; that path is gone with the PR-target
  // split, so the warning is unconditional here.
  if (overrideTaken) {
    const label = opts.picked.kind === "prd" ? "PRD" : "Issue";
    log.warn(
      `${label} ${root.identifier}: Branch override active — feature branch ${featureBranch}, not Linear's ${root.branchName}. Linear cannot match the branch back to the root, so the merge-driven In Review → Done transition will not fire. Transition manually in Linear after merge.`
    );
  }

  outro(tail.outroMessage);
  return tail.exitCode;
}

export async function tideRun(options: RunOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = options.stderr ?? ((s: string) => process.stderr.write(s));
  const build = options.build ?? defaultBuild;
  const getGhIdentity = options.getGhIdentity ?? defaultGetGhIdentity;
  const getGhToken = options.getGhToken ?? defaultGetGhToken;
  const pickRootFn = options.pickRoot ?? defaultPickRoot;
  const runQueueAfterPickFn = options.runQueueAfterPick ?? runQueueAfterPick;

  let repoRoot: string;
  try {
    repoRoot = options.repoRoot ?? discoverRepoRoot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  // Capture the user's current branch *before* any other work. Used as the
  // input to both the **Branch override** decision (vs the picked root's
  // Linear `branchName`) and the **PR target branch** decision (vs
  // `origin/HEAD`). Failing fast on detached HEAD here avoids burning a
  // queue's worth of work only to discover the PR step can't proceed.
  let currentBranch: string;
  try {
    currentBranch = await resolveCurrentBranch(
      repoRoot,
      options.currentBranchShellRunner
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  // Capture `origin/HEAD` (the remote's default branch) for the **PR target
  // branch** decision. Best-effort — origin/HEAD-unset is legal (older
  // clones, certain CI setups), in which case the resolver returns
  // `undefined` and the PR-target prompt fires unconditionally with no
  // default. See ADR-0016.
  const originHead = await resolveOriginHead(
    repoRoot,
    options.originHeadShellRunner
  );

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

  // Construct the LinearService. Tests inject `options.linear` to bypass
  // the SDK; production constructs a `LinearSdkService` from the loaded
  // env + config. The repo name lives as a `private readonly` field on
  // the SDK service, but `assertInReviewStatePresent` (the very next
  // call) doesn't read it — so we can construct here with `repoName: ""`
  // and patch the real value once `gh-identity` resolves below. This
  // preserves the historical preflight ordering (In Review check fails
  // before gh-identity is even attempted) without an extra service
  // instance once the user's machine is configured.
  let linear: LinearService;
  if (options.linear !== undefined) {
    linear = options.linear;
  } else {
    linear = new LinearSdkService({
      apiKey: linearApiKey,
      teamKey: config.linear.team,
      repoName: "",
    });
  }

  // Preflight: refuse to start when the team has no "In Review" workflow
  // state. Without this gate a clean run would only discover the missing
  // state at the post-submission hand-off, after the queue has already done
  // its work — a silent fallback to Done would re-introduce the original
  // PER-51 problem.
  try {
    await linear.assertInReviewStatePresent();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  // Resolve GitHub identity from `gh repo view`. The Linear-native flow no
  // longer fetches a triage tree from GitHub, but identity (and `gh auth
  // token` below) are still required for the eventual PR-tail step.
  let ghIdentity: GhIdentity;
  try {
    ghIdentity = await getGhIdentity({ repoRoot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  // Now that we have the working repo name, rebuild the LinearService so
  // the listPRDs / listStandaloneIssues / fetchSubIssues calls below
  // apply the `[<repoName>] ` title-prefix scope filter (ADR-0012).
  // Test-injected services already encapsulate whatever repo name the
  // test wanted; only the production-defaulted service needs reseating.
  if (options.linear === undefined) {
    linear = new LinearSdkService({
      apiKey: linearApiKey,
      teamKey: config.linear.team,
      repoName: ghIdentity.repo,
    });
  }

  // Fetch the host's GitHub token and inject it into the sandbox so the
  // agent's in-sandbox `gh` calls (issue close, PR create) are authenticated.
  // Run before the docker build so missing auth fails fast. See ADR 0003.
  try {
    sandboxEnv.GH_TOKEN = await getGhToken({ repoRoot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  // Sandcastle writes worktrees/logs under `.sandcastle/`. Tide's convention
  // is `.tide/`. Bridge with a symlink so the SDK paths land in the right
  // place. Residual safety net — only creates on `missing`, throws fast on a
  // broken bridge with a hint to run `tide setup`. The full classify + repair
  // lifecycle lives in `tide setup`.
  try {
    createBridgeIfMissing(repoRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  // Ensure the sandbox image is up to date before any clack UI is started —
  // streamed docker output otherwise interferes with clack rendering.
  const buildExit = await build({ repoRoot, stdout, stderr });
  if (buildExit !== 0) {
    return buildExit;
  }

  intro("tide run");

  // Fetch PRDs and Standalone Issues in parallel. Both list calls apply the
  // `[<repoName>] ` title-prefix scope filter (ADR-0012) — wrong-repo and
  // unprefixed issues are invisible.
  const fetchSpin = spinner();
  fetchSpin.start("Fetching PRDs and Standalone Issues from Linear");
  let prds: PRD[];
  let standaloneIssues: StandaloneIssue[];
  try {
    [prds, standaloneIssues] = await Promise.all([
      linear.listPRDs(),
      linear.listStandaloneIssues(),
    ]);
  } catch (err) {
    fetchSpin.stop("Linear fetch failed");
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }
  fetchSpin.stop(
    `Fetched ${String(prds.length)} PRD(s), ${String(standaloneIssues.length)} Standalone Issue(s)`
  );

  if (prds.length === 0) {
    log.warn(emptyListMessage("PRD", ghIdentity.repo));
  }
  if (standaloneIssues.length === 0) {
    log.warn(emptyListMessage("Standalone Issue", ghIdentity.repo));
  }
  if (prds.length === 0 && standaloneIssues.length === 0) {
    outro(emptyListMessage("root", ghIdentity.repo));
    return 0;
  }

  const picked = await pickRootFn({ prds, standaloneIssues });

  if (picked.kind === "prd") {
    log.info(`Selected: [PRD] ${picked.prd.identifier} ${picked.prd.title}`);
  } else {
    log.info(
      `Selected: [Issue] ${picked.issue.identifier} ${picked.issue.title}`
    );
  }

  return await runQueueAfterPickFn({
    picked,
    ghRepo: { owner: ghIdentity.owner, repo: ghIdentity.repo },
    currentBranch,
    originHead,
    linear,
    repoRoot,
    config,
    sandboxEnv,
  });
}
