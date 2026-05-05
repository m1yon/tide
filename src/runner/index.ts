// Per-issue Sandcastle runner loop.
//
// For each Linear sub-issue in topo order, fetch its body+comments (and the
// PRD's body once at the top) from Linear, transition the sub-issue to
// *In Progress* in Linear, build promptArgs via the pure `buildPromptArgs`
// helper, and call `run()` from @ai-hero/sandcastle. On the agent's
// `<promise>DONE</promise>` signal the host transitions the sub-issue to
// *Done*. A run that fails (no commit + no signal, or thrown error) aborts
// the rest of the queue without further Linear writes. Sandcastle preserves
// the worktree on disk on abort.
//
// All Linear writes happen from the host. The sandbox never sees
// LINEAR_API_KEY (ADR-0005). BLOCKED is documented in the prompt for human
// readers but in this slice still routes through the failure path; label
// flips + summarizer come in S5.

import path from "node:path";
import { run, claudeCode, type RunResult } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { log } from "@clack/prompts";
import type { TideConfig } from "../config-loader/index.ts";
import {
  fetchIssueContent as defaultFetchIssueContent,
  transitionToDone as defaultTransitionToDone,
  transitionToInProgress as defaultTransitionToInProgress,
  type LinearContext,
  type LinearIssueContent,
} from "../linear/index.ts";
import { buildPromptArgs } from "../prompt-args/index.ts";

/**
 * Substring tide passes to sandcastle's `completionSignal`. The agent emits
 * this verbatim to mark a successful iteration; sandcastle short-circuits
 * the iteration loop and reports the matched signal back via
 * `RunResult.completionSignal`. The legacy `<promise>COMPLETE</promise>`
 * marker is no longer accepted.
 */
export const DONE_SIGNAL = "<promise>DONE</promise>";

export interface OrderedIssue {
  /** Linear UUID — used to fetch content. */
  id: string;
  /** Human-readable identifier (e.g. "ENG-7") — used in prompt args. */
  identifier: string;
  title: string;
}

export interface RunIssueQueueOptions {
  /** PRD identifier (e.g. "ENG-1") — surfaced in prompt args as PARENT_ID. */
  parentIdentifier: string;
  /** PRD UUID — used to fetch the PRD body once for PRD_CONTENT. */
  parentId: string;
  orderedIssues: OrderedIssue[];
  /** Feature branch the agent commits to. Surfaced as BRANCH in prompt args. */
  branch: string;
  /** Branch the eventual PR will merge into. Feeds the in-prompt `git log
   * <base>..HEAD` recent-commits summary as BASE_BRANCH. */
  baseBranch: string;
  /** Linear API context — apiKey is NOT forwarded into the sandbox. */
  linearCtx: LinearContext;
  // Host repo root — absolute path. The runner uses this to resolve the
  // prompt file path and to anchor sandbox/worktree state.
  repoRoot: string;
  // Tide config (mounts, hooks). LINEAR_API_KEY is intentionally not
  // forwarded into the sandbox (host-side only).
  config: TideConfig;
  // Env map intended for the docker sandbox. Caller is responsible for
  // stripping LINEAR_API_KEY before passing this in.
  sandboxEnv: Record<string, string>;
  /** Test seam — defaults to `linear.fetchIssueContent`. */
  fetchIssueContent?: (
    ctx: LinearContext,
    issueId: string
  ) => Promise<LinearIssueContent>;
  /** Test seam — defaults to `linear.transitionToInProgress`. */
  transitionToInProgress?: (
    ctx: LinearContext,
    issueId: string
  ) => Promise<void>;
  /** Test seam — defaults to `linear.transitionToDone`. */
  transitionToDone?: (ctx: LinearContext, issueId: string) => Promise<void>;
  /** Test seam — defaults to sandcastle's `run`. */
  sandcastleRun?: typeof run;
}

export interface RunIssueQueueResult {
  // Number of sub-issues that ran to completion (DONE signal + at least one
  // commit, transitioned to *Done* in Linear). Sub-issues after the abort
  // point are not counted.
  completed: number;
  // The issue that aborted the loop, if any.
  abortedAt?: {
    identifier: string;
    reason: string;
    preservedWorktreePath?: string;
  };
}

function buildSandbox(
  config: TideConfig,
  env: Record<string, string>
): ReturnType<typeof docker> {
  return docker({
    mounts: config.sandbox.mounts,
    env,
  });
}

/**
 * Dispatch on the iteration's outcome:
 * - `done` — the agent emitted `<promise>DONE</promise>` and committed at
 *   least once. The host transitions the sub-issue to *Done*.
 * - `failed` — anything else (no signal, BLOCKED, DONE without commits).
 *   In this slice routes through the existing failure path: queue aborts
 *   without any Linear write. S5 will refine BLOCKED + agent-FAIL into a
 *   summarizer + label-flip + continue path.
 *
 * Thrown errors are caught at the call-site and reported as infra failures.
 */
