// In-memory `SandcastleService` implementation. Tests construct it with a
// scripted `RunResult` queue (handed out one per `run()` call in iteration
// order) plus scripted transcript bytes per scenario, and assert on the
// observation methods (`iterationsRun`, `worktreesCreated`,
// `transcriptsRead`) — those are intentionally NOT on the
// `SandcastleService` interface; production code references the interface
// only.
//
// For scenarios where the per-call response must vary based on the run
// options (e.g. the runner dispatches by `opts.name === "tide"` vs
// `"tide-summarizer"`), tests can install a temporary handler via
// `setRunHandler(...)`; the handler is consulted before the queue.
//
// Failure-injection is supported via `failNext(method, error)` — useful
// for testing infra-error paths (sandcastle threw, summarizer crashed,
// transcript read failed) without restructuring the seed.

import type {
  CreateWorktreeOptions,
  RunOptions,
  RunResult,
  Worktree,
} from "@ai-hero/sandcastle";
import type { SandcastleService } from "./index.ts";

/**
 * Seed for an `InMemorySandcastleService`. Every field is optional;
 * defaults behave like a sandcastle that returns a minimal empty
 * `RunResult` per `run()` call, an empty transcript per
 * `readFinalAssistantMessage(...)`, and a stub `Worktree` whose
 * `worktreePath` is derived from the call's `branchStrategy`.
 */
export interface InMemorySandcastleSeed {
  /** Pre-loaded `RunResult` queue; `run()` consumes one per call in
   * iteration order. Once exhausted, the default empty result is returned. */
  runResults?: readonly RunResult[];
  /** Map of `logFilePath -> transcript text`. `readFinalAssistantMessage`
   * looks up the path; misses fall through to the default empty string. */
  transcripts?: Readonly<Record<string, string>>;
  /** Default `worktreePath` returned by `createWorktree` when no
   * per-call handler is installed. The default uses the call's
   * branch-strategy branch when the strategy is `"branch"`. */
  worktreePath?: string;
}

type MethodName = keyof SandcastleService;

const DEFAULT_RUN_RESULT: RunResult = {
  iterations: [],
  stdout: "",
  commits: [],
  branch: "",
};

export class InMemorySandcastleService implements SandcastleService {
  #runQueue: RunResult[];
  #transcripts: Map<string, string>;
  #defaultWorktreePath: string | undefined;

  /** Captured run options, in call order. */
  #iterationsRun: RunOptions[] = [];
  /** Captured createWorktree options, in call order. */
  #worktreesCreated: CreateWorktreeOptions[] = [];
  /** Log paths passed to `readFinalAssistantMessage`, in call order. */
  #transcriptsRead: string[] = [];

  /** Pending one-shot failures by method name. */
  #failures = new Map<MethodName, Error>();

  /** Optional handlers installed by tests for per-call overrides. */
  #runHandler: ((opts: RunOptions) => Promise<RunResult>) | undefined;
  #createWorktreeHandler:
    | ((opts: CreateWorktreeOptions) => Promise<Worktree>)
    | undefined;
  #readTranscriptHandler:
    | ((logFilePath: string) => Promise<string>)
    | undefined;

  constructor(seed: InMemorySandcastleSeed = {}) {
    this.#runQueue = [...(seed.runResults ?? [])];
    this.#transcripts = new Map(Object.entries(seed.transcripts ?? {}));
    this.#defaultWorktreePath = seed.worktreePath;
  }

  // ------- failure injection -------

  /** Make the next call to `method` reject with `error`. One-shot. */
  failNext(method: MethodName, error: Error): void {
    this.#failures.set(method, error);
  }

  // ------- handler overrides for advanced test scenarios -------

  /** Install a per-call `run()` handler. Replaces the queue-based default
   * for as long as the handler is set. Pass `null` to clear. */
  setRunHandler(
    handler: ((opts: RunOptions) => Promise<RunResult>) | null
  ): void {
    this.#runHandler = handler ?? undefined;
  }

  setCreateWorktreeHandler(
    handler: ((opts: CreateWorktreeOptions) => Promise<Worktree>) | null
  ): void {
    this.#createWorktreeHandler = handler ?? undefined;
  }

  setReadTranscriptHandler(
    handler: ((logFilePath: string) => Promise<string>) | null
  ): void {
    this.#readTranscriptHandler = handler ?? undefined;
  }

  // ------- mutable seed accessors -------

  /** Append one or more `RunResult`s to the per-call queue. Useful for
   * tests that mutate state mid-scenario. */
  pushRunResults(...results: readonly RunResult[]): void {
    for (const r of results) this.#runQueue.push(r);
  }

  setTranscript(logFilePath: string, body: string): void {
    this.#transcripts.set(logFilePath, body);
  }

  // ------- observation methods (NOT on the SandcastleService interface) -------

  /** RunOptions captured per `run()` invocation, in call order. */
  iterationsRun(): RunOptions[] {
    return [...this.#iterationsRun];
  }

  /** CreateWorktreeOptions captured per `createWorktree()` invocation. */
  worktreesCreated(): CreateWorktreeOptions[] {
    return [...this.#worktreesCreated];
  }

  /** Log paths passed to `readFinalAssistantMessage`, in call order. */
  transcriptsRead(): string[] {
    return [...this.#transcriptsRead];
  }

  // ------- SandcastleService implementation -------

  run(options: RunOptions): Promise<RunResult> {
    this.#iterationsRun.push(options);
    const failure = this.#failures.get("run");
    if (failure !== undefined) {
      this.#failures.delete("run");
      return Promise.reject(failure);
    }
    if (this.#runHandler) return this.#runHandler(options);
    const next = this.#runQueue.shift();
    return Promise.resolve(next ?? DEFAULT_RUN_RESULT);
  }

  createWorktree(options: CreateWorktreeOptions): Promise<Worktree> {
    this.#worktreesCreated.push(options);
    const failure = this.#failures.get("createWorktree");
    if (failure !== undefined) {
      this.#failures.delete("createWorktree");
      return Promise.reject(failure);
    }
    if (this.#createWorktreeHandler) {
      return this.#createWorktreeHandler(options);
    }
    return Promise.resolve(this.#stubWorktree(options));
  }

  readFinalAssistantMessage(logFilePath: string): Promise<string> {
    this.#transcriptsRead.push(logFilePath);
    const failure = this.#failures.get("readFinalAssistantMessage");
    if (failure !== undefined) {
      this.#failures.delete("readFinalAssistantMessage");
      return Promise.reject(failure);
    }
    if (this.#readTranscriptHandler)
      return this.#readTranscriptHandler(logFilePath);
    return Promise.resolve(this.#transcripts.get(logFilePath) ?? "");
  }

  // ------- internals -------

  #stubWorktree(opts: CreateWorktreeOptions): Worktree {
    const branch =
      opts.branchStrategy.type === "branch" ? opts.branchStrategy.branch : "";
    const worktreePath =
      this.#defaultWorktreePath ??
      `/tmp/in-memory-sandcastle/worktree${branch === "" ? "" : `/${branch}`}`;
    return {
      branch,
      worktreePath,
      run: () =>
        Promise.reject(
          new Error("InMemorySandcastleService: worktree.run not supported")
        ),
      interactive: () =>
        Promise.reject(
          new Error(
            "InMemorySandcastleService: worktree.interactive not supported"
          )
        ),
      createSandbox: () =>
        Promise.reject(
          new Error(
            "InMemorySandcastleService: worktree.createSandbox not supported"
          )
        ),
      close: () => Promise.resolve({}),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    };
  }
}
