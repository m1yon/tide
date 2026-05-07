import { describe, expect, test } from "bun:test";
import {
  decideBranchOverride,
  promptBranchOverride,
  type SelectFn,
} from "./index.ts";

describe("decideBranchOverride", () => {
  test("returns silent when current branch equals the picked branch", () => {
    const r = decideBranchOverride({
      currentBranch: "user/feature/eng-7",
      pickedBranchName: "user/feature/eng-7",
    });
    expect(r).toEqual({ kind: "silent", branch: "user/feature/eng-7" });
  });

  test("returns needs-prompt when current branch differs from the picked branch", () => {
    const r = decideBranchOverride({
      currentBranch: "main",
      pickedBranchName: "user/feature/eng-7",
    });
    expect(r).toEqual({
      kind: "needs-prompt",
      linearBranch: "user/feature/eng-7",
      currentBranch: "main",
    });
  });

  test("treats a different feature branch as needs-prompt (escape-hatch path)", () => {
    // The user has their own work-in-progress branch checked out; the
    // picker returns Linear's auto-generated branch. The two differ, so
    // the prompt is needed.
    const r = decideBranchOverride({
      currentBranch: "user/wip-experiment",
      pickedBranchName: "user/feature/eng-7",
    });
    expect(r.kind).toBe("needs-prompt");
    if (r.kind === "needs-prompt") {
      expect(r.linearBranch).toBe("user/feature/eng-7");
      expect(r.currentBranch).toBe("user/wip-experiment");
    }
  });
});

describe("promptBranchOverride", () => {
  interface CapturedSelect {
    messages: string[];
    options: { value: string; label: string }[][];
    initialValues: (string | undefined)[];
  }

  function makeSelect(
    captured: CapturedSelect,
    resolveTo: string | symbol
  ): SelectFn {
    return ((opts) => {
      captured.messages.push(opts.message);
      captured.options.push(
        opts.options.map((o) => ({
          value: o.value as string,
          label: o.label ?? String(o.value),
        }))
      );
      captured.initialValues.push(opts.initialValue as string | undefined);
      return Promise.resolve(resolveTo);
    }) as SelectFn;
  }

  test("user picks Linear's branch (default cursor)", async () => {
    const captured: CapturedSelect = {
      messages: [],
      options: [],
      initialValues: [],
    };
    const result = await promptBranchOverride(
      { linearBranch: "user/feature/eng-7", currentBranch: "main" },
      makeSelect(captured, "user/feature/eng-7"),
      () => false
    );

    expect(result).toEqual({
      kind: "chosen",
      branch: "user/feature/eng-7",
    });
    // The Linear branch is the default cursor.
    expect(captured.initialValues).toEqual(["user/feature/eng-7"]);
    // Two named options rendered with the Linear branch listed first.
    expect(captured.options).toHaveLength(1);
    const opts = captured.options[0];
    if (!opts) throw new Error("unreachable");
    expect(opts).toHaveLength(2);
    expect(opts[0]?.value).toBe("user/feature/eng-7");
    expect(opts[0]?.label).toContain("user/feature/eng-7");
    expect(opts[0]?.label).toContain("Linear");
    expect(opts[1]?.value).toBe("main");
    expect(opts[1]?.label).toContain("main");
    expect(opts[1]?.label).toContain("current");
  });

  test("user picks the current branch (override)", async () => {
    const captured: CapturedSelect = {
      messages: [],
      options: [],
      initialValues: [],
    };
    const result = await promptBranchOverride(
      { linearBranch: "user/feature/eng-7", currentBranch: "user/wip" },
      makeSelect(captured, "user/wip"),
      () => false
    );

    expect(result).toEqual({ kind: "chosen", branch: "user/wip" });
  });

  test("user cancels the prompt", async () => {
    const cancelSymbol = Symbol("cancel");
    const captured: CapturedSelect = {
      messages: [],
      options: [],
      initialValues: [],
    };
    const result = await promptBranchOverride(
      { linearBranch: "user/feature/eng-7", currentBranch: "main" },
      makeSelect(captured, cancelSymbol),
      (v) => v === cancelSymbol
    );

    expect(result).toEqual({ kind: "cancelled" });
  });
});