function classifyRun(
  result: RunResult
): { kind: "done" } | { kind: "failed"; reason: string } {
  if (result.completionSignal === DONE_SIGNAL && result.commits.length > 0) {
    return { kind: "done" };
  }
  if (result.completionSignal === DONE_SIGNAL) {
    return {
      kind: "failed",
      reason: "agent emitted DONE without committing any changes",
    };
  }
  if (result.commits.length === 0) {
    return {
      kind: "failed",
      reason: "agent emitted no commit and no completion signal",
    };
  }
  return {
    kind: "failed",
    reason: "agent committed but did not emit <promise>DONE</promise>",
  };
}

export async function runIssueQueue(
  options: RunIssueQueueOptions
): Promise<RunIssueQueueResult> {
  const {
    parentIdentifier,
    parentId,
    orderedIssues,
    branch,
    baseBranch,
    linearCtx,
    repoRoot,
    config,
    sandboxEnv,
  } = options;
  const fetchIssueContentFn =
    options.fetchIssueContent ?? defaultFetchIssueContent;
  const transitionToInProgressFn =
    options.transitionToInProgress ?? defaultTransitionToInProgress;
  const transitionToDoneFn =
    options.transitionToDone ?? defaultTransitionToDone;
  const sandcastleRun = options.sandcastleRun ?? run;

  // Fetch the parent body once for PRD_CONTENT — it's stable across the loop.
  const parentContent = await fetchIssueContentFn(linearCtx, parentId);

  // The prompt template lives in the host repo at .tide/prompt.md. run()
  // resolves promptFile against process.cwd() (per its docs), so we pass an
  // absolute path to avoid ambiguity when the user invokes `tide run` from a
  // subdirectory.
  const promptFile = path.join(repoRoot, ".tide", "prompt.md");

  const sandbox = buildSandbox(config, sandboxEnv);

  let completed = 0;
  for (const ordered of orderedIssues) {
    log.info(`Starting ${ordered.identifier}: ${ordered.title}`);

    let issueContent: LinearIssueContent;
    try {
      issueContent = await fetchIssueContentFn(linearCtx, ordered.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to fetch ${ordered.identifier} content: ${msg}`);
      return {
        completed,
        abortedAt: {
          identifier: ordered.identifier,
          reason: `fetch failed: ${msg}`,
        },
      };
    }

    // Transition the sub-issue to *In Progress* before any agent work runs.
    // A failure here is an infra failure: the queue aborts without further
    // Linear writes (matches the "infra FAIL → no label flip" rule).
    try {
      await transitionToInProgressFn(linearCtx, ordered.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        `Failed to transition ${ordered.identifier} to In Progress: ${msg}`
      );
      return {
        completed,
        abortedAt: {
          identifier: ordered.identifier,
          reason: `transition to In Progress failed: ${msg}`,
        },
      };
    }

    const promptArgs = buildPromptArgs({
      issue: issueContent,
      parent: { ...parentContent, identifier: parentIdentifier },
      branch,
      baseBranch,
    });

    let result: RunResult;
    try {
      result = await sandcastleRun({
        name: "tide",
        cwd: repoRoot,
        sandbox,
        agent: claudeCode("claude-opus-4-7"),
        promptFile,
        promptArgs,
        maxIterations: 3,
        branchStrategy: { type: "branch", branch },
        logging: { type: "stdout" },
        // The agent's exit vocabulary is the DONE signal only. BLOCKED is
        // documented in the prompt for human readers but is not surfaced to
        // sandcastle as a stop condition in this slice — its short-circuit
        // path is added with the summarizer in S5.
        completionSignal: DONE_SIGNAL,
        hooks: {
          sandbox: {
            onSandboxReady: config.hooks.onSandboxReady,
          },
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`${ordered.identifier} threw: ${msg}`);
      return {
        completed,
        abortedAt: {
          identifier: ordered.identifier,
          reason: `run() threw: ${msg}`,
        },
      };
    }

    const verdict = classifyRun(result);
    if (verdict.kind === "failed") {
      log.error(`${ordered.identifier} aborted: ${verdict.reason}`);
      return {
        completed,
        abortedAt: {
          identifier: ordered.identifier,
          reason: verdict.reason,
          preservedWorktreePath: result.preservedWorktreePath,
        },
      };
    }

    // DONE signalled and committed → transition the sub-issue to *Done*.
    // A failure here is an infra failure: queue aborts.
    try {
      await transitionToDoneFn(linearCtx, ordered.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to transition ${ordered.identifier} to Done: ${msg}`);
      return {
        completed,
        abortedAt: {
          identifier: ordered.identifier,
          reason: `transition to Done failed: ${msg}`,
        },
      };
    }

    completed++;
    log.success(
      `${ordered.identifier} done (${String(result.commits.length)} commit(s))`
    );
  }

  return { completed };
}
