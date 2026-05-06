// Per-issue Sandcastle runner loop.
//
// The whole queue runs against a single, reusable sandcastle Sandbox: tide
// creates one container + worktree at the top of the run via
// `createSandbox(...)`, then calls `sandbox.run(...)` per working-agent
// iteration *and* per summarizer invocation. Logging is forced to
// `{ type: "file" }` (under `<repoRoot>/.tide/logs/`) so the summarizer can
// read the working agent's transcript via the previous run's `logFilePath`.
// The trade-off is silent-by-default progress on the user's terminal — tide
// does not tail the log to stdout. The user inspects the .tide/logs file
// after the run, or tails it themselves in a second terminal.
//
// The runner supports two root kinds via the `root` tagged union:
//   - `kind: "prd"` — the queue iterates over a PRD's `ready-for-agent`
//     sub-issues. The PRD's body is fetched once at the top and threaded
//     through every iteration's prompt args (PRD_CONTENT / PARENT_ID).
//     The PRD-rooted prompt template at `.tide/prompt.md` is used.
//   - `kind: "standalone"` — the queue is a single Standalone Issue. No
//     parent fetch happens; the iteration's prompt args omit the parent
//     keys. The Standalone-Issue template at `.tide/prompt-standalone.md`
//     is used.
//
// For each in-scope Linear issue in topo order:
//   1. Fetch its body+comments (and the PRD's body once at the top, for
//      PRD roots only) from Linear.
//   2. Transition the issue to *In Progress* in Linear.
//   3. Build promptArgs via the pure `buildPromptArgs` helper and call
//      `sandbox.run(...)` with the appropriate prompt template.
//   4. Dispatch on the iteration's outcome:
//        - DONE + commits → host transitions the issue to *Done*; queue
//          continues.
//        - BLOCKED / agent-FAIL → run the summarizer agent in the same
//          sandbox, extract its final assistant message via the
//          `transcript-extract` module, post it as a Linear comment, then
//          flip the issue's label from `ready-for-agent` to
//          `ready-for-human` and continue. If the summarizer itself fails
//          (transcript unparseable, sandbox throws), tide falls back to a
//          short placeholder comment that cites the underlying error.
//        - infra-FAIL (sandcastle threw, content fetch failed, In Progress
//          transition failed) → queue aborts without flipping any label.
//
// All Linear writes happen from the host. The sandbox never sees
// LINEAR_API_KEY (ADR-0005).

import { spawn } from "node:child_process";
import path from "node:path";
import {
  createSandbox as defaultCreateSandbox,
  claudeCode,
  type CreateSandboxOptions,
  type Sandbox,
  type SandboxRunOptions,
  type SandboxRunResult,
} from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { log } from "@clack/prompts";
import type { TideConfig } from "../config-loader/index.ts";
import {
  fetchIssueContent as defaultFetchIssueContent,
  flipLabelToReadyForHuman as defaultFlipLabelToReadyForHuman,
  postComment as defaultPostComment,
  transitionToDone as defaultTransitionToDone,
  transitionToInProgress as defaultTransitionToInProgress,
  type LinearContext,
  type LinearIssueContent,
} from "../linear/index.ts";
import { buildPromptArgs } from "../prompt-args/index.ts";
import { readFinalAssistantMessage as defaultReadFinalAssistantMessage } from "../transcript-extract/index.ts";
import {
  renderSummarizerPrompt,
  type SummarizerPromptKind,
} from "../summarizer-prompts/index.ts";

/**
 * Substring tide passes to sandcastle's `completionSignal`. The agent emits
 * this verbatim to mark a successful iteration; sandcastle short-circuits
 * the iteration loop and reports the matched signal back via
 * `SandboxRunResult.completionSignal`. The legacy `<promise>COMPLETE</promise>`
 * marker is no longer accepted.
 */
export const DONE_SIGNAL = "<promise>DONE</promise>";

/**
 * Substring the agent emits to declare itself gracefully stuck. Sandcastle
 * short-circuits on it just like DONE; the host distinguishes the two via
 * `SandboxRunResult.completionSignal` and routes BLOCKED to the label-flip
 * path.
 */
export const BLOCKED_SIGNAL = "<promise>BLOCKED</promise>";

