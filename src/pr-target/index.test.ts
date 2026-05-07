import { describe, expect, test } from "bun:test";
import {
  decidePrTarget,
  promptPrTarget,
  type SelectFn,
  type TextFn,
  type VerifyRefFn,
} from "./index.ts";

describe("decidePrTarget", () => {
  test("silent when current branch equals origin/HEAD", () => {
    const r = decidePrTarget({
      currentBranch: "master",
      originHead: "master",
    });
    expect(r).toEqual({ kind: "silent", branch: "master" });
  });

  test("needs-prompt with origin/HEAD as default when current branch differs", () => {
    const r = decidePrTarget({
      currentBranch: "user/wip-experiment",
      originHead: "master",
    });
    expect(r).toEqual({ kind: "needs-prompt", defaultBranch: "master" });
  });

  test("needs-prompt with no default when origin/HEAD is unset", () => {
    const r = decidePrTarget({
      currentBranch: "user/wip-experiment",
      originHead: undefined,
    });
    expect(r).toEqual({ kind: "needs-prompt", defaultBranch: undefined });
  });

  test("does not silent-match when origin/HEAD is unset, even if currentBranch is empty-equivalent", () => {
    // Belt-and-braces: an unset origin/HEAD must never produce a silent
    // outcome — falling back to the user's current branch as the PR target
    // would re-introduce the conflation ADR-0016 splits.
    const r = decidePrTarget({ currentBranch: "main", originHead: undefined });
    expect(r.kind).toBe("needs-prompt");
  });
});

interface CapturedSelect {
  messages: string[];
  options: { value: string | symbol; label: string }[][];
  initialValues: (string | symbol | undefined)[];
}

function makeSelect(
  captured: CapturedSelect,
  resolveTo: (
    options: { value: string | symbol; label: string }[]
  ) => string | symbol
): SelectFn {
  return ((opts) => {
    captured.messages.push(opts.message);
    const opts2 = opts.options.map((o) => ({
      value: o.value as string | symbol,
      label: o.label ?? String(o.value),
    }));
    captured.options.push(opts2);
    captured.initialValues.push(
      opts.initialValue as string | symbol | undefined
    );
    return Promise.resolve(resolveTo(opts2));
  }) as SelectFn;
}

interface CapturedText {
  messages: string[];
}

function makeText(
  captured: CapturedText,
  responses: (string | symbol)[]
): TextFn {
  let i = 0;
  const fn: TextFn = (opts) => {
    captured.messages.push(opts.message);
    const r = responses[i];
    i += 1;
    if (r === undefined) {
      throw new Error(
        `text stub: ran out of canned responses (call ${String(i)})`
      );
    }
    return Promise.resolve(r);
  };
  return fn;
}

