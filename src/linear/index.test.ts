import { describe, expect, test } from "bun:test";
import { PaginationOrderBy } from "@linear/sdk";
import {
  SETUP_LABEL_NAMES,
  fetchIssueContent,
  fetchSubIssues,
  listPRDs,
  pickWorkflowStateByType,
  setupLabels,
  transitionToDone,
  transitionToInProgress,
  type LinearContext,
  type LinearGqlRequest,
  type ListPRDsClient,
  type ListPRDsIssueFilter,
  type SetupLabelsClient,
} from "./index.ts";

interface CreateCall {
  teamId: string;
  name: string;
}

interface SetupStubOptions {
  /** Existing labels on the team — by name. */
  existing?: readonly string[];
  /** If a team key matches none of these, `teams` returns []. */
  knownTeamKeys?: readonly string[];
  /** Force `createIssueLabel` to return success: false for these names. */
  createFailFor?: readonly string[];
}

interface SetupStub {
  client: SetupLabelsClient;
  createCalls: CreateCall[];
}

function buildSetupStub(options: SetupStubOptions = {}): SetupStub {
  const existing = new Set(options.existing ?? []);
  const knownTeamKeys = options.knownTeamKeys ?? ["ENG"];
  const createFailFor = new Set(options.createFailFor ?? []);
  const createCalls: CreateCall[] = [];

  const client: SetupLabelsClient = {
    teams: ({ filter }) => {
      const key = filter.key.eq;
      if (!knownTeamKeys.includes(key)) {
        return Promise.resolve({ nodes: [] });
      }
      return Promise.resolve({ nodes: [{ id: `team-${key}` }] });
    },
    issueLabels: ({ filter }) => {
      const requested = filter.name.in;
      const nodes = requested
        .filter((n) => existing.has(n))
        .map((name) => ({ name }));
      return Promise.resolve({ nodes });
    },
    createIssueLabel: ({ teamId, name }) => {
      createCalls.push({ teamId, name });
      if (createFailFor.has(name)) {
        return Promise.resolve({ success: false });
      }
      existing.add(name);
      return Promise.resolve({ success: true });
    },
  };

  return { client, createCalls };
}

const ctx: LinearContext = {
  apiKey: "lk",
  teamKey: "ENG",
};

describe("linear.setupLabels", () => {
  test("creates all three labels on a fresh team", async () => {
    const stub = buildSetupStub({ existing: [] });

    const results = await setupLabels(ctx, stub.client);

    expect(results.map((r) => r.name)).toEqual([...SETUP_LABEL_NAMES]);
    expect(results.every((r) => r.created)).toBe(true);
    expect(stub.createCalls.map((c) => c.name)).toEqual([...SETUP_LABEL_NAMES]);
    for (const call of stub.createCalls) {
      expect(call.teamId).toBe("team-ENG");
    }
  });

  test("is idempotent: all labels already present yields no creates", async () => {
    const stub = buildSetupStub({ existing: [...SETUP_LABEL_NAMES] });

    const results = await setupLabels(ctx, stub.client);

    expect(results.map((r) => r.name)).toEqual([...SETUP_LABEL_NAMES]);
    expect(results.every((r) => !r.created)).toBe(true);
    expect(stub.createCalls).toHaveLength(0);
  });

  test("creates only the missing labels when some already exist", async () => {
    const stub = buildSetupStub({ existing: ["prd"] });

    const results = await setupLabels(ctx, stub.client);

    const byName = new Map(results.map((r) => [r.name, r.created]));
    expect(byName.get("prd")).toBe(false);
    expect(byName.get("ready-for-agent")).toBe(true);
    expect(byName.get("ready-for-human")).toBe(true);
    expect(stub.createCalls.map((c) => c.name).sort()).toEqual([
      "ready-for-agent",
      "ready-for-human",
    ]);
  });

  test("labels are created with canonical lowercase names", async () => {
    const stub = buildSetupStub({ existing: [] });
    await setupLabels(ctx, stub.client);
    for (const call of stub.createCalls) {
      expect(call.name).toBe(call.name.toLowerCase());
    }
    expect(stub.createCalls.map((c) => c.name)).toEqual([
      "prd",
      "ready-for-agent",
      "ready-for-human",
    ]);
  });

  test("treats label-name match as case-sensitive (legacy `PRD` does not satisfy `prd`)", async () => {
    const stub = buildSetupStub({ existing: ["PRD"] });

    const results = await setupLabels(ctx, stub.client);

    const prd = results.find((r) => r.name === "prd");
    expect(prd?.created).toBe(true);
    expect(stub.createCalls.some((c) => c.name === "prd")).toBe(true);
  });

  test("throws when the configured team key does not exist", async () => {
    const stub = buildSetupStub({ knownTeamKeys: ["OTHER"] });
    let caught: unknown = null;
    try {
      await setupLabels(ctx, stub.client);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/team with key "ENG" not found/);
    expect(stub.createCalls).toHaveLength(0);
  });

  test("throws when createIssueLabel returns success: false", async () => {
    const stub = buildSetupStub({ createFailFor: ["ready-for-agent"] });
    let caught: unknown = null;
    try {
      await setupLabels(ctx, stub.client);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/ready-for-agent/);
  });
});

