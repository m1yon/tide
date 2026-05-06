// `tide run` — Linear-native PRD-rooted runner.
//
// Steps:
//   1. discover repo root → capture base branch (fail fast on detached HEAD)
//      → load config + env → resolve gh identity + token → build sandbox image
//   2. fetch the team's PRDs from Linear (filter: prd + ready-for-agent
//      labels, non-terminal state.type) and clack-select a PRD
//   3. fetch the picked PRD's direct sub-issues from Linear, build the
//      ordered queue (filter to `ready-for-agent`, topo-sort by `blockedBy`,
//      or fall back to a one-iteration standalone path)
//   4. preflight summary + Y/n confirms, then run the queue
//   5. push the feature branch and open a PR (or skip cleanly)
//
// No Linear writes happen from the host yet — sub-issues stay in their
// original workflow state throughout. State transitions and the summarizer
// are introduced in later slices.

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
import { build as defaultBuild, type BuildOptions } from "./build.ts";
import { loadConfig, type TideConfig } from "../config-loader/index.ts";
import { type DepNode, topoSort } from "../dep-graph/index.ts";
import { loadEnv } from "../env-loader/index.ts";
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
  fetchSubIssues as defaultFetchSubIssues,
  listPRDs as defaultListPRDs,
  transitionToInProgress as defaultTransitionToInProgress,
  type LinearContext,
  type PRD,
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
import { pickPRD as defaultPickPRD } from "../selector/index.ts";

const READY_FOR_AGENT = "ready-for-agent";
const READY_FOR_HUMAN = "ready-for-human";
const TERMINAL_STATE_TYPES = new Set(["completed", "canceled"]);

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
  /** PRD selector prompt. Tests stub this to bypass the clack UI. */
  pickPRD?: (prds: readonly PRD[]) => Promise<PRD>;
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
  picked: PRD;
  ghRepo: GhRepo;
  baseBranch: string;
  linearCtx: LinearContext;
  repoRoot: string;
  config: TideConfig;
  sandboxEnv: Record<string, string>;
  /** Test seam — defaults to `linear.fetchSubIssues`. */
  fetchSubIssues?: (ctx: LinearContext, prdId: string) => Promise<SubIssue[]>;
  /** Test seam — defaults to the runner module's `runIssueQueue`. */
  runIssueQueue?: (opts: RunIssueQueueOptions) => Promise<RunIssueQueueResult>;
  /** Test seam — defaults to the in-module `runPrTailStep`. */
  runPrTailStep?: (opts: RunPrTailStepOptions) => Promise<PrTailStepResult>;
  /** Test seam — clack `confirm` for "Run N issue(s)?". */
  confirmRun?: (count: number, branch: string) => Promise<boolean>;
  /** Test seam — clack `confirm` for "Create a PR at the end?". */
  confirmPr?: () => Promise<boolean>;
  /** Test seam — defaults to `linear.transitionToInProgress`. Used to
   * transition the PRD itself to *In Progress* once both pre-flight confirms
   * have been answered. */
  transitionPrdToInProgress?: (
    ctx: LinearContext,
    issueId: string
  ) => Promise<void>;
}