describe("promptPrTarget", () => {
  test("user accepts the default (origin/HEAD)", async () => {
    const captured: CapturedSelect = {
      messages: [],
      options: [],
      initialValues: [],
    };
    let textCalls = 0;
    const textFn: TextFn = () => {
      textCalls += 1;
      return Promise.resolve("unused");
    };

    const result = await promptPrTarget(
      { defaultBranch: "master", repoRoot: "/repo" },
      makeSelect(captured, (opts) => opts[0]?.value ?? "x"),
      textFn,
      () => false
    );

    expect(result).toEqual({ kind: "chosen", branch: "master" });
    expect(textCalls).toBe(0);
    // origin/HEAD is the default cursor and labelled as such.
    expect(captured.initialValues).toEqual(["master"]);
    const opts = captured.options[0];
    if (!opts) throw new Error("unreachable");
    expect(opts).toHaveLength(2);
    expect(opts[0]?.value).toBe("master");
    expect(opts[0]?.label).toContain("master");
    expect(opts[0]?.label.toLowerCase()).toContain("origin/head");
    expect(opts[1]?.label.toLowerCase()).toContain("type another");
  });

  test("user picks 'Type another...' and types a valid local ref", async () => {
    const capturedSelect: CapturedSelect = {
      messages: [],
      options: [],
      initialValues: [],
    };
    const capturedText: CapturedText = { messages: [] };
    const verifyCalls: { repoRoot: string; branch: string }[] = [];
    const verifyRef: VerifyRefFn = (repoRoot, branch) => {
      verifyCalls.push({ repoRoot, branch });
      return Promise.resolve(true);
    };

    const result = await promptPrTarget(
      { defaultBranch: "master", repoRoot: "/repo" },
      // Pick the second option (Type another...).
      makeSelect(capturedSelect, (opts) => opts[1]?.value ?? "x"),
      makeText(capturedText, ["dev"]),
      () => false,
      verifyRef
    );

    expect(result).toEqual({ kind: "chosen", branch: "dev" });
    expect(verifyCalls).toEqual([{ repoRoot: "/repo", branch: "dev" }]);
    expect(capturedText.messages).toHaveLength(1);
  });

  test("user types an invalid ref → re-prompts with the `git fetch` hint, then accepts a valid one", async () => {
    const capturedSelect: CapturedSelect = {
      messages: [],
      options: [],
      initialValues: [],
    };
    const capturedText: CapturedText = { messages: [] };
    const verifyRef: VerifyRefFn = (_repoRoot, branch) =>
      Promise.resolve(branch === "dev");

    const result = await promptPrTarget(
      { defaultBranch: "master", repoRoot: "/repo" },
      makeSelect(capturedSelect, (opts) => opts[1]?.value ?? "x"),
      makeText(capturedText, ["nope", "dev"]),
      () => false,
      verifyRef
    );

    expect(result).toEqual({ kind: "chosen", branch: "dev" });
    // First text prompt is the initial ask; second text prompt carries the
    // re-enter hint after the invalid ref.
    expect(capturedText.messages).toHaveLength(2);
    const second = capturedText.messages[1];
    if (!second) throw new Error("unreachable");
    expect(second).toContain("nope");
    expect(second).toContain("git fetch");
    expect(second).toContain("git checkout");
  });

  test("user cancels at the select", async () => {
    const cancelSym = Symbol("cancel");
    const capturedSelect: CapturedSelect = {
      messages: [],
      options: [],
      initialValues: [],
    };
    let textCalls = 0;
    const textFn: TextFn = () => {
      textCalls += 1;
      return Promise.resolve("");
    };

    const result = await promptPrTarget(
      { defaultBranch: "master", repoRoot: "/repo" },
      makeSelect(capturedSelect, () => cancelSym),
      textFn,
      (v) => v === cancelSym
    );

    expect(result).toEqual({ kind: "cancelled" });
    expect(textCalls).toBe(0);
  });

  test("user cancels at the text prompt after picking 'Type another...'", async () => {
    const cancelSym = Symbol("cancel");
    const capturedSelect: CapturedSelect = {
      messages: [],
      options: [],
      initialValues: [],
    };
    let verifyCalls = 0;
    const verifyRef: VerifyRefFn = () => {
      verifyCalls += 1;
      return Promise.resolve(true);
    };

    const result = await promptPrTarget(
      { defaultBranch: "master", repoRoot: "/repo" },
      makeSelect(capturedSelect, (opts) => opts[1]?.value ?? "x"),
      (): Promise<string | symbol> => Promise.resolve(cancelSym),
      (v) => v === cancelSym,
      verifyRef
    );

    expect(result).toEqual({ kind: "cancelled" });
    expect(verifyCalls).toBe(0);
  });

  test("origin/HEAD unset (defaultBranch undefined) → skips the select, goes straight to text", async () => {
    let selectCalls = 0;
    // Returns a symbol (matches SelectFn's `Promise<Value | symbol>`); the
    // value is never inspected because the assertion below requires
    // `selectCalls === 0` — the select must never be invoked when
    // `defaultBranch` is undefined.
    const selectFn: SelectFn = () => {
      selectCalls += 1;
      return Promise.resolve(Symbol("unused"));
    };
    const capturedText: CapturedText = { messages: [] };
    const verifyRef: VerifyRefFn = () => Promise.resolve(true);

    const result = await promptPrTarget(
      { defaultBranch: undefined, repoRoot: "/repo" },
      selectFn,
      makeText(capturedText, ["dev"]),
      () => false,
      verifyRef
    );

    expect(result).toEqual({ kind: "chosen", branch: "dev" });
    expect(selectCalls).toBe(0);
    expect(capturedText.messages).toHaveLength(1);
  });

  test("origin/HEAD unset path also re-prompts on invalid ref", async () => {
    const capturedText: CapturedText = { messages: [] };
    const verifyRef: VerifyRefFn = (_repoRoot, branch) =>
      Promise.resolve(branch === "dev");
    const failingSelect: SelectFn = () =>
      Promise.reject(new Error("select must not fire"));

    const result = await promptPrTarget(
      { defaultBranch: undefined, repoRoot: "/repo" },
      failingSelect,
      makeText(capturedText, ["nope", "dev"]),
      () => false,
      verifyRef
    );

    expect(result).toEqual({ kind: "chosen", branch: "dev" });
    expect(capturedText.messages).toHaveLength(2);
    expect(capturedText.messages[1]).toContain("git fetch");
  });
});