describe("linear.pickWorkflowStateByType", () => {
  test("returns undefined when no state matches the type", () => {
    const id = pickWorkflowStateByType(
      [
        { id: "s1", type: "started", position: 1 },
        { id: "s2", type: "completed", position: 2 },
      ],
      "backlog"
    );
    expect(id).toBeUndefined();
  });

  test("returns the only matching state's id", () => {
    const id = pickWorkflowStateByType(
      [
        { id: "s1", type: "started", position: 5 },
        { id: "s2", type: "completed", position: 9 },
      ],
      "started"
    );
    expect(id).toBe("s1");
  });

  test("breaks ties by lowest position", () => {
    const id = pickWorkflowStateByType(
      [
        { id: "doing", type: "started", position: 3 },
        { id: "in-progress", type: "started", position: 1 },
        { id: "code-review", type: "started", position: 2 },
      ],
      "started"
    );
    expect(id).toBe("in-progress");
  });

  test("ignores states of other types when computing the lowest-position match", () => {
    const id = pickWorkflowStateByType(
      [
        { id: "todo", type: "unstarted", position: 0 },
        { id: "doing", type: "started", position: 5 },
        { id: "done", type: "completed", position: 0 },
      ],
      "started"
    );
    expect(id).toBe("doing");
  });

  test("returns undefined for an empty input", () => {
    expect(pickWorkflowStateByType([], "started")).toBeUndefined();
  });
});

interface ListPRDsStubOptions {
  knownTeamKeys?: readonly string[];
  prdNodes?: {
    id: string;
    identifier: string;
    title: string;
    stateId: string | undefined;
    branchName: string;
    url: string;
    updatedAt: Date;
  }[];
  states?: { id: string; name: string; type: string; position: number }[];
  /** Map from parent issue id -> {label name -> count}. */
  childCountsByParent?: Record<string, Record<string, number>>;
}

interface ListPRDsStub {
  client: ListPRDsClient;
  /** All `issues` filter args, in invocation order. */
  issuesFilters: ListPRDsIssueFilter[];
  /** All `issues` calls' orderBy, in invocation order (undefined when unset). */
  issuesOrderBys: (PaginationOrderBy | undefined)[];
}

