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
import {
  assertInReviewStatePresent as defaultAssertInReviewStatePresent,
  fetchSubIssues as defaultFetchSubIssues,
  listPRDs as defaultListPRDs,
  listStandaloneIssues as defaultListStandaloneIssues,
  transitionToInProgress as defaultTransitionToInProgress,
  transitionToInReview as defaultTransitionToInReview,
  type LinearContext,
  type PRD,
  type StandaloneIssue,
  type SubIssue,
} from "../linear/index.ts";
import {
  countCommitsAhead as defaultCountCommitsAhead,
  resolveBaseBranch,
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
  /** Linear PRD list fetcher. Tests stub this to avoid hitting Linear. */
  listPRDs?: (ctx: LinearContext) => Promise<PRD[]>;
  /** Linear Standalone Issue list fetcher. Tests stub this. */
  listStandaloneIssues?: (ctx: LinearContext) => Promise<StandaloneIssue[]>;
  /**
   * Linear `"In Review"` state preflight assertion. Tests stub this to
   * avoid hitting Linear. Defaults to `linear.assertInReviewStatePresent`.
   */
  assertInReviewStatePresent?: (ctx: LinearContext) => Promise<void>;
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
   * Test seam: shell runner used for the host-side base-branch capture
   * (`git rev-parse --abbrev-ref HEAD`). Defaults to a child_process spawn
   * inside the pr-submission module.
   */
  baseBranchShellRunner?: ShellRunner;
}

export interface RunQueueAfterPickOptions {
  /** Tagged-union root reference returned by the picker. */
  picked: RootRef;
  ghRepo: GhRepo;
  baseBranch: string;
  linearCtx: LinearContext;
  repoRoot: string;
  config: TideConfig;
  sandboxEnv: Record<string, string>;
  /** Test seam — defaults to `linear.fetchSubIssues`. Used both to build
   * the queue for PRD roots and to validate the "no children" rule for
   * Standalone Issue roots. */
  fetchSubIssues?: (ctx: LinearContext, issueId: string) => Promise<SubIssue[]>;
  /** Test seam — defaults to the runner module's `runIssueQueue`. */
  runIssueQueue?: (opts: RunIssueQueueOptions) => Promise<RunIssueQueueResult>;
  /** Test seam — defaults to the in-module `runPrTailStep`. */
  runPrTailStep?: (opts: RunPrTailStepOptions) => Promise<PrTailStepResult>;
  /** Test seam — clack `confirm` for "Run N issue(s)?". */
  confirmRun?: (count: number, branch: string) => Promise<boolean>;
  /** Test seam — clack `confirm` for "Create a PR at the end?". */
  confirmPr?: () => Promise<boolean>;
  /** Test seam — defaults to `linear.transitionToInProgress`. Used to
   * transition the picked root to *In Progress* once both pre-flight
   * confirms have been answered. For PRD roots this is the PRD itself; for
   * Standalone Issue roots this is the issue itself. */
  transitionRootToInProgress?: (
    ctx: LinearContext,
    issueId: string
  ) => Promise<void>;
  /**
   * Test seam — defaults to `linear.transitionToInReview`. Fired by the
   * post-submission hook after a clean queue + successful PR open against a
   * PRD root, transitioning the PRD to *In Review*. Failure of this
   * transition is non-fatal: the PR and earlier Linear writes are preserved
   * and the failure surfaces as a warning in the run output.
   */
  transitionRootToInReview?: (
    ctx: LinearContext,
    issueId: string
  ) => Promise<void>;
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
  const fetchSubIssuesFn = opts.fetchSubIssues ?? defaultFetchSubIssues;
  const runIssueQueueFn = opts.runIssueQueue ?? defaultRunIssueQueue;
  const runPrTailStepFn = opts.runPrTailStep ?? runPrTailStep;
  const confirmRunFn = opts.confirmRun ?? defaultConfirmRun;
  const confirmPrFn = opts.confirmPr ?? defaultConfirmPr;
  const transitionRootToInProgressFn =
    opts.transitionRootToInProgress ?? defaultTransitionToInProgress;
  const transitionRootToInReviewFn =
    opts.transitionRootToInReview ?? defaultTransitionToInReview;

  const root = rootMetaFromPicked(opts.picked);

