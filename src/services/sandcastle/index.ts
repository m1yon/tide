// Public surface of the Sandcastle service. Two implementations live
// alongside: `SandcastleSdkService` (composes `@ai-hero/sandcastle`'s
// top-level `run` + `createWorktree` and the `transcript-extract` log
// reader, used in production) and `InMemorySandcastleService` (scripted
// `RunResult` queue + scripted transcript bytes, used in tests). Both
// implement the same `SandcastleService` interface; production code refers
// only to the interface, tests reference the concrete fake type when
// asserting on observed sandcastle invocations (`iterationsRun`,
// `worktreesCreated`, `transcriptsRead`).

import type {
  CreateWorktreeOptions,
  RunOptions,
  RunResult,
  Worktree,
} from "@ai-hero/sandcastle";

/**
 * Tide's sandcastle-facing surface. Replaces the `sandcastleRun?`,
 * `createWorktree?`, and `readFinalAssistantMessage?` test seams that
 * previously decorated `RunIssueQueueOptions`, `cli/run.ts`'s post-pick
 * options, and `pr-submission`.
 */
export interface SandcastleService {
  /** Fire a single sandcastle iteration. Wraps the top-level
   * `sandcastle.run(...)`. The runner uses this for both the working agent
   * and the summarizer; pr-submission uses it for the PR-create iteration. */
  run(options: RunOptions): Promise<RunResult>;

  /** Create (or reuse) a long-lived feature worktree. Wraps
   * `sandcastle.createWorktree(...)`. Tide never closes the returned
   * handle — sandcastle's collision detection reuses an existing managed
   * worktree on the next invocation. */
  createWorktree(options: CreateWorktreeOptions): Promise<Worktree>;

  /** Read a sandcastle log file from disk and extract the agent's final
   * assistant-message text. Composes the pure `transcript-extract` parser. */
  readFinalAssistantMessage(logFilePath: string): Promise<string>;
}

export { SandcastleSdkService } from "./sdk.ts";
export { InMemorySandcastleService } from "./in-memory.ts";
export type { InMemorySandcastleSeed } from "./in-memory.ts";
export { sandcastleServiceContract } from "./contract.ts";
