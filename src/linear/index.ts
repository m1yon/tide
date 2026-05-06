// Linear SDK facade for the Linear-native flow. Operations:
//   - listPRDs(ctx): list every issue on the configured team that carries
//     the `prd` label and has at least one direct sub-issue carrying
//     `ready-for-agent`, in a non-terminal workflow state. Each entry
//     carries the count of its direct sub-issues split by
//     `ready-for-agent` / `ready-for-human` label.
//   - listStandaloneIssues(ctx): list every issue on the configured team
//     that carries `ready-for-agent`, has no Linear parent, and does not
//     carry the `prd` label, in a non-terminal workflow state.
//   - fetchSubIssues(ctx, prdId): direct Linear children of a given PRD, with
//     identifier, title, workflow state, label set, and blockedBy relations.
//   - fetchIssueContent(ctx, issueId): the issue's description (markdown
//     body) and the bodies of its comments. Used to hydrate per-iteration
//     prompt args.
//   - flipLabelToReadyForHuman(ctx, issueId): atomically remove the
//     `ready-for-agent` label and add `ready-for-human` in a single
//     `issueUpdate` mutation. Used on BLOCKED + agent-FAIL.
//   - postComment(ctx, issueId, body): create a Linear comment on the issue.
//     Used to post a placeholder note on BLOCKED + agent-FAIL.
//   - setupLabels(ctx): idempotently ensure the three canonical labels exist
//     on the configured team. Used by the `tide setup` subcommand.
//   - pickWorkflowStateByType(states, type): pure helper. Given a set of
//     workflow states and a target `state.type`, returns the id of the
//     lowest-`position` state with that type (or undefined).
//
// Workflow-state filtering uses `state.type` (not name) so per-team renames
// of "In Progress" / "Done" don't slip terminal issues through.
//
// Credentials: `apiKey` is passed in (loaded from `<repoRoot>/.tide/.env` by
// the caller). The team key is also injected so this module is repo-agnostic.

import { LinearClient, PaginationOrderBy } from "@linear/sdk";

const PRD_LABEL = "prd";
const READY_FOR_AGENT_LABEL = "ready-for-agent";
const READY_FOR_HUMAN_LABEL = "ready-for-human";

const NON_TERMINAL_STATE_TYPES = [
  "triage",
  "backlog",
  "unstarted",
  "started",
] as const;

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

