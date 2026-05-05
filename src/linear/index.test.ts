import { describe, expect, test } from "bun:test";
import {
  SETUP_LABEL_NAMES,
  setupLabels,
  type LinearContext,
  type SetupLabelsClient,
} from "./index.ts";

interface CreateCall {
  teamId: string;
  name: string;
}

interface StubOptions {
  /** Existing labels on the team — by name. */
  existing?: readonly string[];
  /** If a team key matches none of these, `teams` returns []. */
  knownTeamKeys?: readonly string[];
  /** Force `createIssueLabel` to return success: false for these names. */
  createFailFor?: readonly string[];
}

interface Stub {
  client: SetupLabelsClient;
  createCalls: CreateCall[];
}

function buildStub(options: StubOptions = {}): Stub {
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
  ghIssueUrl: (n) => `https://example/${String(n)}`,
};

describe("linear.setupLabels", () => {
  test("creates all three labels on a fresh team", async () => {
    const stub = buildStub({ existing: [] });

    const results = await setupLabels(ctx, stub.client);

    expect(results.map((r) => r.name)).toEqual([...SETUP_LABEL_NAMES]);
    expect(results.every((r) => r.created)).toBe(true);
    expect(stub.createCalls.map((c) => c.name)).toEqual([...SETUP_LABEL_NAMES]);
    for (const call of stub.createCalls) {
      expect(call.teamId).toBe("team-ENG");
    }
  });

  test("is idempotent: all labels already present yields no creates", async () => {
    const stub = buildStub({ existing: [...SETUP_LABEL_NAMES] });

    const results = await setupLabels(ctx, stub.client);

    expect(results.map((r) => r.name)).toEqual([...SETUP_LABEL_NAMES]);
    expect(results.every((r) => !r.created)).toBe(true);
    expect(stub.createCalls).toHaveLength(0);
  });

  test("creates only the missing labels when some already exist", async () => {
    const stub = buildStub({ existing: ["prd"] });

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
    const stub = buildStub({ existing: [] });
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
    const stub = buildStub({ existing: ["PRD"] });

    const results = await setupLabels(ctx, stub.client);

    const prd = results.find((r) => r.name === "prd");
    expect(prd?.created).toBe(true);
    expect(stub.createCalls.some((c) => c.name === "prd")).toBe(true);
  });

  test("throws when the configured team key does not exist", async () => {
    const stub = buildStub({ knownTeamKeys: ["OTHER"] });
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
    const stub = buildStub({ createFailFor: ["ready-for-agent"] });
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
