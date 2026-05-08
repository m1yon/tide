// Pure-helper tests for the trimmed `src/linear/` module. The
// SDK-translation tests that used to live here have moved to
// `src/services/linear/sdk.long.test.ts` (live arm) and
// `src/services/linear/in-memory.test.ts` (in-memory arm). What remains is
// the small set of pure functions the runner / cli still call directly
// (workflow-state pickers + the repo-prefix helper).

import { describe, expect, test } from "bun:test";
import {
  pickWorkflowStateByName,
  pickWorkflowStateByType,
  repoTitlePrefix,
} from "./index.ts";

describe("repoTitlePrefix", () => {
  test("renders the canonical `[<repoName>] ` form (open-bracket, repo, close-bracket, single space)", () => {
    expect(repoTitlePrefix("tide")).toBe("[tide] ");
  });

  test("trailing space is exact — no whitespace tolerance inside the brackets either", () => {
    // Exact byte form is the contract (ADR-0012). A regression that strips
    // the trailing space would silently match a `[tide]bug` title; a
    // regression that inserts whitespace inside would silently fail to
    // match `[tide] bug`.
    const p = repoTitlePrefix("tide");
    expect(p.endsWith(" ")).toBe(true);
    expect(p).not.toMatch(/\[\s/);
    expect(p).not.toMatch(/\s\]/);
  });
});

describe("pickWorkflowStateByType", () => {
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

describe("pickWorkflowStateByName", () => {
  test("returns the matching state's id when present", () => {
    const id = pickWorkflowStateByName(
      [
        { id: "s-doing", name: "In Progress", type: "started", position: 1 },
        { id: "s-review", name: "In Review", type: "started", position: 2 },
        { id: "s-done", name: "Done", type: "completed", position: 3 },
      ],
      "In Review"
    );
    expect(id).toBe("s-review");
  });

  test("returns undefined when no state matches the name", () => {
    const id = pickWorkflowStateByName(
      [
        { id: "s-doing", name: "In Progress", type: "started", position: 1 },
        { id: "s-done", name: "Done", type: "completed", position: 2 },
      ],
      "In Review"
    );
    expect(id).toBeUndefined();
  });

  test("returns undefined for an empty input", () => {
    expect(pickWorkflowStateByName([], "In Review")).toBeUndefined();
  });

  test("type filter excludes a same-name state of the wrong type", () => {
    // A team that has accidentally created an "In Review" state of the
    // wrong `type` (e.g. `unstarted` instead of `started`) must not be
    // resolved when the caller constrains by type.
    const id = pickWorkflowStateByName(
      [
        { id: "s-bogus", name: "In Review", type: "unstarted", position: 0 },
        { id: "s-real", name: "In Review", type: "started", position: 5 },
      ],
      "In Review",
      "started"
    );
    expect(id).toBe("s-real");
  });

  test("breaks duplicate-name ties deterministically by lowest position", () => {
    const id = pickWorkflowStateByName(
      [
        { id: "s-late", name: "In Review", type: "started", position: 9 },
        { id: "s-early", name: "In Review", type: "started", position: 2 },
        { id: "s-mid", name: "In Review", type: "started", position: 5 },
      ],
      "In Review",
      "started"
    );
    expect(id).toBe("s-early");
  });

  test("name match is case-sensitive", () => {
    const id = pickWorkflowStateByName(
      [{ id: "s", name: "in review", type: "started", position: 1 }],
      "In Review"
    );
    expect(id).toBeUndefined();
  });
});