export interface SetupLabelResult {
  /** Canonical label name. */
  name: SetupLabelName;
  /** True if this label was created by this run; false if it already existed. */
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

export interface LinearContext {
  apiKey: string;
  teamKey: string;
}

let cachedClient: LinearClient | null = null;
let cachedKey: string | null = null;
function client(apiKey: string): LinearClient {
  if (cachedClient && cachedKey === apiKey) return cachedClient;
  cachedClient = new LinearClient({ apiKey });
  cachedKey = apiKey;
  return cachedClient;
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
 * Filter shape consumed by `listPRDs` via the SDK's `issues` method. The
 * production caller passes the real `LinearClient`; tests pass a hand-rolled
 * stub matching the same shape.
 */
export interface ListPRDsIssueFilter {
  team?: { id: { eq: string } };
  parent?: { id: { eq: string } };
  labels?: { name: { eq: string } };
  and?: ListPRDsIssueFilter[];
  state?: { type: { in: string[] } };
}

/**
 * Filter shape consumed by `listStandaloneIssues` via the SDK's `issues`
 * method. Mirrors the SDK's `IssueCollectionFilter` shape — `parent.null`
 * tests for absence of a Linear parent, and `labels.{some,every}` are used
 * to require the `ready-for-agent` label and forbid the `prd` label
 * respectively.
 */
export interface ListStandaloneIssuesFilter {
  team?: { id: { eq: string } };
  parent?: { null: boolean };
  state?: { type: { in: string[] } };
  labels?:
    | { some: { name: { eq: string } } }
    | { every: { name: { neq: string } } };
  and?: ListStandaloneIssuesFilter[];
}

interface ListPRDsIssueNode {
  id: string;
  identifier: string;
  title: string;
  stateId: string | undefined;
  branchName: string;
  url: string;
  updatedAt: Date;
}

/**
 * Minimal subset of `LinearClient` consumed by `listPRDs`. Surfaced as a
 * named seam so tests can drive the function without mocking the entire SDK.
 *
 * `issues` is invoked twice per call to `listPRDs`: once for the PRD list
 * (filtered by team + labels + non-terminal state.type), and twice per
 * returned PRD for direct sub-issue counts (filtered by parent.id + label).
 */
export interface ListPRDsClient {
  teams(args: { filter: { key: { eq: string } } }): Promise<{
    nodes: { id: string }[];
  }>;
  workflowStates(args: { filter: { team: { id: { eq: string } } } }): Promise<{
    nodes: { id: string; name: string; type: string; position: number }[];
  }>;
  issues(args: {
    filter: ListPRDsIssueFilter;
    orderBy?: PaginationOrderBy;
  }): Promise<{ nodes: ListPRDsIssueNode[] }>;
}

/**
 * List every PRD (issue tagged with `prd` on the configured team, in a
 * non-terminal workflow state, with at least one direct sub-issue carrying
 * `ready-for-agent`) ordered by `updatedAt` desc. Each PRD carries the count
 * of its direct sub-issues split by `ready-for-agent` / `ready-for-human`
 * label.
 *
 * Standalone PRDs — `prd`-labeled issues with zero `ready-for-agent`
 * direct children — are filtered out so they don't clutter the picker.
 *
 * `_client` is a test seam — production callers omit it and the real
 * `LinearClient` is constructed from `ctx.apiKey`.
 */
export async function listPRDs(
  ctx: LinearContext,
  _client?: ListPRDsClient
): Promise<PRD[]> {
  const c: ListPRDsClient = _client ?? client(ctx.apiKey);
  const teamId = await findTeamId(c, ctx.teamKey);

  const [prdConn, statesConn] = await Promise.all([
    c.issues({
      filter: {
        team: { id: { eq: teamId } },
        and: [{ labels: { name: { eq: PRD_LABEL } } }],
        state: { type: { in: [...NON_TERMINAL_STATE_TYPES] } },
      },
      orderBy: PaginationOrderBy.UpdatedAt,
    }),
    c.workflowStates({ filter: { team: { id: { eq: teamId } } } }),
  ]);

  const stateNameById = new Map<string, string>();
  for (const s of statesConn.nodes) stateNameById.set(s.id, s.name);

  const prds: PRD[] = [];
  for (const issue of prdConn.nodes) {
    const [agentChildren, humanChildren] = await Promise.all([
      c.issues({
        filter: {
          parent: { id: { eq: issue.id } },
          labels: { name: { eq: READY_FOR_AGENT_LABEL } },
        },
      }),
      c.issues({
        filter: {
          parent: { id: { eq: issue.id } },
          labels: { name: { eq: READY_FOR_HUMAN_LABEL } },
        },
      }),
    ]);
    if (agentChildren.nodes.length === 0) continue;
    prds.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state:
        typeof issue.stateId === "string"
          ? (stateNameById.get(issue.stateId) ?? "")
          : "",
      branchName: issue.branchName,
      url: issue.url,
      updatedAt: issue.updatedAt,
      readyForAgentCount: agentChildren.nodes.length,
      readyForHumanCount: humanChildren.nodes.length,
    });
  }

  return prds;
}

interface ListStandaloneIssuesIssueNode {
  id: string;
  identifier: string;
  title: string;
  stateId: string | undefined;
  branchName: string;
  url: string;
  updatedAt: Date;
}

/**
 * Minimal subset of `LinearClient` consumed by `listStandaloneIssues`.
 * Surfaced as a named seam so tests can drive the function without mocking
 * the entire SDK.
 */
export interface ListStandaloneIssuesClient {
  teams(args: { filter: { key: { eq: string } } }): Promise<{
    nodes: { id: string }[];
  }>;
  workflowStates(args: { filter: { team: { id: { eq: string } } } }): Promise<{
    nodes: { id: string; name: string; type: string; position: number }[];
  }>;
  issues(args: {
    filter: ListStandaloneIssuesFilter;
    orderBy?: PaginationOrderBy;
  }): Promise<{ nodes: ListStandaloneIssuesIssueNode[] }>;
}

/**
 * List every Standalone Issue (issue tagged with `ready-for-agent` on the
 * configured team, with no Linear parent, not carrying the `prd` label, in
 * a non-terminal workflow state) ordered by `updatedAt` desc.
 *
 * `_client` is a test seam — production callers omit it and the real
 * `LinearClient` is constructed from `ctx.apiKey`.
 */