function buildListPRDsStub(options: ListPRDsStubOptions = {}): ListPRDsStub {
  const knownTeamKeys = options.knownTeamKeys ?? ["ENG"];
  const issuesFilters: ListPRDsIssueFilter[] = [];
  const issuesOrderBys: (PaginationOrderBy | undefined)[] = [];

  const client: ListPRDsClient = {
    teams: ({ filter }) => {
      const key = filter.key.eq;
      if (!knownTeamKeys.includes(key)) {
        return Promise.resolve({ nodes: [] });
      }
      return Promise.resolve({ nodes: [{ id: `team-${key}` }] });
    },
    workflowStates: () => Promise.resolve({ nodes: options.states ?? [] }),
    issues: ({ filter, orderBy }) => {
      issuesFilters.push(filter);
      issuesOrderBys.push(orderBy);
      // PRD list call: filter is keyed by `team`. (Stub trusts the production
      // filter shape; the assertions in the tests verify the actual call.)
      if (filter.team !== undefined) {
        return Promise.resolve({ nodes: options.prdNodes ?? [] });
      }
      // Child count call: filter is keyed by `parent`.
      if (filter.parent !== undefined && filter.labels !== undefined) {
        const parentId = filter.parent.id.eq;
        const labelName = filter.labels.name.eq;
        const count = options.childCountsByParent?.[parentId]?.[labelName] ?? 0;
        const nodes = Array.from({ length: count }, (_, i) => ({
          id: `${parentId}-child-${labelName}-${String(i)}`,
          identifier: `CHD-${String(i)}`,
          title: `child ${String(i)}`,
          stateId: undefined,
          branchName: "br",
          url: "u",
          updatedAt: new Date(0),
        }));
        return Promise.resolve({ nodes });
      }
      return Promise.resolve({ nodes: [] });
    },
  };

  return { client, issuesFilters, issuesOrderBys };
}

describe("linear.listPRDs", () => {
  test("queries with prd + ready-for-agent labels and non-terminal state.type", async () => {
    const stub = buildListPRDsStub({
      prdNodes: [],
      states: [],
      childCountsByParent: {},
    });

    await listPRDs(ctx, stub.client);

    // First `issues` call is the PRD list.
    const filter = stub.issuesFilters[0];
    expect(filter).toBeDefined();
    if (!filter) throw new Error("expected at least one issues call");

    // Team filter pinned.
    expect(filter.team?.id.eq).toBe("team-ENG");

    // Both labels required (compound AND, so issues must carry both).
    expect(filter.and).toBeDefined();
    const labelClauses = (filter.and ?? [])
      .map((c) => c.labels?.name.eq)
      .filter((n): n is string => typeof n === "string")
      .sort();
    expect(labelClauses).toEqual(["prd", "ready-for-agent"]);

    // Non-terminal state.type filter applied.
    const stateTypes = filter.state?.type.in;
    expect(stateTypes).toBeDefined();
    if (!stateTypes) throw new Error("expected state.type.in");
    const sorted = [...stateTypes].sort();
    expect(sorted).toEqual(["backlog", "started", "triage", "unstarted"]);

    // Ordered by updatedAt desc.
    expect(stub.issuesOrderBys[0]).toBe(PaginationOrderBy.UpdatedAt);
  });

  test("returns each PRD with sub-issue counts split by ready-for-agent / ready-for-human", async () => {
    const stub = buildListPRDsStub({
      prdNodes: [
        {
          id: "issue-1",
          identifier: "ENG-1",
          title: "Foo",
          stateId: "state-started",
          branchName: "user/feature/eng-1-foo",
          url: "https://linear.app/eng/issue/ENG-1",
          updatedAt: new Date("2026-04-01T00:00:00Z"),
        },
        {
          id: "issue-2",
          identifier: "ENG-2",
          title: "Bar",
          stateId: "state-backlog",
          branchName: "user/feature/eng-2-bar",
          url: "https://linear.app/eng/issue/ENG-2",
          updatedAt: new Date("2026-03-15T00:00:00Z"),
        },
      ],
      states: [
        {
          id: "state-started",
          name: "In Progress",
          type: "started",
          position: 1,
        },
        { id: "state-backlog", name: "Backlog", type: "backlog", position: 0 },
      ],
      childCountsByParent: {
        "issue-1": { "ready-for-agent": 3, "ready-for-human": 1 },
        "issue-2": { "ready-for-agent": 0, "ready-for-human": 2 },
      },
    });

    const prds = await listPRDs(ctx, stub.client);

    expect(prds).toHaveLength(2);
    const a = prds[0];
    const b = prds[1];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (!a || !b) throw new Error("unreachable");

    expect(a.identifier).toBe("ENG-1");
    expect(a.title).toBe("Foo");
    expect(a.state).toBe("In Progress");
    expect(a.branchName).toBe("user/feature/eng-1-foo");
    expect(a.readyForAgentCount).toBe(3);
    expect(a.readyForHumanCount).toBe(1);

    expect(b.identifier).toBe("ENG-2");
    expect(b.state).toBe("Backlog");
    expect(b.readyForAgentCount).toBe(0);
    expect(b.readyForHumanCount).toBe(2);
  });

  test("issues child-count queries scoped by parent id and label name", async () => {
    const stub = buildListPRDsStub({
      prdNodes: [
        {
          id: "issue-A",
          identifier: "ENG-7",
          title: "x",
          stateId: undefined,
          branchName: "b",
          url: "u",
          updatedAt: new Date(0),
        },
      ],
      childCountsByParent: {
        "issue-A": { "ready-for-agent": 1, "ready-for-human": 1 },
      },
    });

    await listPRDs(ctx, stub.client);

    // The first issues call is the PRD list; subsequent calls are child counts.
    const childCalls = stub.issuesFilters.slice(1);
    expect(childCalls).toHaveLength(2);
    for (const f of childCalls) {
      expect(f.parent?.id.eq).toBe("issue-A");
    }
    const labelNames = childCalls
      .map((f) => f.labels?.name.eq)
      .filter((n): n is string => typeof n === "string")
      .sort();
    expect(labelNames).toEqual(["ready-for-agent", "ready-for-human"]);
  });

  test("throws when the configured team key does not exist", async () => {
    const stub = buildListPRDsStub({ knownTeamKeys: ["OTHER"] });
    let caught: unknown = null;
    try {
      await listPRDs(ctx, stub.client);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/team with key "ENG" not found/);
  });

  test("returns an empty list when no PRDs match", async () => {
    const stub = buildListPRDsStub({ prdNodes: [] });
    const prds = await listPRDs(ctx, stub.client);
    expect(prds).toEqual([]);
  });

  test("falls back to empty state name when stateId does not resolve", async () => {
    const stub = buildListPRDsStub({
      prdNodes: [
        {
          id: "issue-x",
          identifier: "ENG-9",
          title: "x",
          stateId: "missing-state",
          branchName: "b",
          url: "u",
          updatedAt: new Date(0),
        },
      ],
      states: [],
      childCountsByParent: { "issue-x": {} },
    });
    const prds = await listPRDs(ctx, stub.client);
    expect(prds[0]?.state).toBe("");
  });
});