export interface OrderedIssue {
  /** Linear UUID — used to fetch content. */
  id: string;
  /** Human-readable identifier (e.g. "ENG-7") — used in prompt args. */
  identifier: string;
  title: string;
}

/**
 * Tagged-union descriptor of the root the runner is iterating under. PRD
 * roots have an associated parent issue whose body hydrates every
 * iteration's prompt args; Standalone roots have no parent.
 */
export type RunRoot =
  | { kind: "prd"; id: string; identifier: string }
  | { kind: "standalone" };

/**
 * Test seam type: a function with the same shape as `sandbox.run(...)` from
 * `@ai-hero/sandcastle`. Tests pass a stub; production wires
 * `sandbox.run.bind(sandbox)` of a real `Sandbox` created by
 * `createSandbox(...)`.
 */
export type SandboxRunFn = (
  opts: SandboxRunOptions
) => Promise<SandboxRunResult>;

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Test seam: a child-process-style shell runner. Same shape as the seam
 * already in `pr-submission`. Production wires `defaultShellRunner` (a
 * `node:child_process` spawn); tests pass a stub.
 */
export type ShellRunner = (
  cmd: string,
  args: readonly string[],
  cwd: string
) => Promise<ShellResult>;

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

export interface RunIssueQueueOptions {
  /** Tagged-union root reference. PRD roots fetch the parent body once for
   * PRD_CONTENT / PARENT_ID; Standalone roots skip the parent fetch and
   * omit the parent keys from prompt args. */
  root: RunRoot;
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
  /** Test seam — defaults to `linear.flipLabelToReadyForHuman`. */
  flipLabelToReadyForHuman?: (
    ctx: LinearContext,
    issueId: string
  ) => Promise<void>;
  /** Test seam — defaults to `linear.postComment`. */
  postComment?: (
    ctx: LinearContext,
    issueId: string,
    body: string
  ) => Promise<void>;
  /** Test seam — when provided, no real sandbox is created. The function is
   * called for every working-agent iteration *and* every summarizer
   * iteration. Defaults to `sandbox.run.bind(sandbox)` of a real
   * `Sandbox` built via `createSandbox(...)`. */
  sandboxRun?: SandboxRunFn;
  /** Test seam — defaults to `transcript-extract.readFinalAssistantMessage`.
   * Reads a sandcastle log file from disk and returns the agent's final
   * assistant-message text. */
  readFinalAssistantMessage?: (logFilePath: string) => Promise<string>;
  /** Test seam — defaults to sandcastle's `createSandbox`. */
  createSandbox?: (opts: CreateSandboxOptions) => Promise<Sandbox>;
  /** Test seam — defaults to a `node:child_process` spawn. Used to fire
   * `git push -u origin <branch>` on the host after every working-agent
   * iteration that produced commits. See ADR-0007. */
  shellRunner?: ShellRunner;
}

export interface RunIssueQueueResult {
  // Number of sub-issues that ran to completion (DONE signal + at least one
  // commit, transitioned to *Done* in Linear). Sub-issues after an infra
  // abort are not counted.
  completed: number;
  // Number of sub-issues that were flipped to `ready-for-human` (BLOCKED or
  // agent-FAIL). The queue continues past these; they don't count toward
  // `completed`.
  flipped: number;
  // The issue that aborted the loop on an infra failure, if any.
  abortedAt?: {
    identifier: string;
    reason: string;
    preservedWorktreePath?: string;
  };
}

/**
 * Dispatch on the iteration's outcome:
 * - `done` — the agent emitted `<promise>DONE</promise>` and committed at
 *   least once. The host transitions the sub-issue to *Done*.
 * - `blocked` — the agent emitted `<promise>BLOCKED</promise>`. The host
 *   runs the summarizer, posts the summarizer-generated comment, and flips
 *   the label to `ready-for-human`.
 * - `agent-fail` — any other non-success exit shape (no signal at all,
 *   DONE without commits, commits without DONE). Routed through the same
 *   summarizer + flip + continue path as `blocked`, with a different
 *   prompt template.
 *
 * Thrown errors are caught at the call-site and reported as infra failures
 * — those abort the queue and do not flip any label.
 */
