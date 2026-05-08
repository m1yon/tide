// Real `LinearService` implementation, composing `@linear/sdk`'s
// `LinearClient`. Encapsulates `(apiKey, teamKey, repoName)` as
// `private readonly` fields set in the constructor — the previous
// `LinearContext` bag exits the public surface here.

import { LinearClient, PaginationOrderBy } from "@linear/sdk";
import {
  IN_REVIEW_STATE_NAME,
  SETUP_LABEL_NAMES,
  pickWorkflowStateByName,
  pickWorkflowStateByType,
  repoTitlePrefix,
  type LinearIssueContent,
  type PRD,
  type ProvisionInReviewStateResult,
  type SetupLabelResult,
  type StandaloneIssue,
  type SubIssue,
} from "../../linear/index.ts";
import type { LinearService } from "./index.ts";

const PRD_LABEL = "prd";
const READY_FOR_AGENT_LABEL = "ready-for-agent";
const READY_FOR_HUMAN_LABEL = "ready-for-human";

const NON_TERMINAL_STATE_TYPES = [
  "triage",
  "backlog",
  "unstarted",
  "started",
] as const;

const SUB_ISSUES_QUERY = /* GraphQL */ `
  query TideSubIssues($id: String!, $filter: IssueFilter) {
    issue(id: $id) {
      id
      children(first: 250, filter: $filter) {
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

const COMMENT_CREATE_MUTATION = /* GraphQL */ `
  mutation TideCommentCreate($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
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

interface IssueContentGqlNode {
  identifier: string;
  title: string;
  description: string | null;
  comments: { nodes: { body: string }[] };
}

interface IssueTeamStatesNode {
  id: string;
  team: {
    states: {
      nodes: { id: string; name: string; type: string; position: number }[];
    };
  };
}

interface IssueLabelsForFlipNode {
  id: string;
  labels: { nodes: { id: string; name: string }[] };
  team: {
    labels: { nodes: { id: string; name: string }[] };
  };
}

export class LinearSdkService implements LinearService {
  readonly #apiKey: string;
  readonly #teamKey: string;
  readonly #repoName: string;
  readonly #client: LinearClient;
  #teamId: string | undefined;

  constructor(opts: {
    apiKey: string;
    teamKey: string;
    repoName: string;
    /** Test-only override for the underlying SDK client (used by the live-arm
     * contract tests so they can construct the service against a fake
     * transport). Production callers omit this. */
    client?: LinearClient;
  }) {
    this.#apiKey = opts.apiKey;
    this.#teamKey = opts.teamKey;
    this.#repoName = opts.repoName;
    this.#client = opts.client ?? new LinearClient({ apiKey: this.#apiKey });
  }

  async viewer(): Promise<void> {
    const viewer = await this.#client.viewer;
    if (typeof viewer.id !== "string" || viewer.id === "") {
      throw new Error("Linear viewer query returned an empty viewer.id");
    }
  }

  async listPRDs(): Promise<PRD[]> {
    const teamId = await this.#getTeamId();
    const [prdConn, statesConn] = await Promise.all([
      this.#client.issues({
        filter: {
          team: { id: { eq: teamId } },
          and: [{ labels: { name: { eq: PRD_LABEL } } }],
          state: { type: { in: [...NON_TERMINAL_STATE_TYPES] } },
          title: { startsWith: repoTitlePrefix(this.#repoName) },
        },
        orderBy: PaginationOrderBy.UpdatedAt,
      }),
      this.#client.workflowStates({ filter: { team: { id: { eq: teamId } } } }),
    ]);

    const stateNameById = new Map<string, string>();
    for (const s of statesConn.nodes) stateNameById.set(s.id, s.name);

    const prds: PRD[] = [];
    for (const issue of prdConn.nodes) {
      const stateId = issueStateId(issue);
      const [agentChildren, humanChildren] = await Promise.all([
        this.#client.issues({
          filter: {
            parent: { id: { eq: issue.id } },
            labels: { name: { eq: READY_FOR_AGENT_LABEL } },
          },
        }),
        this.#client.issues({
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
          typeof stateId === "string" ? (stateNameById.get(stateId) ?? "") : "",
        branchName: issue.branchName,
        url: issue.url,
        updatedAt: issue.updatedAt,
        readyForAgentCount: agentChildren.nodes.length,
        readyForHumanCount: humanChildren.nodes.length,
      });
    }
    return prds;
  }

  async listStandaloneIssues(): Promise<StandaloneIssue[]> {
    const teamId = await this.#getTeamId();
    const [conn, statesConn] = await Promise.all([
      this.#client.issues({
        filter: {
          team: { id: { eq: teamId } },
          parent: { null: true },
          state: { type: { in: [...NON_TERMINAL_STATE_TYPES] } },
          and: [
            { labels: { some: { name: { eq: READY_FOR_AGENT_LABEL } } } },
            { labels: { every: { name: { neq: PRD_LABEL } } } },
          ],
          title: { startsWith: repoTitlePrefix(this.#repoName) },
        },
        orderBy: PaginationOrderBy.UpdatedAt,
      }),
      this.#client.workflowStates({ filter: { team: { id: { eq: teamId } } } }),
    ]);

    const stateNameById = new Map<string, string>();
    for (const s of statesConn.nodes) stateNameById.set(s.id, s.name);

    const issues: StandaloneIssue[] = [];
    for (const issue of conn.nodes) {
      const stateId = issueStateId(issue);
      issues.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        state:
          typeof stateId === "string" ? (stateNameById.get(stateId) ?? "") : "",
        branchName: issue.branchName,
        url: issue.url,
        updatedAt: issue.updatedAt,
      });
    }
    return issues;
  }

  async setupLabels(): Promise<SetupLabelResult[]> {
    const teamId = await this.#getTeamId();
    const existing = await this.#client.issueLabels({
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
      const payload = await this.#client.createIssueLabel({ teamId, name });
      if (!payload.success) {
        throw new Error(
          `Linear createIssueLabel for "${name}" returned success=false.`
        );
      }
      results.push({ name, created: true });
    }
    return results;
  }

  async provisionInReviewState(): Promise<ProvisionInReviewStateResult> {
    const teamId = await this.#getTeamId();
    const states = await this.#client.workflowStates({
      filter: { team: { id: { eq: teamId } } },
    });

    const existingId = pickWorkflowStateByName(
      states.nodes,
      IN_REVIEW_STATE_NAME,
      "started"
    );
    if (existingId !== undefined) {
      return { name: IN_REVIEW_STATE_NAME, created: false };
    }

    let inProgress: { position: number } | undefined;
    let done: { position: number } | undefined;
    for (const s of states.nodes) {
      if (s.type === "started") {
        if (!inProgress || s.position < inProgress.position) {
          inProgress = { position: s.position };
        }
      } else if (s.type === "completed") {
        if (!done || s.position < done.position) {
          done = { position: s.position };
        }
      }
    }
    if (!inProgress) {
      throw new Error(
        `Linear team has no \`started\`-type workflow state to flank "${IN_REVIEW_STATE_NAME}". ` +
          `Add an "In Progress" state in Linear's team settings, then re-run \`tide setup\`.`
      );
    }
    if (!done) {
      throw new Error(
        `Linear team has no \`completed\`-type workflow state to flank "${IN_REVIEW_STATE_NAME}". ` +
          `Add a "Done" state in Linear's team settings, then re-run \`tide setup\`.`
      );
    }

    const newPosition = (inProgress.position + done.position) / 2;
    const payload = await this.#client.createWorkflowState({
      teamId,
      name: IN_REVIEW_STATE_NAME,
      type: "started",
      color: "#0CA5E9",
      position: newPosition,
    });
    if (!payload.success) {
      throw new Error(
        `Linear createWorkflowState for "${IN_REVIEW_STATE_NAME}" returned success=false.`
      );
    }
    return { name: IN_REVIEW_STATE_NAME, created: true };
  }

  async assertInReviewStatePresent(): Promise<void> {
    const teamId = await this.#getTeamId();
    const states = await this.#client.workflowStates({
      filter: { team: { id: { eq: teamId } } },
    });
    const id = pickWorkflowStateByName(
      states.nodes,
      IN_REVIEW_STATE_NAME,
      "started"
    );
    if (id === undefined) {
      throw new Error(
        `Linear team "${this.#teamKey}" has no \`started\`-type workflow state named "${IN_REVIEW_STATE_NAME}". ` +
          `Run \`tide setup\` to provision it.`
      );
    }
  }

  async fetchSubIssues(parentId: string): Promise<SubIssue[]> {
    const data = await this.#request<{
      issue: { children: { nodes: SubIssueGqlNode[] } } | null;
    }>(SUB_ISSUES_QUERY, {
      id: parentId,
      filter: { title: { startsWith: repoTitlePrefix(this.#repoName) } },
    });
    if (!data.issue) {
      throw new Error(`Linear PRD with id "${parentId}" not found.`);
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

  async fetchIssueContent(issueId: string): Promise<LinearIssueContent> {
    const data = await this.#request<{ issue: IssueContentGqlNode | null }>(
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

  async transitionToInProgress(issueId: string): Promise<void> {
    await this.#transitionTo(issueId, "started");
  }

  async transitionToDone(issueId: string): Promise<void> {
    await this.#transitionTo(issueId, "completed");
  }

  async transitionToInReview(issueId: string): Promise<void> {
    const data = await this.#request<{ issue: IssueTeamStatesNode | null }>(
      ISSUE_TEAM_STATES_QUERY,
      { id: issueId }
    );
    if (!data.issue) {
      throw new Error(`Linear issue with id "${issueId}" not found.`);
    }
    const stateId = pickWorkflowStateByName(
      data.issue.team.states.nodes,
      IN_REVIEW_STATE_NAME,
      "started"
    );
    if (stateId === undefined) {
      throw new Error(
        `No workflow state named "${IN_REVIEW_STATE_NAME}" exists on the team for issue "${issueId}". ` +
          `Run \`tide setup\` to provision it.`
      );
    }
    const mutationResult = await this.#request<{
      issueUpdate: { success: boolean };
    }>(ISSUE_TRANSITION_MUTATION, { id: issueId, stateId });
    if (!mutationResult.issueUpdate.success) {
      throw new Error(
        `Linear issueUpdate for "${issueId}" returned success=false.`
      );
    }
  }

  async flipLabelToReadyForHuman(issueId: string): Promise<void> {
    const data = await this.#request<{ issue: IssueLabelsForFlipNode | null }>(
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

    const mutationResult = await this.#request<{
      issueUpdate: { success: boolean };
    }>(ISSUE_LABEL_FLIP_MUTATION, { id: issueId, labelIds: nextLabelIds });
    if (!mutationResult.issueUpdate.success) {
      throw new Error(
        `Linear issueUpdate (label flip) for "${issueId}" returned success=false.`
      );
    }
  }

  async postComment(issueId: string, body: string): Promise<void> {
    const result = await this.#request<{
      commentCreate: { success: boolean };
    }>(COMMENT_CREATE_MUTATION, { issueId, body });
    if (!result.commentCreate.success) {
      throw new Error(
        `Linear commentCreate for "${issueId}" returned success=false.`
      );
    }
  }

  async #getTeamId(): Promise<string> {
    if (this.#teamId !== undefined) return this.#teamId;
    const teams = await this.#client.teams({
      filter: { key: { eq: this.#teamKey } },
    });
    const team = teams.nodes[0];
    if (!team) {
      throw new Error(
        `Linear team with key "${this.#teamKey}" not found. Check the team key in Linear settings ` +
          `or update the linear.team field in .tide/config.ts.`
      );
    }
    this.#teamId = team.id;
    return team.id;
  }

  async #transitionTo(
    issueId: string,
    targetStateType: "started" | "completed"
  ): Promise<void> {
    const data = await this.#request<{ issue: IssueTeamStatesNode | null }>(
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
    const mutationResult = await this.#request<{
      issueUpdate: { success: boolean };
    }>(ISSUE_TRANSITION_MUTATION, { id: issueId, stateId });
    if (!mutationResult.issueUpdate.success) {
      throw new Error(
        `Linear issueUpdate for "${issueId}" returned success=false.`
      );
    }
  }

  #request<Data>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<Data> {
    return this.#client.client.request<Data, Record<string, unknown>>(
      query,
      variables
    );
  }
}

function issueStateId(issue: { stateId?: string }): string | undefined {
  return issue.stateId;
}
