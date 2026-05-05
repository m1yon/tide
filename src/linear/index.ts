// Linear SDK facade for the Linear-native flow. Operations:
//   - listPRDs(ctx): list every issue on the configured team that carries
//     both `prd` and `ready-for-agent` labels and is in a non-terminal
//     workflow state. Each entry carries the count of its direct sub-issues
//     split by `ready-for-agent` / `ready-for-human` label.
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
 * List every PRD (issue tagged with both `prd` and `ready-for-agent` on the
 * configured team, in a non-terminal workflow state) ordered by `updatedAt`
 * desc. Each PRD carries the count of its direct sub-issues split by
 * `ready-for-agent` / `ready-for-human` label.
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
        and: [
          { labels: { name: { eq: PRD_LABEL } } },
          { labels: { name: { eq: READY_FOR_AGENT_LABEL } } },
        ],
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
    prds.push({
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