function classifyRun(
  result: SandboxRunResult
):
  | { kind: "done" }
  | { kind: "blocked" }
  | { kind: "agent-fail"; reason: string } {
  if (result.completionSignal === BLOCKED_SIGNAL) {
    return { kind: "blocked" };
  }
  if (result.completionSignal === DONE_SIGNAL && result.commits.length > 0) {
    return { kind: "done" };
  }
  if (result.completionSignal === DONE_SIGNAL) {
    return {
      kind: "agent-fail",
      reason: "agent emitted DONE without committing any changes",
    };
  }
  if (result.commits.length === 0) {
    return {
      kind: "agent-fail",
      reason: "agent emitted no commit and no completion signal",
    };
  }
  return {
    kind: "agent-fail",
    reason: "agent committed but did not emit <promise>DONE</promise>",
  };
}

/**
 * Build the fallback Linear comment posted alongside the label flip when
 * the summarizer itself fails (transcript unparseable, sandbox throws,
 * empty extracted message). Cites the underlying error so a human reading
 * the comment knows tide tried and gave up — not that the agent's
 * transcript was clean.
 */
function buildFallbackComment(
  kind: "blocked" | "agent-fail",
  agentFailReason: string | undefined,
  summarizerError: string
): string {
  const reasonLabel = kind === "blocked" ? "BLOCKED" : "FAIL";
  const lines: string[] = [
    `Tide flipped this to \`ready-for-human\`. Reason: ${reasonLabel}.`,
  ];
  if (kind === "agent-fail" && agentFailReason !== undefined) {
    lines.push(`Detail: ${agentFailReason}.`);
  }
  lines.push(
    `Summarizer-agent fallback: ${summarizerError}. See the run's log file for the full transcript.`
  );
  return lines.join("\n");
}

/**
 * Run the summarizer agent inside the same sandbox, read its final
 * assistant message back from its log file, and return the comment body.
 * Throws on any failure; the caller falls back to a placeholder comment.
 *
 * For Standalone Issue roots there is no parent PRD; `parentContent` /
 * `parentIdentifier` are undefined and the rendered prompt's parent fields
 * fall through to empty placeholders.
 */
async function runSummarizer(args: {
  kind: SummarizerPromptKind;
  workingAgentLogFilePath: string | undefined;
  parentContent: LinearIssueContent | undefined;
  parentIdentifier: string | undefined;
  issueContent: LinearIssueContent;
  sandboxRun: SandboxRunFn;
  readFinalAssistantMessage: (logFilePath: string) => Promise<string>;
  summarizerLogPath: string;
}): Promise<string> {
  if (args.workingAgentLogFilePath === undefined) {
    throw new Error("working agent did not produce a log file");
  }
  const transcript = await args.readFinalAssistantMessage(
    args.workingAgentLogFilePath
  );

  const renderedPrompt = renderSummarizerPrompt(args.kind, {
    issueIdentifier: args.issueContent.identifier,
    issueTitle: args.issueContent.title,
    issueBody: args.issueContent.body,
    parentIdentifier: args.parentIdentifier ?? "",
    parentTitle: args.parentContent?.title ?? "",
    parentBody: args.parentContent?.body ?? "",
    transcript,
  });

  const summarizerResult = await args.sandboxRun({
    name: "tide-summarizer",
    agent: claudeCode("claude-opus-4-7"),
    prompt: renderedPrompt,
    maxIterations: 1,
    logging: { type: "file", path: args.summarizerLogPath },
  });

  const logFilePath = summarizerResult.logFilePath ?? args.summarizerLogPath;
  const commentBody = await args.readFinalAssistantMessage(logFilePath);
  if (commentBody.trim() === "") {
    throw new Error("summarizer produced an empty final message");
  }
  return commentBody;
}

/**
 * Fire `git push -u origin <branch>` on the host. Failures are warn-and-
 * continue: per ADR-0007, the queue does not abort on push failure, no
 * Linear state is mutated, and the next iteration's push naturally carries
 * forward the previously-missed commits. `-u` sets upstream on the first
 * push and is a harmless no-op afterwards. With no new commits the call is
 * a no-op on the remote, so callers in the throw-then-push path don't have
 * to gate on commit count.
 */