export interface RunPrTailStepOptions {
  prCreationConfirmed: boolean;
  ghRepo: GhRepo;
  branch: string;
  baseBranch: string;
  /** Linear PRD identifier (e.g. "MEC-123"). */
  parentIdentifier: string;
  parentTitle: string;
  /** Linear PRD URL. */
  parentUrl: string;
  /** Topo-ordered sub-issues addressed by this PR. */
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

export interface OrderedSubIssue {
  /** Linear UUID. */
  id: string;
  identifier: string;
  title: string;
}

export type BuildOrderedQueueResult =
  | { kind: "queue"; ordered: OrderedSubIssue[] }
  | { kind: "standalone" }
  | { kind: "error"; message: string };

/**
 * Pure: turn the picked PRD's direct sub-issues into an ordered queue.
 *
 * - Filters to direct children carrying the `ready-for-agent` label.
 * - If the filtered set is empty, returns `kind: "standalone"` — the caller
 *   treats the PRD itself as the unit of work.
 * - Closed (terminal-state) direct-child blockers are treated as satisfied.
 * - A `blockedBy` reference outside the picked PRD's children surfaces as
 *   an error mirroring the GitHub-path message shape.
 * - A cycle among open scoped sub-issues surfaces as a cycle error.
 */
export function buildOrderedQueue(
  subIssues: readonly SubIssue[]
): BuildOrderedQueueResult {
  const inScope = subIssues.filter((s) => s.labels.includes(READY_FOR_AGENT));
  if (inScope.length === 0) {
    return { kind: "standalone" };
  }
  const closedAmongDirectChildren = new Map(
    subIssues.map(
      (s) => [s.identifier, TERMINAL_STATE_TYPES.has(s.stateType)] as const
    )
  );

  const nodes: DepNode[] = inScope.map((s) => {
    const filtered = s.blockedBy.filter(
      // Drop blockers that are direct children in a terminal state — those
      // are satisfied. Any other blocker either is an in-scope sub-issue
      // (handled by topoSort) or surfaces as an external-blocker error.
      (b) => closedAmongDirectChildren.get(b) !== true
    );
    return {
      id: s.identifier,
      blockedBy: filtered,
      closed: TERMINAL_STATE_TYPES.has(s.stateType),
    };
  });

  const result = topoSort(nodes);
  if (!result.ok) {
    if (result.error.kind === "external-blocker") {
      const { issue, blocker } = result.error;
      // The blocker is in the picked PRD's direct children iff it appears in
      // `closedAmongDirectChildren` (which maps every direct child, not just
      // in-scope ones). Distinguish "out-of-scope direct child" from "truly
      // outside the PRD" so the message points at the right fix.
      const blockerDirectChild = subIssues.find(
        (s) => s.identifier === blocker
      );
      if (blockerDirectChild) {
        const labelHint = blockerDirectChild.labels.includes(READY_FOR_HUMAN)
          ? "carries `ready-for-human` (flagged for human review)"
          : "is missing the `ready-for-agent` label";
        return {
          kind: "error",
          message:
            `Sub-issue ${issue} is blocked by ${blocker}, a direct child of the picked PRD that ${labelHint}.\n` +
            `Resolve in Linear: re-add \`ready-for-agent\` to the blocker, remove the relationship, or close the blocker.`,
        };
      }
      return {
        kind: "error",
        message:
          `Sub-issue ${issue} is blocked by ${blocker}, which is open and outside the picked PRD's children.\n` +
          `Resolve by closing the blocker, removing the relationship, or expanding scope.`,
      };
    }
    const edges = result.error.edges
      .map((e) => `  ${e.from} -> ${e.to}`)
      .join("\n");
    return {
      kind: "error",
      message:
        `Dependency graph contains a cycle. Offending edges:\n${edges}\n\n` +
        "Resolve by removing one of the `blocked by` relationships in Linear, then re-run.",
    };
  }

  const byIdentifier = new Map(inScope.map((s) => [s.identifier, s]));
  const ordered: OrderedSubIssue[] = [];
  for (const id of result.order) {
    const sub = byIdentifier.get(id);
    if (!sub) continue;
    ordered.push({ id: sub.id, identifier: sub.identifier, title: sub.title });
  }
  return { kind: "queue", ordered };
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
      parentIdentifier: opts.parentIdentifier,
      parentTitle: opts.parentTitle,
      parentUrl: opts.parentUrl,
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

/**
 * Post-pick orchestration: fetch sub-issues, build the queue, run pre-flight
 * confirms, run the queue, and dispatch to `runPrTailStep` for the PR step.
 * Surfaced as a named export so tests can stub it for early-gate coverage
 * and exercise it directly with stubs for orchestration coverage.
 */
export async function runQueueAfterPick(
  opts: RunQueueAfterPickOptions
): Promise<number> {
  const fetchSubIssuesFn = opts.fetchSubIssues ?? defaultFetchSubIssues;
  const runIssueQueueFn = opts.runIssueQueue ?? defaultRunIssueQueue;
  const runPrTailStepFn = opts.runPrTailStep ?? runPrTailStep;
  const confirmRunFn = opts.confirmRun ?? defaultConfirmRun;
  const confirmPrFn = opts.confirmPr ?? defaultConfirmPr;
  const transitionPrdToInProgressFn =
    opts.transitionPrdToInProgress ?? defaultTransitionToInProgress;

  // Pre-flight: refuse to run from the picked PRD's feature branch. The base
  // branch we resolved at startup is whatever the user invoked `tide run`
  // from; if it matches the PRD's auto-generated `branchName`, the user has
  // already checked out the feature branch and would otherwise stack the new
  // PR on top of itself. Fail before any Linear write or sandbox launch.
  if (opts.picked.branchName === opts.baseBranch) {
    log.error(
      `tide run must be invoked from the base branch, not the feature branch (${opts.baseBranch}). Switch back to your base branch and re-run.`
    );
    outro("Aborted.");
    return 1;
  }

  const subSpin = spinner();
  subSpin.start("Fetching sub-issues from Linear");
  let subIssues: SubIssue[];
  try {
    subIssues = await fetchSubIssuesFn(opts.linearCtx, opts.picked.id);
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

  const branch = opts.picked.branchName;
  const orderedIssues: OrderedIssue[] =
    queue.kind === "standalone"
      ? [
          {
            id: opts.picked.id,
            identifier: opts.picked.identifier,
            title: opts.picked.title,
          },
        ]
      : queue.ordered;

  log.info(`Branch: ${branch}`);
  if (queue.kind === "standalone") {
    log.info(
      "Standalone PRD (no `ready-for-agent` direct children) — running the PRD itself."
    );
  } else {
    log.info("Topo-ordered queue:");
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

  const proceed = await confirmRunFn(orderedIssues.length, branch);
  if (!proceed) {
    cancel("Cancelled before any run() invocation.");
    return 0;
  }

  const prCreationConfirmed = await confirmPrFn();

  // Transition the PRD itself to *In Progress* once the user has committed
  // to running the queue. A cancelled pre-flight (above) leaves the PRD
  // untouched. A failure here is an infra failure — no Linear writes have
  // happened on sub-issues yet, so we abort cleanly.
  try {
    await transitionPrdToInProgressFn(opts.linearCtx, opts.picked.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to transition PRD to In Progress: ${msg}`);
    outro("Aborted.");
    return 1;
  }

  const queueResult = await runIssueQueueFn({
    parentIdentifier: opts.picked.identifier,
    parentId: opts.picked.id,
    orderedIssues,
    branch,
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
    outro("Aborted. Inspect the worktree, fix, and re-run on the same PRD.");
    return 1;
  }

  // Convert ordered queue into the PR-tail's SubIssueRef shape. The PR-tail
  // is an in-flight legacy seam keyed on numeric issue numbers; for the
  // Linear-native flow we surface identifier strings via the title to
  // preserve the existing template's "Sub-issues addressed" list.
  const subIssueRefs: SubIssueRef[] = orderedIssues.map((o, i) => ({
    number: i + 1,
    title: `${o.identifier} ${o.title}`,
  }));

  const tail = await runPrTailStepFn({
    prCreationConfirmed,
    ghRepo: opts.ghRepo,
    branch,
    baseBranch: opts.baseBranch,
    parentIdentifier: opts.picked.identifier,
    parentTitle: opts.picked.title,
    parentUrl: opts.picked.url,
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

  // No-merge warning: any tail outcome other than `opened` means no PR was
  // opened on this run, so Linear's GitHub integration won't auto-transition
  // the PRD to Done on merge. Surface this as a yellow warning so the user
  // can transition the PRD manually if they're shipping outside this run.
  if (tail.outcome.kind !== "opened") {
    log.warn(
      `PRD ${opts.picked.identifier} will not auto-transition. Transition manually in Linear if shipping outside this run.`
    );
  }

  outro(tail.outroMessage);
  return tail.exitCode;
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
  const build = options.build ?? defaultBuild;
  const getGhIdentity = options.getGhIdentity ?? defaultGetGhIdentity;
  const getGhToken = options.getGhToken ?? defaultGetGhToken;
  const listPRDsFn = options.listPRDs ?? defaultListPRDs;
  const pickPRDFn = options.pickPRD ?? defaultPickPRD;
  const runQueueAfterPickFn = options.runQueueAfterPick ?? runQueueAfterPick;

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
  // place. (See PRD: "Sandcastle worktrees and logs land at .tide/...".)
  ensureSandcastleSymlink(repoRoot);

  // Ensure the sandbox image is up to date before any clack UI is started —
  // streamed docker output otherwise interferes with clack rendering.
  const buildExit = await build({ repoRoot, stdout, stderr });
  if (buildExit !== 0) {
    return buildExit;
  }

  intro("tide run");

  // Fetch the PRD list from Linear.
  const fetchSpin = spinner();
  fetchSpin.start("Fetching PRDs from Linear");
  let prds: PRD[];
  try {
    prds = await listPRDsFn({
      apiKey: linearApiKey,
      teamKey: config.linear.team,
    });
  } catch (err) {
    fetchSpin.stop("Linear fetch failed");
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }
  fetchSpin.stop(`Fetched ${String(prds.length)} PRD(s)`);

  if (prds.length === 0) {
    outro(
      "No PRDs to run. Author one in Linear with the `prd` + `ready-for-agent` labels."
    );
    return 0;
  }

  const picked = await pickPRDFn(prds);

  log.info(`Selected: ${picked.identifier} ${picked.title}`);

  return await runQueueAfterPickFn({
    picked,
    ghRepo: { owner: ghIdentity.owner, repo: ghIdentity.repo },
    baseBranch,
    linearCtx: { apiKey: linearApiKey, teamKey: config.linear.team },
    repoRoot,
    config,
    sandboxEnv,
  });
}
