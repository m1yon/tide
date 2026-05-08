// Public surface of the Linear service. Two implementations live alongside:
// `LinearSdkService` (composes `@linear/sdk`'s `LinearClient`, used in
// production) and `InMemoryLinearService` (domain-shaped store used in tests).
// Both implement the same `LinearService` interface; production code refers
// only to the interface, tests reference the concrete fake type when calling
// observation methods (`transitionsOf`, `commentsOn`, `labelsOf`).
//
// Per-instance state — `apiKey`, `teamKey`, `repoName` — is encapsulated in
// each implementation as `private readonly` fields set in the constructor.
// Method signatures take only domain-shaped arguments and return only
// domain-shaped values. The previous `LinearContext` (`{apiKey, teamKey}`)
// type and the per-function `*Client` seam interfaces are gone.

import type {
  LinearIssueContent,
  PRD,
  ProvisionInReviewStateResult,
  SetupLabelResult,
  StandaloneIssue,
  SubIssue,
} from "../../linear/index.ts";

/**
 * Tide's Linear-facing surface. Replaces the per-function `?` seams that
 * previously decorated every orchestration layer's option interfaces.
 */
export interface LinearService {
  /** Verify the API key works against the live Linear API. Used by `tide
   * doctor` for connectivity checks. Throws on failure. */
  viewer(): Promise<void>;

  /** List PRDs visible to this repo: `prd`-labeled team issues with at
   * least one `ready-for-agent` direct sub-issue, in a non-terminal state,
   * whose titles start with the configured `[<repoName>] ` prefix. Ordered
   * by `updatedAt` desc. */
  listPRDs(): Promise<PRD[]>;

  /** List Standalone Issues visible to this repo: `ready-for-agent`-labeled
   * team issues with no Linear parent, no `prd` label, in a non-terminal
   * state, whose titles start with the configured `[<repoName>] ` prefix.
   * Ordered by `updatedAt` desc. */
  listStandaloneIssues(): Promise<StandaloneIssue[]>;

  /** Idempotently ensure the three canonical labels exist on the team. */
  setupLabels(): Promise<SetupLabelResult[]>;

  /** Idempotently ensure the `"In Review"` workflow state exists with the
   * `started` type. */
  provisionInReviewState(): Promise<ProvisionInReviewStateResult>;

  /** Throw with a `tide setup` hint when the team lacks an `"In Review"`
   * `started`-type workflow state. */
  assertInReviewStatePresent(): Promise<void>;

  /** Direct Linear children of `parentId`, scoped by the configured
   * repo-prefix, with identifier, title, workflow state, label set, and
   * `blockedBy` relations. */
  fetchSubIssues(parentId: string): Promise<SubIssue[]>;

  /** Body + comment bodies for the issue. Used to hydrate per-iteration
   * prompt args. */
  fetchIssueContent(issueId: string): Promise<LinearIssueContent>;

  /** Transition to the lowest-position `started`-type state. */
  transitionToInProgress(issueId: string): Promise<void>;

  /** Transition to the lowest-position `completed`-type state. */
  transitionToDone(issueId: string): Promise<void>;

  /** Transition to the team's `"In Review"` `started`-type state. */
  transitionToInReview(issueId: string): Promise<void>;

  /** Atomically swap `ready-for-agent` for `ready-for-human` in one
   * `issueUpdate` mutation, preserving every other label. */
  flipLabelToReadyForHuman(issueId: string): Promise<void>;

  /** Post a Linear comment on the issue. */
  postComment(issueId: string, body: string): Promise<void>;
}

export { LinearSdkService } from "./sdk.ts";
export { InMemoryLinearService } from "./in-memory.ts";
export { linearServiceContract } from "./contract.ts";