export async function listStandaloneIssues(
  ctx: LinearContext,
  _client?: ListStandaloneIssuesClient
): Promise<StandaloneIssue[]> {
  const c: ListStandaloneIssuesClient = _client ?? client(ctx.apiKey);
  const teamId = await findTeamId(c, ctx.teamKey);

  const [conn, statesConn] = await Promise.all([
    c.issues({
      filter: {
        team: { id: { eq: teamId } },
        parent: { null: true },
        state: { type: { in: [...NON_TERMINAL_STATE_TYPES] } },
        and: [
          { labels: { some: { name: { eq: READY_FOR_AGENT_LABEL } } } },
          { labels: { every: { name: { neq: PRD_LABEL } } } },
        ],
      },
      orderBy: PaginationOrderBy.UpdatedAt,
    }),
    c.workflowStates({ filter: { team: { id: { eq: teamId } } } }),
  ]);

  const stateNameById = new Map<string, string>();
  for (const s of statesConn.nodes) stateNameById.set(s.id, s.name);

  return conn.nodes.map((issue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    state:
      typeof issue.stateId === "string"
        ? (stateNameById.get(issue.stateId) ?? "")
        : "",
    branchName: issue.branchName,
    url: issue.url,
    updatedAt: issue.updatedAt,
  }));
}

async function findTeamId(
  c: {
    teams(args: {
      filter: { key: { eq: string } };
    }): Promise<{ nodes: { id: string }[] }>;
  },
  teamKey: string
): Promise<string> {
  const teams = await c.teams({ filter: { key: { eq: teamKey } } });
  const team = teams.nodes[0];
  if (!team) {
    throw new Error(
      `Linear team with key "${teamKey}" not found. Check the team key in Linear settings ` +
        `or update the linear.team field in .tide/config.ts.`
    );
  }
  return team.id;
}

/**
 * Minimal subset of `LinearClient` consumed by `setupLabels`. Surfaced as a
 * named seam so tests can drive the function without mocking the entire SDK.
 */
export interface SetupLabelsClient {
  teams(args: {
    filter: { key: { eq: string } };
  }): Promise<{ nodes: { id: string }[] }>;
  issueLabels(args: {
    filter: { team: { id: { eq: string } }; name: { in: string[] } };
  }): Promise<{ nodes: { name: string }[] }>;
  createIssueLabel(args: {
    teamId: string;
    name: string;
  }): Promise<{ success: boolean }>;
}

/**
 * Idempotently ensure the three labels required by the Linear-native flow
 * (`prd`, `ready-for-agent`, `ready-for-human`) exist on the configured team.
 *
 * Returns one entry per canonical label, in `SETUP_LABEL_NAMES` order,
 * indicating whether it was created by this call (`created: true`) or was
 * already present (`created: false`). Missing labels are created with the
 * canonical lowercase names; existing labels (matched exactly, case-sensitive)
 * are left untouched.
 *
 * `_client` is a test seam — production callers omit it and the real
 * `LinearClient` is constructed from `ctx.apiKey`.
 */
export async function setupLabels(
  ctx: LinearContext,
  _client?: SetupLabelsClient
): Promise<SetupLabelResult[]> {
  const c: SetupLabelsClient = _client ?? client(ctx.apiKey);
  const teamId = await findTeamId(c, ctx.teamKey);

  const existing = await c.issueLabels({
    filter: {
      team: { id: { eq: teamId } },
      name: { in: [...SETUP_LABEL_NAMES] },
    },
  });
  const existingNames = new Set<string>();
  for (const node of existing.nodes) existingNames.add(node.name);

  const results: SetupLabelResult[] = [];
  for (const name of SETUP_LABEL_NAMES) {
    if (existingNames.has(name)) {
      results.push({ name, created: false });
      continue;
    }
    const payload = await c.createIssueLabel({ teamId, name });
    if (!payload.success) {
      throw new Error(
        `Linear createIssueLabel for "${name}" returned success=false.`
      );
    }
    results.push({ name, created: true });
  }
  return results;
}

/**
 * Pure GraphQL transport seam used by `fetchSubIssues` / `fetchIssueContent`.
 * Production callers omit this and the implementation wraps the SDK client's
 * underlying `request` (which posts a GraphQL document and returns the
 * parsed `data` payload). Tests provide a stub that returns canned data.
 */
export type LinearGqlRequest = <Data = unknown>(
  query: string,
  variables?: Record<string, unknown>
) => Promise<Data>;

