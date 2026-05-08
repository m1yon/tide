// Real `SandcastleService` implementation, composing
// `@ai-hero/sandcastle`'s top-level `run` + `createWorktree` and the pure
// `transcript-extract` log-file reader as constructor-injected
// dependencies. The `transcript-extract` module stays separate because it
// is a parser, not an I/O service; this class merely composes it.

import {
  createWorktree as defaultCreateWorktree,
  run as defaultSandcastleRun,
  type CreateWorktreeOptions,
  type RunOptions,
  type RunResult,
  type Worktree,
} from "@ai-hero/sandcastle";
import { readFinalAssistantMessage as defaultReadFinalAssistantMessage } from "../../transcript-extract/index.ts";
import type { SandcastleService } from "./index.ts";

export class SandcastleSdkService implements SandcastleService {
  readonly #run: (options: RunOptions) => Promise<RunResult>;
  readonly #createWorktree: (
    options: CreateWorktreeOptions
  ) => Promise<Worktree>;
  readonly #readFinalAssistantMessage: (logFilePath: string) => Promise<string>;

  constructor(
    opts: {
      /** Test-only override for the underlying sandcastle `run`. Production
       * callers omit. */
      run?: (options: RunOptions) => Promise<RunResult>;
      /** Test-only override for the underlying sandcastle `createWorktree`. */
      createWorktree?: (options: CreateWorktreeOptions) => Promise<Worktree>;
      /** Test-only override for the transcript-extract reader. */
      readFinalAssistantMessage?: (logFilePath: string) => Promise<string>;
    } = {}
  ) {
    this.#run = opts.run ?? defaultSandcastleRun;
    this.#createWorktree = opts.createWorktree ?? defaultCreateWorktree;
    this.#readFinalAssistantMessage =
      opts.readFinalAssistantMessage ?? defaultReadFinalAssistantMessage;
  }

  run(options: RunOptions): Promise<RunResult> {
    return this.#run(options);
  }

  createWorktree(options: CreateWorktreeOptions): Promise<Worktree> {
    return this.#createWorktree(options);
  }

  readFinalAssistantMessage(logFilePath: string): Promise<string> {
    return this.#readFinalAssistantMessage(logFilePath);
  }
}
