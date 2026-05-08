// Pure-logic helpers + domain types for tide's Linear-native flow.
//
// All I/O against the live `@linear/sdk` (or its in-memory fake) lives in
// `src/services/linear/`. This module owns:
//   - the canonical label / state names (`SETUP_LABEL_NAMES`,
//     `IN_REVIEW_STATE_NAME`)
//   - the domain types consumed across the runner / cli / selector
//     (`PRD`, `StandaloneIssue`, `SubIssue`, `LinearIssueContent`,
//     `SetupLabelResult`, `ProvisionInReviewStateResult`)
//   - the pure helpers that translate workflow-state nodes into ids
//     (`pickWorkflowStateByType`, `pickWorkflowStateByName`)
//   - the repo-prefix helper (`repoTitlePrefix`) used both by the SDK
//     service when constructing list filters and by the doctor / setup
//     copy that names the prefix to the user (ADR-0012).
//
// Workflow-state filtering uses `state.type` (not name) so per-team renames
// of "In Progress" / "Done" don't slip terminal issues through. The
// "In Review" hand-off is the one exception — it is identified by exact
// name constrained to `state.type === "started"`, since Linear's coarse
// type taxonomy lumps "In Progress" and "In Review" together as `started`.

/**
 * Canonical lowercase label names required by the Linear-native flow.
 * `tide setup` ensures all three exist on the configured team.
 */
export const SETUP_LABEL_NAMES = [
  "prd",
  "ready-for-agent",
  "ready-for-human",
] as const;
export type SetupLabelName = (typeof SETUP_LABEL_NAMES)[number];

/**
 * Canonical name of the workflow state tide provisions and uses for the
 * post-PR-submission hand-off. Hardcoded — no per-workspace configuration.
 */
export const IN_REVIEW_STATE_NAME = "In Review";

export interface SetupLabelResult {
  /** Canonical label name. */
  name: SetupLabelName;
  /** True if this label was created by this run; false if it already existed. */
  created: boolean;
}

export interface ProvisionInReviewStateResult {
  /** Always equal to `IN_REVIEW_STATE_NAME` ("In Review"). */
  name: typeof IN_REVIEW_STATE_NAME;
  /** True if this run created the state; false if it was already present. */
  created: boolean;
}

export interface PRD {
  /** Linear's internal UUID for the PRD issue. */
  id: string;
  identifier: string;
  title: string;
  /** Workflow-state name (e.g. "In Progress"). */
  state: string;
  branchName: string;
  url: string;
  updatedAt: Date;
  /** Direct sub-issues carrying the `ready-for-agent` label. */
  readyForAgentCount: number;
  /** Direct sub-issues carrying the `ready-for-human` label. */
  readyForHumanCount: number;
}

export interface StandaloneIssue {
  /** Linear's internal UUID. */
  id: string;
  identifier: string;
  title: string;
  /** Workflow-state name (e.g. "In Progress"). */
  state: string;
  branchName: string;
  url: string;
  updatedAt: Date;
}

export interface SubIssue {
  /** Linear's internal UUID. */
  id: string;
  /** Human-readable identifier (e.g. "ENG-123"). */
  identifier: string;
  title: string;
  /** Workflow-state name (e.g. "In Progress"). */
  state: string;
  /** Workflow-state type (e.g. "started", "completed"). */
  stateType: string;
  /** Label names attached to the issue. */
  labels: string[];
  /** Identifiers of issues that block this one (only `blocks`-type relations). */
  blockedBy: string[];
}

export interface LinearIssueContent {
  identifier: string;
  title: string;
  /** Markdown body (Linear's `description`). */
  body: string;
  /** Comment bodies in chronological order. */
  comments: string[];
}

export interface WorkflowStateRef {
  id: string;
  type: string;
  position: number;
}

/**
 * Pure helper. Given a set of workflow states and a target `state.type`,
 * return the id of the lowest-`position` state with that type, or undefined
 * when no state matches.
 *
 * Resolves states by `type` rather than `name` so per-team renames of
 * "In Progress", "Done", etc. don't break tide.
 */
export function pickWorkflowStateByType(
  states: readonly WorkflowStateRef[],
  type: string
): string | undefined {
  let best: WorkflowStateRef | undefined;
  for (const s of states) {
    if (s.type !== type) continue;
    if (!best || s.position < best.position) best = s;
  }
  return best?.id;
}

export interface NamedWorkflowStateRef {
  id: string;
  name: string;
  type: string;
  position: number;
}

/**
 * Pure helper. Given a set of workflow states, a target `name`, and an
 * optional `state.type` constraint, return the id of the lowest-`position`
 * state matching both, or undefined when no state matches.
 *
 * Complements `pickWorkflowStateByType`. Used to resolve states whose
 * identity is defined by an exact name (e.g. "In Review") rather than by
 * Linear's coarse `state.type` taxonomy. Name match is case-sensitive; the
 * optional `type` argument lets callers reject same-name states of the
 * wrong type. Duplicate-name conflicts are broken deterministically by
 * lowest `position`.
 */
export function pickWorkflowStateByName(
  states: readonly NamedWorkflowStateRef[],
  name: string,
  type?: string
): string | undefined {
  let best: NamedWorkflowStateRef | undefined;
  for (const s of states) {
    if (s.name !== name) continue;
    if (type !== undefined && s.type !== type) continue;
    if (!best || s.position < best.position) best = s;
  }
  return best?.id;
}

/**
 * Build the `[<repoName>] ` title prefix tide filters Linear queries by
 * (ADR-0012). Exact form: open-bracket, repo name, close-bracket, single
 * space — no whitespace tolerance inside the brackets.
 */
export function repoTitlePrefix(repoName: string): string {
  return `[${repoName}] `;
}
