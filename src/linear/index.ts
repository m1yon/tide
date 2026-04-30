// Linear SDK facade. Two operations only:
//   - createIssueForParent(...): create a new Linear issue on the configured
//     team in "In Progress", assigned to the API key's owner, titled
//     `[GH-#NN] <title>`, with a body linking back to the GitHub parent and
//     listing in-scope sub-issues. Returns `{ branchName, identifier, url }`.
//   - fetchExistingIssue(identifier): fetch an existing Linear issue by its
//     human identifier (e.g. "MEC-680") and return the same triple.
//
// Team UUID and "In Progress" workflow-state UUID are looked up at runtime via
// the SDK; failure to find either is a hard exit (caller decides).
//
// Credentials: `apiKey` is passed in (loaded from `<repoRoot>/.tide/.env` by
// the caller). The team key and GitHub URL builder are also injected so this
// module is repo-agnostic.

import { LinearClient } from "@linear/sdk";

const IN_PROGRESS_STATE_NAME = "In Progress";

export interface LinearResult {
  branchName: string;
  identifier: string;
  url: string;
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
  const stateId = await findInProgressStateId(c, teamId, ctx.teamKey);

  const title = `[GH-#${String(parent.number)}] ${parent.title}`;
  const description = buildBody(parent, ctx.ghIssueUrl);

  const payload = await c.createIssue({
    teamId,
    stateId,
    assigneeId: viewer.id,
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

export async function fetchExistingIssue(
  ctx: LinearContext,
  identifier: string
): Promise<LinearResult> {
  const c = client(ctx.apiKey);
  // The SDK's `issue(id)` accepts both UUIDs and human identifiers like
  // "MEC-680". Throws on not-found / no-access; let it propagate so the
  // caller can re-prompt or hard-exit as appropriate.
  const issue = await c.issue(identifier);
  return {
    branchName: issue.branchName,
    identifier: issue.identifier,
    url: issue.url,
  };
}
