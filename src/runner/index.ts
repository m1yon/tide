// Per-issue Sandcastle runner loop.
//
// For each issue in topo order, fetch its body+comments (and the parent's
// body once at the top), build promptArgs via the pure `buildPromptArgs`
// helper, and call `run()` from @ai-hero/sandcastle. The first run that
// fails (no commit + no completion signal, or thrown error) aborts the rest
// of the queue. Sandcastle preserves the worktree on disk on abort.
//
// The agent itself closes its GitHub sub-issue (matches the ported prompt
// pattern); the runner makes no `gh issue close` call.

import path from "node:path";
import { run, claudeCode, type RunResult } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { log } from "@clack/prompts";
import type { TideConfig } from "../config-loader/index.ts";
import { fetchIssueContent, type GhRepo } from "../github/index.ts";
import { buildPromptArgs, type IssueContent } from "../prompt-args/index.ts";

export interface OrderedIssue {
  number: number;
  title: string;
}

export interface RunIssueQueueOptions {
  ghRepo: GhRepo;
  orderedIssues: OrderedIssue[];
  branch: string;
  parentNumber: number;
  // Host repo root — absolute path. The runner uses this to resolve the
  // prompt file path and to anchor sandbox/worktree state.
  repoRoot: string;
  // Tide config (mounts, hooks). LINEAR_API_KEY is intentionally not
  // forwarded into the sandbox (host-side only).
  config: TideConfig;
  // Env map from `<repoRoot>/.tide/.env`. Caller is responsible for filtering
  // out `LINEAR_API_KEY` before passing this in (so it never reaches docker).
  sandboxEnv: Record<string, string>;
}

export interface RunIssueQueueResult {
  // Number of issues that ran to completion (committed and/or signalled
  // COMPLETE). Issues after the abort point are not counted.
  completed: number;
  // The issue that aborted the loop, if any.
  abortedAt?: {
    number: number;
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
    ghRepo,
    orderedIssues,
    branch,
    parentNumber,
    repoRoot,
    config,
    sandboxEnv,
  } = options;

  // Fetch the parent body once for PRD_CONTENT — it's stable across the loop.
  const parentContent: IssueContent = await fetchIssueContent(
    ghRepo,
    parentNumber
  );

  // The prompt template lives in the host repo at .tide/prompt.md. run()
  // resolves promptFile against process.cwd() (per its docs), so we pass an
  // absolute path to avoid ambiguity when the user invokes `tide run` from a
  // subdirectory.
  const promptFile = path.join(repoRoot, ".tide", "prompt.md");

  const sandbox = buildSandbox(config, sandboxEnv);

  let completed = 0;
  for (const ordered of orderedIssues) {
    log.info(`Starting #${String(ordered.number)}: ${ordered.title}`);

    let issueContent: IssueContent;
    try {
      issueContent = await fetchIssueContent(ghRepo, ordered.number);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to fetch #${String(ordered.number)} content: ${msg}`);
      return {
        completed,
        abortedAt: {
          number: ordered.number,
          reason: `fetch failed: ${msg}`,
        },
      };
    }

    const promptArgs = buildPromptArgs({
      issue: issueContent,
      parent: parentContent,
      branch,
    });

    let result: RunResult;
    try {
      result = await run({
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
      log.error(`#${String(ordered.number)} threw: ${msg}`);
      return {
        completed,
        abortedAt: {
          number: ordered.number,
          reason: `run() threw: ${msg}`,
        },
      };
    }

    const verdict = isFailedRun(result);
    if (verdict.failed) {
      log.error(`#${String(ordered.number)} aborted: ${verdict.reason}`);
      return {
        completed,
        abortedAt: {
          number: ordered.number,
          reason: verdict.reason,
          preservedWorktreePath: result.preservedWorktreePath,
        },
      };
    }

    completed++;
    log.success(
      `#${String(ordered.number)} done (${String(result.commits.length)} commit(s), signal=${result.completionSignal ?? "none"})`
    );
  }

  return { completed };
}