interface GqlCall {
  query: string;
  variables: Record<string, unknown>;
}

function makeGqlStub(handler: (call: GqlCall) => unknown): {
  request: LinearGqlRequest;
  calls: GqlCall[];
} {
  const calls: GqlCall[] = [];
  const request: LinearGqlRequest = <Data>(
    query: string,
    variables?: Record<string, unknown>
  ) => {
    const call = { query, variables: variables ?? {} };
    calls.push(call);
    return Promise.resolve(handler(call) as Data);
  };
  return { request, calls };
}

describe("linear.fetchSubIssues", () => {
  test("returns each direct child with identifier, title, state, labels, and blockedBy identifiers", async () => {
    const stub = makeGqlStub(() => ({
      issue: {
        children: {
          nodes: [
            {
              id: "uuid-1",
              identifier: "ENG-10",
              title: "Implement parser",
              state: { name: "In Progress", type: "started" },
              labels: {
                nodes: [{ name: "ready-for-agent" }, { name: "backend" }],
              },
              inverseRelations: { nodes: [] },
            },
            {
              id: "uuid-2",
              identifier: "ENG-11",
              title: "Wire CLI",
              state: { name: "Backlog", type: "backlog" },
              labels: { nodes: [{ name: "ready-for-agent" }] },
              inverseRelations: {
                nodes: [
                  { type: "blocks", issue: { identifier: "ENG-10" } },
                  { type: "related", issue: { identifier: "ENG-99" } },
                ],
              },
            },
          ],
        },
      },
    }));

    const subs = await fetchSubIssues(ctx, "prd-uuid", stub.request);

    expect(subs).toHaveLength(2);
    const a = subs[0];
    const b = subs[1];
    if (!a || !b) throw new Error("unreachable");

    expect(a.id).toBe("uuid-1");
    expect(a.identifier).toBe("ENG-10");
    expect(a.title).toBe("Implement parser");
    expect(a.state).toBe("In Progress");
    expect(a.stateType).toBe("started");
    expect(a.labels.sort()).toEqual(["backend", "ready-for-agent"]);
    expect(a.blockedBy).toEqual([]);

    expect(b.identifier).toBe("ENG-11");
    // Only `blocks`-type relations populate `blockedBy`. The `related`
    // relation to ENG-99 must be filtered out.
    expect(b.blockedBy).toEqual(["ENG-10"]);
  });

  test("queries with the PRD's UUID as the `id` variable", async () => {
    const stub = makeGqlStub(() => ({
      issue: { children: { nodes: [] } },
    }));

    await fetchSubIssues(ctx, "the-prd-uuid", stub.request);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.variables).toEqual({ id: "the-prd-uuid" });
  });

  test("returns an empty list when the PRD has no children", async () => {
    const stub = makeGqlStub(() => ({
      issue: { children: { nodes: [] } },
    }));
    const subs = await fetchSubIssues(ctx, "lonely-prd", stub.request);
    expect(subs).toEqual([]);
  });

  test("throws when the PRD id does not resolve", async () => {
    const stub = makeGqlStub(() => ({ issue: null }));
    let caught: unknown = null;
    try {
      await fetchSubIssues(ctx, "missing-uuid", stub.request);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /PRD with id "missing-uuid" not found/
    );
  });

  test("falls back gracefully when state is null", async () => {
    const stub = makeGqlStub(() => ({
      issue: {
        children: {
          nodes: [
            {
              id: "uuid-x",
              identifier: "ENG-99",
              title: "no state",
              state: null,
              labels: { nodes: [] },
              inverseRelations: { nodes: [] },
            },
          ],
        },
      },
    }));
    const subs = await fetchSubIssues(ctx, "prd", stub.request);
    expect(subs[0]?.state).toBe("");
    expect(subs[0]?.stateType).toBe("");
  });
});