async function pushBranchToOrigin(
  shellRunner: ShellRunner,
  repoRoot: string,
  branch: string
): Promise<void> {
  let result: ShellResult;
  try {
    result = await shellRunner(
      "git",
      ["push", "-u", "origin", branch],
      repoRoot
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`git push -u origin ${branch} threw: ${msg} — continuing`);
    return;
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    log.warn(
      `git push -u origin ${branch} failed (exit ${String(result.exitCode)})${stderr === "" ? "" : `: ${stderr}`} — continuing`
    );
  }
}

/**
 * Build the path under `<repoRoot>/.tide/logs/` where one specific run's
 * log file lands. Sandcastle's default file path lives under
 * `.sandcastle/logs/` (which the host bridges to `.tide/logs/` via a
 * symlink), but tide names the file deterministically per-issue per-role
 * so the working-agent log and its summarizer log don't collide and so
 * runs are easy to locate after the fact.
 */
function buildLogPath(args: {
  repoRoot: string;
  branch: string;
  identifier: string;
  role: "working" | "summarizer-blocked" | "summarizer-fail";
}): string {
  const safeBranch = args.branch.replace(/[^A-Za-z0-9._-]/g, "-");
  const safeIdentifier = args.identifier.replace(/[^A-Za-z0-9._-]/g, "-");
  const filename = `${safeBranch}-${safeIdentifier}-${args.role}.log`;
  return path.join(args.repoRoot, ".tide", "logs", filename);
}

