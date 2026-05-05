// Linear SDK facade. Operations:
//   - createIssueForParent(...): create a new Linear issue on the configured
//     team in "In Progress", assigned to the API key's owner, titled
//     `[GH-#NN] <title>`, tagged with the `PRD` label, with a body linking
//     back to the GitHub parent and listing in-scope sub-issues. Returns
//     `{ branchName, identifier, url }`.
//   - listExistingPRDs(...): list every Linear issue on the configured team
//     that carries the `PRD` label and is in a non-terminal workflow state
//     (state.type in {triage, backlog, unstarted, started}), ordered by
//     `updatedAt` desc. The returned shape carries everything `tide run`
//     needs to use the issue as the run's tracker without a second
//     round-trip.
//   - setupLabels(...): idempotently ensure the three labels required by the
//     Linear-native flow (`prd`, `ready-for-agent`, `ready-for-human`) exist
//     on the configured team. Used by the `tide setup` subcommand.
//
// The `PRD` label is hardcoded, scoped to the configured Linear team, and
// auto-created lazily on first use if missing. See
// docs/adr/0002-prd-label-as-tide-linear-marker.md for the rationale.
//
// Team UUID, PRD label UUID, and "In Progress" workflow-state UUID are
// looked up at runtime via the SDK; failure to find the team or the
// "In Progress" state is a hard exit (caller decides).
//
// Credentials: `apiKey` is passed in (loaded from `<repoRoot>/.tide/.env` by
// the caller). The team key and GitHub URL builder are also injected so this
// module is repo-agnostic.

import { LinearClient, PaginationOrderBy } from "@linear/sdk";