describe("linear.fetchIssueContent", () => {
  test("returns the issue's identifier, title, body, and comment bodies", async () => {
    const stub = makeGqlStub(() => ({
      issue: {
        identifier: "ENG-7",
        title: "Wire authentication",
        description: "Integrate the new auth provider.",
        comments: {
          nodes: [{ body: "Spec looks good." }, { body: "Will start today." }],
        },
      },
    }));

    const content = await fetchIssueContent(ctx, "uuid-7", stub.request);

    expect(content.identifier).toBe("ENG-7");
    expect(content.title).toBe("Wire authentication");
    expect(content.body).toBe("Integrate the new auth provider.");
    expect(content.comments).toEqual(["Spec looks good.", "Will start today."]);
  });

  test("queries with the issue's UUID as the `id` variable", async () => {
    const stub = makeGqlStub(() => ({
      issue: {
        identifier: "ENG-1",
        title: "x",
        description: "",
        comments: { nodes: [] },
      },
    }));
    await fetchIssueContent(ctx, "issue-uuid", stub.request);
    expect(stub.calls[0]?.variables).toEqual({ id: "issue-uuid" });
  });

  test("renders an empty body when description is null", async () => {
    const stub = makeGqlStub(() => ({
      issue: {
        identifier: "ENG-2",
        title: "x",
        description: null,
        comments: { nodes: [] },
      },
    }));
    const content = await fetchIssueContent(ctx, "uuid-2", stub.request);
    expect(content.body).toBe("");
  });

  test("throws when the issue id does not resolve", async () => {
    const stub = makeGqlStub(() => ({ issue: null }));
    let caught: unknown = null;
    try {
      await fetchIssueContent(ctx, "missing-uuid", stub.request);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /issue with id "missing-uuid" not found/
    );
  });
});

interface TransitionStubOptions {
  /** The team's workflow states. */
  states?: { id: string; type: string; position: number }[];
  /** If true, the issue lookup returns null. */
  missingIssue?: boolean;
  /** If true, issueUpdate returns success=false. */
  mutationFailure?: boolean;
}

