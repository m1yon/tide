// Per-issue Sandcastle runner loop.
//
// For each Linear sub-issue in topo order, fetch its body+comments (and the
// PRD's body once at the top) from Linear, build promptArgs via the pure
// `buildPromptArgs` helper, and call `run()` from @ai-hero/sandcastle. The
// first run that fails (no commit + no completion signal, or thrown error)
// aborts the rest of the queue. Sandcastle preserves the worktree on disk
// on abort.
//
// The agent itself closes the matching GitHub issue (matches the ported
// prompt pattern); the runner makes no `gh issue close` call. Linear writes
// (state transitions, label flips, comments) are out of scope for S3 — the
// host does not transition sub-issues from this slice.

import path from "node:path";
import { run, claudeCode, type RunResult } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { log } from "@clack/prompts";
import type { TideConfig } from "../config-loader/index.ts";
import {
  fetchIssueContent as defaultFetchIssueContent,
  type LinearContext,
  type LinearIssueContent,
} from "../linear/index.ts";
import { buildPromptArgs } from "../prompt-args/index.ts";

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
  branch: string;
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
  /** Test seam — defaults to sandcastle's `run`. */
  sandcastleRun?: typeof run;
}

export interface RunIssueQueueResult {
  // Number of issues that ran to completion (committed and/or signalled
  // COMPLETE). Issues after the abort point are not counted.
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

function isFailedRun(
  result: RunResult
): { failed: false } | { failed: true; reason: string } {
  // A failed iteration is "no commit, no COMPLETE emitted". Thrown errors are
  // caught at the call-site and reported separately.
  const committed = result.commits.length > 0;
  const signalled = !!result.completionSignal;
  if (!committed && !signalled) {
    return {
      failed: true,
      reason: "agent emitted no commit and no completion signal",
    };
  }
  return { failed: false };
}

export async function runIssueQueue(
  options: RunIssueQueueOptions
): Promise<RunIssueQueueResult> {
  const {
    parentIdentifier,
    parentId,
    orderedIssues,
    branch,
    linearCtx,
    repoRoot,
    config,
    sandboxEnv,
  } = options;
  const fetchIssueContentFn =
    options.fetchIssueContent ?? defaultFetchIssueContent;
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

    const promptArgs = buildPromptArgs({
      issue: issueContent,
      parent: { ...parentContent, identifier: parentIdentifier },
      branch,
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

    const verdict = isFailedRun(result);
    if (verdict.failed) {
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

    completed++;
    log.success(
      `${ordered.identifier} done (${String(result.commits.length)} commit(s), signal=${result.completionSignal ?? "none"})`
    );
  }

  return { completed };
}