export async function runIssueQueue(
  options: RunIssueQueueOptions
): Promise<RunIssueQueueResult> {
  const {
    root,
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
  const flipLabelFn =
    options.flipLabelToReadyForHuman ?? defaultFlipLabelToReadyForHuman;
  const postCommentFn = options.postComment ?? defaultPostComment;
  const readFinalAssistantMessage =
    options.readFinalAssistantMessage ?? defaultReadFinalAssistantMessage;
  const createSandboxFn = options.createSandbox ?? defaultCreateSandbox;
  const shellRunner = options.shellRunner ?? defaultShellRunner;

  // PRD root: fetch the parent body once for PRD_CONTENT — it's stable
  // across the loop. Standalone root: no parent to fetch.
  const parentContent: LinearIssueContent | undefined =
    root.kind === "prd"
      ? await fetchIssueContentFn(linearCtx, root.id)
      : undefined;

  // The prompt template lives in the host repo at .tide/. The PRD-rooted
  // template is the long-standing `prompt.md`; the Standalone-Issue
  // template `prompt-standalone.md` drops the "Parent PRD" section. The
  // sandcastle SDK resolves promptFile against process.cwd() (per its
  // docs), so we pass an absolute path to avoid ambiguity when the user
  // invokes `tide run` from a subdirectory.
  const promptFileName =
    root.kind === "prd" ? "prompt.md" : "prompt-standalone.md";
  const promptFile = path.join(repoRoot, ".tide", promptFileName);

  // Either use the test-supplied sandboxRun seam, or eagerly create one
  // sandbox for the entire queue. The reusable-sandbox shape lets us share
  // the docker container + worktree across every working-agent iteration
  // *and* every summarizer call — see ADR-0005 / S6.
  let sandboxRun: SandboxRunFn;
  let sandbox: Sandbox | undefined;
  if (options.sandboxRun !== undefined) {
    sandboxRun = options.sandboxRun;
  } else {
    sandbox = await createSandboxFn({
      branch,
      baseBranch,
      cwd: repoRoot,
      sandbox: docker({
        mounts: config.sandbox.mounts,
        env: sandboxEnv,
      }),
      hooks: {
        sandbox: {
          onSandboxReady: config.hooks.onSandboxReady,
        },
      },
    });
    sandboxRun = sandbox.run.bind(sandbox);
  }

  let completed = 0;
  let flipped = 0;
  try {
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
          flipped,
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
          flipped,
          abortedAt: {
            identifier: ordered.identifier,
            reason: `transition to In Progress failed: ${msg}`,
          },
        };
      }

      const promptArgs = buildPromptArgs({
        issue: issueContent,
        parent:
          root.kind === "prd" && parentContent !== undefined
            ? { ...parentContent, identifier: root.identifier }
            : undefined,
      });

      const workingLogPath = buildLogPath({
        repoRoot,
        branch,
        identifier: ordered.identifier,
        role: "working",
      });

      let result: SandboxRunResult;
      try {
        result = await sandboxRun({
          name: "tide",
          agent: claudeCode("claude-opus-4-7"),
          promptFile,
          promptArgs,
          maxIterations: 3,
          logging: { type: "file", path: workingLogPath },
          // Agent exit vocabulary: DONE for success, BLOCKED for graceful
          // give-up. Sandcastle short-circuits on either; the host
          // distinguishes them via `SandboxRunResult.completionSignal`.
          completionSignal: [DONE_SIGNAL, BLOCKED_SIGNAL],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`${ordered.identifier} threw: ${msg}`);
        // The agent may have committed before the throw; those commits are
        // real on disk via the bind mount. Push best-effort so partial work
        // ships before the queue aborts. `git push` with no new commits is
        // a no-op, so we don't gate on commit count here.
        await pushBranchToOrigin(shellRunner, repoRoot, branch);
        return {
          completed,
          flipped,
          abortedAt: {
            identifier: ordered.identifier,
            reason: `run() threw: ${msg}`,
          },
        };
      }

      // Per ADR-0007: push after every working-agent iteration that
      // produced commits, regardless of the iteration's classification
      // (DONE, BLOCKED, or agent-FAIL). Push failure is warn-and-continue;
      // Linear state is not touched by push failure.
      if (result.commits.length > 0) {
        await pushBranchToOrigin(shellRunner, repoRoot, branch);
      }

      const verdict = classifyRun(result);
      if (verdict.kind === "blocked" || verdict.kind === "agent-fail") {
        const reasonLabel = verdict.kind === "blocked" ? "BLOCKED" : "FAIL";
        const detail =
          verdict.kind === "agent-fail" ? verdict.reason : undefined;
        log.warn(
          `${ordered.identifier} ${reasonLabel}${detail ? `: ${detail}` : ""} — running summarizer and flipping to ready-for-human`
        );

        // Step 1 (best-effort): run the summarizer and capture its final
        // assistant message. On any failure, fall back to a short
        // placeholder that cites the underlying error so the human knows
        // tide tried and gave up — not that the agent's transcript was
        // clean.
        const summarizerKind: SummarizerPromptKind =
          verdict.kind === "blocked" ? "blocked" : "fail";
        const summarizerLogPath = buildLogPath({
          repoRoot,
          branch,
          identifier: ordered.identifier,
          role:
            summarizerKind === "blocked"
              ? "summarizer-blocked"
              : "summarizer-fail",
        });
        let commentBody: string;
        try {
          commentBody = await runSummarizer({
            kind: summarizerKind,
            workingAgentLogFilePath: result.logFilePath,
            parentContent,
            parentIdentifier: root.kind === "prd" ? root.identifier : undefined,
            issueContent,
            sandboxRun,
            readFinalAssistantMessage,
            summarizerLogPath,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(
            `Summarizer failed for ${ordered.identifier}: ${msg} — using fallback comment`
          );
          commentBody = buildFallbackComment(verdict.kind, detail, msg);
        }

        // Step 2: flip the label first (the queue-gating signal), then post
        // the comment. A failure on either is an infra failure and aborts.
        try {
          await flipLabelFn(linearCtx, ordered.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(
            `Failed to flip ${ordered.identifier} to ready-for-human: ${msg}`
          );
          return {
            completed,
            flipped,
            abortedAt: {
              identifier: ordered.identifier,
              reason: `label flip failed: ${msg}`,
            },
          };
        }
        try {
          await postCommentFn(linearCtx, ordered.id, commentBody);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`Failed to post comment on ${ordered.identifier}: ${msg}`);
          return {
            completed,
            flipped,
            abortedAt: {
              identifier: ordered.identifier,
              reason: `comment post failed: ${msg}`,
            },
          };
        }
        flipped++;
        continue;
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
          flipped,
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

    return { completed, flipped };
  } finally {
    if (sandbox !== undefined) {
      await sandbox.close().catch(() => {
        /* swallow close errors — they are best-effort cleanup */
      });
    }
  }
}