function makeTransitionStub(opts: TransitionStubOptions = {}): {
  request: LinearGqlRequest;
  calls: GqlCall[];
} {
  const states = opts.states ?? [
    { id: "state-todo", type: "unstarted", position: 0 },
    { id: "state-doing", type: "started", position: 1 },
    { id: "state-done", type: "completed", position: 2 },
  ];
  return makeGqlStub((call) => {
    if (call.query.includes("TideIssueTeamStates")) {
      if (opts.missingIssue) return { issue: null };
      return {
        issue: {
          id: call.variables.id,
          team: { states: { nodes: states } },
        },
      };
    }
    if (call.query.includes("TideIssueTransition")) {
      return {
        issueUpdate: { success: !opts.mutationFailure },
      };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });
}

describe("linear.transitionToInProgress", () => {
  test("resolves the lowest-position `started`-type state and updates the issue", async () => {
    const stub = makeTransitionStub({
      states: [
        { id: "review", type: "started", position: 5 },
        { id: "doing", type: "started", position: 1 },
        { id: "done", type: "completed", position: 9 },
      ],
    });

    await transitionToInProgress(ctx, "issue-uuid", stub.request);

    expect(stub.calls).toHaveLength(2);
    const fetchCall = stub.calls[0];
    const mutateCall = stub.calls[1];
    if (!fetchCall || !mutateCall) throw new Error("unreachable");
    expect(fetchCall.query).toContain("TideIssueTeamStates");
    expect(fetchCall.variables).toEqual({ id: "issue-uuid" });
    expect(mutateCall.query).toContain("TideIssueTransition");
    // Picked state is the lowest-position `started` state, not the
    // `completed` one — verifying state.type-driven resolution.
    expect(mutateCall.variables).toEqual({
      id: "issue-uuid",
      stateId: "doing",
    });
  });

  test("ignores the workflow-state name when resolving (renames don't break)", async () => {
    // Team renamed "In Progress" to "Doing". Resolution by `type` still works.
    const stub = makeTransitionStub({
      states: [
        { id: "doing", type: "started", position: 1 },
        { id: "done", type: "completed", position: 2 },
      ],
    });

    await transitionToInProgress(ctx, "issue-uuid", stub.request);

    const mutateCall = stub.calls[1];
    if (!mutateCall) throw new Error("unreachable");
    expect(mutateCall.variables).toEqual({
      id: "issue-uuid",
      stateId: "doing",
    });
  });

  test("throws when the issue id does not resolve", async () => {
    const stub = makeTransitionStub({ missingIssue: true });
    let caught: unknown = null;
    try {
      await transitionToInProgress(ctx, "missing-uuid", stub.request);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /issue with id "missing-uuid" not found/
    );
    // No mutation issued.
    expect(stub.calls).toHaveLength(1);
  });

  test("throws when the team has no `started`-type state", async () => {
    const stub = makeTransitionStub({
      states: [
        { id: "todo", type: "unstarted", position: 0 },
        { id: "done", type: "completed", position: 9 },
      ],
    });
    let caught: unknown = null;
    try {
      await transitionToInProgress(ctx, "uuid", stub.request);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/started/);
    // No mutation issued.
    expect(stub.calls).toHaveLength(1);
  });

  test("throws when issueUpdate returns success=false", async () => {
    const stub = makeTransitionStub({ mutationFailure: true });
    let caught: unknown = null;
    try {
      await transitionToInProgress(ctx, "uuid", stub.request);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/success=false/);
  });
});

describe("linear.transitionToDone", () => {
  test("resolves the lowest-position `completed`-type state and updates the issue", async () => {
    const stub = makeTransitionStub({
      states: [
        { id: "doing", type: "started", position: 0 },
        { id: "shipped", type: "completed", position: 5 },
        { id: "done", type: "completed", position: 1 },
      ],
    });

    await transitionToDone(ctx, "issue-uuid", stub.request);

    const mutateCall = stub.calls[1];
    if (!mutateCall) throw new Error("unreachable");
    expect(mutateCall.variables).toEqual({
      id: "issue-uuid",
      stateId: "done",
    });
  });

  test("throws when the team has no `completed`-type state", async () => {
    const stub = makeTransitionStub({
      states: [
        { id: "todo", type: "unstarted", position: 0 },
        { id: "doing", type: "started", position: 1 },
      ],
    });
    let caught: unknown = null;
    try {
      await transitionToDone(ctx, "uuid", stub.request);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/completed/);
  });
});
