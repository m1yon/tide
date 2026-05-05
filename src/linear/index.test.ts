import { describe, expect, test } from "bun:test";
import { PaginationOrderBy } from "@linear/sdk";
import {
  SETUP_LABEL_NAMES,
  listPRDs,
  pickWorkflowStateByType,
  setupLabels,
  type LinearContext,
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
