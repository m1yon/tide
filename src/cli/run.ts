// `tide run` — Linear-native PRD selector.
//
// Steps:
//   1. discover repo root → capture base branch (fail fast on detached HEAD)
//      → load config + env → resolve gh identity
//   2. build sandbox image
//   3. fetch the team's PRDs from Linear (filter: prd + ready-for-agent
//      labels, non-terminal state.type)
//   4. clack-select a PRD; print `Selected: <identifier>` and exit
//
// Queue execution and the PR submission tail step are out of scope for this
// slice — `runPrTailStep` is preserved (and tested) as a stable seam for the
// later slice that will wire the queue back in.

import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { intro, outro, spinner, log } from "@clack/prompts";
import { build as defaultBuild, type BuildOptions } from "./build.ts";
import { loadConfig, type TideConfig } from "../config-loader/index.ts";
import { loadEnv } from "../env-loader/index.ts";
import type { GhRepo } from "../github/index.ts";
import {
  getGhIdentity as defaultGetGhIdentity,
  type GetGhIdentityOptions,
  type GhIdentity,
} from "../gh-identity/index.ts";
import {
  getGhToken as defaultGetGhToken,
  type GetGhTokenOptions,
} from "../gh-token/index.ts";
import {
  listPRDs as defaultListPRDs,
  type LinearContext,
  type PRD,
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
import { pickPRD as defaultPickPRD } from "../selector/index.ts";

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
   * Test seam: shell runner used for the host-side base-branch capture
   * (`git rev-parse --abbrev-ref HEAD`). Defaults to a child_process spawn
   * inside the pr-submission module.
   */
  baseBranchShellRunner?: ShellRunner;
}

export interface RunPrTailStepOptions {
  prCreationConfirmed: boolean;
  ghRepo: GhRepo;
  branch: string;
  baseBranch: string;
  parentNumber: number;
  parentTitle: string;
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
      parentNumber: opts.parentNumber,
      parentTitle: opts.parentTitle,
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
  try {
    await resolveBaseBranch(repoRoot, options.baseBranchShellRunner);
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
  try {
    await getGhIdentity({ repoRoot });
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
  outro(
    `Selected ${picked.identifier}. Queue execution will land in a follow-up slice.`
  );
  return 0;
}