const IN_PROGRESS_STATE_NAME = "In Progress";
const PRD_LABEL_NAME = "PRD";
const ACTIVE_STATE_TYPES = [
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

export interface LinearResult {
  branchName: string;
  identifier: string;
  url: string;
}

export interface ExistingPRD {
  identifier: string;
  title: string;
  /** Workflow-state name (e.g. "In Progress"). */
  state: string;
  branchName: string;
  url: string;
  updatedAt: Date;
}

export interface ParentForLinear {
  number: number;
  title: string;
  url: string;
  subIssues: { number: number; title: string }[];
}

export interface LinearContext {
  apiKey: string;
  teamKey: string;
  /** Builds a GitHub issue URL given an issue number. */
  ghIssueUrl: (number: number) => string;
}

let cachedClient: LinearClient | null = null;
let cachedKey: string | null = null;
function client(apiKey: string): LinearClient {
  if (cachedClient && cachedKey === apiKey) return cachedClient;
  cachedClient = new LinearClient({ apiKey });
  cachedKey = apiKey;
  return cachedClient;
}

async function findTeamId(c: LinearClient, teamKey: string): Promise<string> {
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

async function findInProgressStateId(
  c: LinearClient,
  teamId: string,
  teamKey: string
): Promise<string> {
  // Workflow-state names are scoped per team. Filter on the team to avoid
  // picking up another team's "In Progress".
  const states = await c.workflowStates({
    filter: {
      team: { id: { eq: teamId } },
      name: { eq: IN_PROGRESS_STATE_NAME },
    },
  });
  const state = states.nodes[0];
  if (!state) {
    throw new Error(
      `Workflow state "${IN_PROGRESS_STATE_NAME}" not found on team "${teamKey}". ` +
        `Rename a state in Linear (Settings -> Workflow) so one is named "In Progress".`
    );
  }
  return state.id;
}

// Find the team-scoped `PRD` label, creating it if absent. Tide owns this
// label — see ADR 0002 — so lazy auto-create is the right contract here.
async function findOrCreatePrdLabelId(
  c: LinearClient,
  teamId: string
): Promise<string> {
  const existing = await c.issueLabels({
    filter: {
      team: { id: { eq: teamId } },
      name: { eq: PRD_LABEL_NAME },
    },
  });
  const found = existing.nodes[0];
  if (found) return found.id;

  const payload = await c.createIssueLabel({
    teamId,
    name: PRD_LABEL_NAME,
  });
  if (!payload.success) {
    throw new Error("Linear createIssueLabel returned success=false.");
  }
  const labelId = payload.issueLabelId;
  if (typeof labelId !== "string" || labelId === "") {
    throw new Error("Linear createIssueLabel did not return a label id.");
  }
  return labelId;
}

function buildBody(
  parent: ParentForLinear,
  ghIssueUrl: (n: number) => string
): string {
  const subsBlock =
    parent.subIssues.length === 0
      ? "_(no in-scope sub-issues)_"
      : parent.subIssues
          .map(
            (s) =>
              `- [#${String(s.number)} ${s.title}](${ghIssueUrl(s.number)})`
          )
          .join("\n");
  return [
    `Tracks GitHub PRD [#${String(parent.number)} ${parent.title}](${parent.url}).`,
    "",
    "## In-scope sub-issues",
    "",
    subsBlock,
  ].join("\n");
}

export async function createIssueForParent(
  ctx: LinearContext,
  parent: ParentForLinear
): Promise<LinearResult> {
  const c = client(ctx.apiKey);
  const [teamId, viewer] = await Promise.all([
    findTeamId(c, ctx.teamKey),
    c.viewer,
  ]);
  const [stateId, labelId] = await Promise.all([
    findInProgressStateId(c, teamId, ctx.teamKey),
    findOrCreatePrdLabelId(c, teamId),
  ]);

  const title = `[GH-#${String(parent.number)}] ${parent.title}`;
  const description = buildBody(parent, ctx.ghIssueUrl);

  const payload = await c.createIssue({
    teamId,
    stateId,
    assigneeId: viewer.id,
    labelIds: [labelId],
    title,
    description,
  });
  if (!payload.success) {
    throw new Error("Linear createIssue returned success=false.");
  }
  const issue = await payload.issue;
  if (!issue) {
    throw new Error("Linear createIssue did not return the created issue.");
  }
  return {
    branchName: issue.branchName,
    identifier: issue.identifier,
    url: issue.url,
  };
}

// List every PRD-labelled issue on the configured team in a non-terminal
// workflow state, ordered by `updatedAt` desc. The PRD label is created
// lazily if absent (matching createIssueForParent), which means an empty
// list is a real "no candidates", not a "label is missing" error.
//
// Workflow state is filtered by `type` (not name) so team-level renames of
// "Done"/"Cancelled" don't slip terminal issues into the select.
//
// Workflow-state names are resolved via a single batched lookup of the
// team's states; per-issue `issue.state` would be N+1.
export async function listExistingPRDs(
  ctx: LinearContext
): Promise<ExistingPRD[]> {
  const c = client(ctx.apiKey);
  const teamId = await findTeamId(c, ctx.teamKey);
  // Touch the label to ensure it exists; the issues filter below would
  // simply return [] if the label doesn't exist yet, so the create path
  // here is purely for the create-new branch's later use.
  await findOrCreatePrdLabelId(c, teamId);

  const [issuesConn, statesConn] = await Promise.all([
    c.issues({
      filter: {
        team: { id: { eq: teamId } },
        labels: { name: { eq: PRD_LABEL_NAME } },
        state: { type: { in: [...ACTIVE_STATE_TYPES] } },
      },
      orderBy: PaginationOrderBy.UpdatedAt,
    }),
    c.workflowStates({ filter: { team: { id: { eq: teamId } } } }),
  ]);

  const stateNameById = new Map<string, string>();
  for (const s of statesConn.nodes) stateNameById.set(s.id, s.name);

  return issuesConn.nodes.map((issue) => ({
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
  const teams = await c.teams({ filter: { key: { eq: ctx.teamKey } } });
  const team = teams.nodes[0];
  if (!team) {
    throw new Error(
      `Linear team with key "${ctx.teamKey}" not found. Check the team key in Linear settings ` +
        `or update the linear.team field in .tide/config.ts.`
    );
  }
  const teamId = team.id;

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