  // Pre-flight: refuse to run from the picked root's feature branch. The
  // base branch we resolved at startup is whatever the user invoked `tide
  // run` from; if it matches the root's auto-generated `branchName`, the
  // user has already checked out the feature branch and would otherwise
  // stack the new PR on top of itself. Fail before any Linear write or
  // sandbox launch.
  if (root.branchName === opts.baseBranch) {
    log.error(
      `tide run must be invoked from the base branch, not the feature branch (${opts.baseBranch}). Switch back to your base branch and re-run.`
    );
    outro("Aborted.");
    return 1;
  }

  let orderedIssues: OrderedIssue[];

  if (opts.picked.kind === "prd") {
    const subSpin = spinner();
    subSpin.start("Fetching sub-issues from Linear");
    let subIssues: SubIssue[];
    try {
      subIssues = await fetchSubIssuesFn(opts.linearCtx, root.id);
    } catch (err) {
      subSpin.stop("Linear sub-issue fetch failed");
      const msg = err instanceof Error ? err.message : String(err);
      log.error(msg);
      outro("Aborted.");
      return 1;
    }
    subSpin.stop(`Fetched ${String(subIssues.length)} sub-issue(s)`);

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

    log.info(`Branch: ${root.branchName}`);
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
    log.info(`Branch: ${root.branchName}`);
    log.info(`Standalone Issue: 1 iteration on ${root.identifier}.`);
  }

  const proceed = await confirmRunFn(orderedIssues.length, root.branchName);
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
      children = await fetchSubIssuesFn(opts.linearCtx, root.id);
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
    await transitionRootToInProgressFn(opts.linearCtx, root.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const label = opts.picked.kind === "prd" ? "PRD" : "Issue";
    log.error(`Failed to transition ${label} to In Progress: ${msg}`);
    outro("Aborted.");
    return 1;
  }

  const queueResult = await runIssueQueueFn({
    root:
      opts.picked.kind === "prd"
        ? { kind: "prd", id: root.id, identifier: root.identifier }
        : { kind: "standalone" },
    orderedIssues,
    branch: root.branchName,
    baseBranch: opts.baseBranch,
    linearCtx: opts.linearCtx,
    repoRoot: opts.repoRoot,
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
    branch: root.branchName,
    baseBranch: opts.baseBranch,
    rootIdentifier: root.identifier,
    rootTitle: root.title,
    rootUrl: root.url,
    subIssues: subIssueRefs,
    repoRoot: opts.repoRoot,
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
        await transitionRootToInReviewFn(opts.linearCtx, root.id);
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

  outro(tail.outroMessage);
  return tail.exitCode;
}

export async function tideRun(options: RunOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = options.stderr ?? ((s: string) => process.stderr.write(s));
  const build = options.build ?? defaultBuild;
  const getGhIdentity = options.getGhIdentity ?? defaultGetGhIdentity;
  const getGhToken = options.getGhToken ?? defaultGetGhToken;
  const listPRDsFn = options.listPRDs ?? defaultListPRDs;
  const listStandaloneIssuesFn =
    options.listStandaloneIssues ?? defaultListStandaloneIssues;
  const pickRootFn = options.pickRoot ?? defaultPickRoot;
  const runQueueAfterPickFn = options.runQueueAfterPick ?? runQueueAfterPick;
  const assertInReviewStatePresentFn =
    options.assertInReviewStatePresent ?? defaultAssertInReviewStatePresent;

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

  const linearCtx: LinearContext = {
    apiKey: linearApiKey,
    teamKey: config.linear.team,
  };

  // Preflight: refuse to start when the team has no "In Review" workflow
  // state. Without this gate a clean run would only discover the missing
  // state at the post-submission hand-off, after the queue has already done
  // its work — a silent fallback to Done would re-introduce the original
  // PER-51 problem.
  try {
    await assertInReviewStatePresentFn(linearCtx);
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

  // Fetch PRDs and Standalone Issues in parallel.
  const fetchSpin = spinner();
  fetchSpin.start("Fetching PRDs and Standalone Issues from Linear");
  let prds: PRD[];
  let standaloneIssues: StandaloneIssue[];
  try {
    [prds, standaloneIssues] = await Promise.all([
      listPRDsFn(linearCtx),
      listStandaloneIssuesFn(linearCtx),
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

  if (prds.length === 0 && standaloneIssues.length === 0) {
    outro(
      "No roots to run. Author a PRD with `ready-for-agent` sub-issues, or a Standalone Issue with the `ready-for-agent` label, in Linear."
    );
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
    baseBranch,
    linearCtx,
    repoRoot,
    config,
    sandboxEnv,
  });
}