function rawRequest(apiKey: string): LinearGqlRequest {
  const c = client(apiKey);
  return <Data>(query: string, variables?: Record<string, unknown>) =>
    c.client.request<Data, Record<string, unknown>>(query, variables ?? {});
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

const SUB_ISSUES_QUERY = /* GraphQL */ `
  query TideSubIssues($id: String!) {
    issue(id: $id) {
      id
      children(first: 250) {
        nodes {
          id
          identifier
          title
          state {
            name
            type
          }
          labels(first: 50) {
            nodes {
              name
            }
          }
          inverseRelations(first: 50) {
            nodes {
              type
              issue {
                identifier
              }
            }
          }
        }
      }
    }
  }
`;

interface SubIssueGqlNode {
  id: string;
  identifier: string;
  title: string;
  state: { name: string; type: string } | null;
  labels: { nodes: { name: string }[] };
  inverseRelations: {
    nodes: {
      type: string;
      issue: { identifier: string } | null;
    }[];
  };
}

/**
 * Fetch the direct Linear children of `prdId` (an issue UUID). Each entry
 * carries the data the runner needs to topo-sort and dispatch: identifier,
 * title, workflow-state name + type, label names, and `blockedBy`
 * identifiers. Only relations of type `"blocks"` populate `blockedBy`;
 * `"related"` and `"duplicate"` are ignored.
 *
 * Throws when the PRD id does not resolve. Sub-issues whose blocker
 * relation lacks an issue payload (deleted source) are skipped.
 *
 * `_request` is a test seam — production callers omit it.
 */
export async function fetchSubIssues(
  ctx: LinearContext,
  prdId: string,
  _request?: LinearGqlRequest
): Promise<SubIssue[]> {
  const request = _request ?? rawRequest(ctx.apiKey);
  const data = await request<{
    issue: { children: { nodes: SubIssueGqlNode[] } } | null;
  }>(SUB_ISSUES_QUERY, { id: prdId });
  if (!data.issue) {
    throw new Error(`Linear PRD with id "${prdId}" not found.`);
  }
  return data.issue.children.nodes.map((n) => ({
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    state: n.state?.name ?? "",
    stateType: n.state?.type ?? "",
    labels: n.labels.nodes.map((l) => l.name),
    blockedBy: n.inverseRelations.nodes
      .filter((r) => r.type === "blocks" && r.issue !== null)
      .map((r) => {
        if (r.issue === null) throw new Error("unreachable");
        return r.issue.identifier;
      }),
  }));
}

export interface LinearIssueContent {
  identifier: string;
  title: string;
  /** Markdown body (Linear's `description`). */
  body: string;
  /** Comment bodies in chronological order. */
  comments: string[];
}

const ISSUE_CONTENT_QUERY = /* GraphQL */ `
  query TideIssueContent($id: String!) {
    issue(id: $id) {
      identifier
      title
      description
      comments(first: 100) {
        nodes {
          body
        }
      }
    }
  }
`;

interface IssueContentGqlNode {
  identifier: string;
  title: string;
  description: string | null;
  comments: { nodes: { body: string }[] };
}

/**
 * Fetch a single Linear issue's body and comments by UUID. Used by the
 * runner to hydrate per-iteration prompt args for both the in-scope
 * sub-issue and the parent PRD.
 *
 * Throws when the issue id does not resolve.
 *
 * `_request` is a test seam — production callers omit it.
 */
export async function fetchIssueContent(
  ctx: LinearContext,
  issueId: string,
  _request?: LinearGqlRequest
): Promise<LinearIssueContent> {
  const request = _request ?? rawRequest(ctx.apiKey);
  const data = await request<{ issue: IssueContentGqlNode | null }>(
    ISSUE_CONTENT_QUERY,
    { id: issueId }
  );
  if (!data.issue) {
    throw new Error(`Linear issue with id "${issueId}" not found.`);
  }
  return {
    identifier: data.issue.identifier,
    title: data.issue.title,
    body: data.issue.description ?? "",
    comments: data.issue.comments.nodes.map((c) => c.body),
  };
}

const ISSUE_TEAM_STATES_QUERY = /* GraphQL */ `
  query TideIssueTeamStates($id: String!) {
    issue(id: $id) {
      id
      team {
        states(first: 100) {
          nodes {
            id
            name
            type
            position
          }
        }
      }
    }
  }
`;

const ISSUE_TRANSITION_MUTATION = /* GraphQL */ `
  mutation TideIssueTransition($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
    }
  }
`;

interface IssueTeamStatesNode {
  id: string;
  team: {
    states: {
      nodes: { id: string; name: string; type: string; position: number }[];
    };
  };
}

async function transitionIssueTo(
  ctx: LinearContext,
  issueId: string,
  targetStateType: "started" | "completed",
  request: LinearGqlRequest
): Promise<void> {
  const data = await request<{ issue: IssueTeamStatesNode | null }>(
    ISSUE_TEAM_STATES_QUERY,
    { id: issueId }
  );
  if (!data.issue) {
    throw new Error(`Linear issue with id "${issueId}" not found.`);
  }
  const stateId = pickWorkflowStateByType(
    data.issue.team.states.nodes,
    targetStateType
  );
  if (stateId === undefined) {
    throw new Error(
      `No workflow state with type "${targetStateType}" exists on the team for issue "${issueId}". ` +
        `Add or restore a "${targetStateType}"-type state in Linear's team settings.`
    );
  }
  const mutationResult = await request<{
    issueUpdate: { success: boolean };
  }>(ISSUE_TRANSITION_MUTATION, { id: issueId, stateId });
  if (!mutationResult.issueUpdate.success) {
    throw new Error(
      `Linear issueUpdate for "${issueId}" returned success=false.`
    );
  }
}

/**
 * Transition the given Linear issue to its team's lowest-position
 * `started`-type workflow state ("In Progress" by default). The state is
 * resolved by `state.type`, not by name, so per-team renames don't break
 * the transition.
 *
 * Throws when the issue id does not resolve, when the team has no
 * `started`-type state, or when the SDK reports `success: false`.
 *
 * `_request` is a test seam — production callers omit it.
 */
export async function transitionToInProgress(
  ctx: LinearContext,
  issueId: string,
  _request?: LinearGqlRequest
): Promise<void> {
  const request = _request ?? rawRequest(ctx.apiKey);
  await transitionIssueTo(ctx, issueId, "started", request);
}

/**
 * Transition the given Linear issue to its team's lowest-position
 * `completed`-type workflow state ("Done" by default). State resolved by
 * `state.type`, not name.
 *
 * Throws when the issue id does not resolve, when the team has no
 * `completed`-type state, or when the SDK reports `success: false`.
 *
 * `_request` is a test seam — production callers omit it.
 */
export async function transitionToDone(
  ctx: LinearContext,
  issueId: string,
  _request?: LinearGqlRequest
): Promise<void> {
  const request = _request ?? rawRequest(ctx.apiKey);
  await transitionIssueTo(ctx, issueId, "completed", request);
}

/**
 * Transition the given Linear issue to its team's `"In Review"` workflow
 * state. The state is resolved by exact name (case-sensitive) constrained
 * to `state.type === "started"`, so a same-named state of the wrong type
 * does not satisfy the lookup. Duplicate `"In Review"` states with the
 * `started` type are broken by lowest `position`.
 *
 * Unlike `transitionToInProgress` / `transitionToDone`, the target state
 * is identified by name because Linear's `state.type` taxonomy lumps "In
 * Progress" and "In Review" together as `started`. The contract is: the
 * team has a state literally named `"In Review"`, or `tide setup`
 * provisions one.
 *
 * Throws when the issue id does not resolve, when the team has no
 * matching `"In Review"` state (with a hint pointing at `tide setup`), or
 * when the SDK reports `success: false`.
 *
 * `_request` is a test seam — production callers omit it.
 */
export async function transitionToInReview(
  ctx: LinearContext,
  issueId: string,
  _request?: LinearGqlRequest
): Promise<void> {
  const request = _request ?? rawRequest(ctx.apiKey);
  const data = await request<{ issue: IssueTeamStatesNode | null }>(
    ISSUE_TEAM_STATES_QUERY,
    { id: issueId }
  );
  if (!data.issue) {
    throw new Error(`Linear issue with id "${issueId}" not found.`);
  }
  const stateId = pickWorkflowStateByName(
    data.issue.team.states.nodes,
    "In Review",
    "started"
  );
  if (stateId === undefined) {
    throw new Error(
      `No workflow state named "In Review" exists on the team for issue "${issueId}". ` +
        `Run \`tide setup\` to provision it.`
    );
  }
  const mutationResult = await request<{
    issueUpdate: { success: boolean };
  }>(ISSUE_TRANSITION_MUTATION, { id: issueId, stateId });
  if (!mutationResult.issueUpdate.success) {
    throw new Error(
      `Linear issueUpdate for "${issueId}" returned success=false.`
    );
  }
}

const ISSUE_LABELS_FOR_FLIP_QUERY = /* GraphQL */ `
  query TideIssueLabelsForFlip($id: String!) {
    issue(id: $id) {
      id
      labels(first: 50) {
        nodes {
          id
          name
        }
      }
      team {
        labels(first: 200) {
          nodes {
            id
            name
          }
        }
      }
    }
  }
`;

const ISSUE_LABEL_FLIP_MUTATION = /* GraphQL */ `
  mutation TideIssueLabelFlip($id: String!, $labelIds: [String!]!) {
    issueUpdate(id: $id, input: { labelIds: $labelIds }) {
      success
    }
  }
`;

interface IssueLabelsForFlipNode {
  id: string;
  labels: { nodes: { id: string; name: string }[] };
  team: {
    labels: { nodes: { id: string; name: string }[] };
  };
}

/**
 * Atomically flip the given Linear issue's `ready-for-agent` label to
 * `ready-for-human` in a single `issueUpdate` mutation. The mutation passes
 * the full new label-id set, so Linear records this as one edit on the
 * issue's timeline rather than a remove-then-add pair.
 *
 * Behaviour:
 * - Removes `ready-for-agent` if present (idempotent if absent).
 * - Adds `ready-for-human` if not already present (idempotent if present).
 * - All other labels are preserved unchanged.
 *
 * Throws when the issue id does not resolve, when the team has no
 * `ready-for-human` label (run `tide setup`), or when the mutation reports
 * `success: false`.
 *
 * `_request` is a test seam — production callers omit it.
 */
export async function flipLabelToReadyForHuman(
  ctx: LinearContext,
  issueId: string,
  _request?: LinearGqlRequest
): Promise<void> {
  const request = _request ?? rawRequest(ctx.apiKey);
  const data = await request<{ issue: IssueLabelsForFlipNode | null }>(
    ISSUE_LABELS_FOR_FLIP_QUERY,
    { id: issueId }
  );
  if (!data.issue) {
    throw new Error(`Linear issue with id "${issueId}" not found.`);
  }

  const teamLabel = data.issue.team.labels.nodes.find(
    (l) => l.name === READY_FOR_HUMAN_LABEL
  );
  if (!teamLabel) {
    throw new Error(
      `Linear team has no "${READY_FOR_HUMAN_LABEL}" label. Run \`tide setup\` to provision it.`
    );
  }

  const nextLabelIds: string[] = [];
  let alreadyHasReadyForHuman = false;
  for (const l of data.issue.labels.nodes) {
    if (l.name === READY_FOR_AGENT_LABEL) continue;
    if (l.name === READY_FOR_HUMAN_LABEL) alreadyHasReadyForHuman = true;
    nextLabelIds.push(l.id);
  }
  if (!alreadyHasReadyForHuman) nextLabelIds.push(teamLabel.id);

  const mutationResult = await request<{
    issueUpdate: { success: boolean };
  }>(ISSUE_LABEL_FLIP_MUTATION, { id: issueId, labelIds: nextLabelIds });
  if (!mutationResult.issueUpdate.success) {
    throw new Error(
      `Linear issueUpdate (label flip) for "${issueId}" returned success=false.`
    );
  }
}

const COMMENT_CREATE_MUTATION = /* GraphQL */ `
  mutation TideCommentCreate($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
    }
  }
`;

/**
 * Post a comment to the given Linear issue. Used by the runner on BLOCKED /
 * agent-FAIL to leave a placeholder note explaining the label flip.
 *
 * Throws when the mutation reports `success: false`.
 *
 * `_request` is a test seam — production callers omit it.
 */
export async function postComment(
  ctx: LinearContext,
  issueId: string,
  body: string,
  _request?: LinearGqlRequest
): Promise<void> {
  const request = _request ?? rawRequest(ctx.apiKey);
  const result = await request<{
    commentCreate: { success: boolean };
  }>(COMMENT_CREATE_MUTATION, { issueId, body });
  if (!result.commentCreate.success) {
    throw new Error(
      `Linear commentCreate for "${issueId}" returned success=false.`
    );
  }
}
