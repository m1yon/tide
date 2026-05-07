import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyBridge,
  createBridgeIfMissing,
  describeBridgeForUser,
  repairBridge,
  type BridgeState,
} from "./index.ts";

describe("classifyBridge", () => {
  let workDir: string;
  let repoRoot: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tide-bridge-classify-"));
    repoRoot = join(workDir, "repo");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(join(repoRoot, ".tide"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("missing — no .sandcastle entry at repo root", () => {
    expect(classifyBridge(repoRoot)).toEqual({ kind: "missing" });
  });

  test("intact — symlink at .sandcastle pointing at .tide", () => {
    symlinkSync(".tide", join(repoRoot, ".sandcastle"), "dir");
    expect(classifyBridge(repoRoot)).toEqual({ kind: "intact" });
  });

  test("wrong-symlink-target — symlink pointing somewhere else", () => {
    symlinkSync("some-other-dir", join(repoRoot, ".sandcastle"), "dir");
    const state = classifyBridge(repoRoot);
    expect(state).toEqual({
      kind: "wrong-symlink-target",
      target: "some-other-dir",
    });
  });

  test("real-dir-empty — real directory with no entries", () => {
    mkdirSync(join(repoRoot, ".sandcastle"));
    expect(classifyBridge(repoRoot)).toEqual({ kind: "real-dir-empty" });
  });

  test("real-dir-empty — user-incident shape: empty worktrees/ and logs/ subdirs", () => {
    mkdirSync(join(repoRoot, ".sandcastle"));
    mkdirSync(join(repoRoot, ".sandcastle", "worktrees"));
    mkdirSync(join(repoRoot, ".sandcastle", "logs"));
    expect(classifyBridge(repoRoot)).toEqual({ kind: "real-dir-empty" });
  });

  test("real-dir-with-content — real directory containing files", () => {
    mkdirSync(join(repoRoot, ".sandcastle"));
    mkdirSync(join(repoRoot, ".sandcastle", "worktrees"));
    writeFileSync(
      join(repoRoot, ".sandcastle", "worktrees", "feature-branch.patch"),
      "diff --git\n"
    );
    const state = classifyBridge(repoRoot);
    expect(state.kind).toBe("real-dir-with-content");
    if (state.kind !== "real-dir-with-content") return;
    expect(state.entries).toContain("worktrees");
  });

  test("regular-file — plain file at .sandcastle", () => {
    writeFileSync(join(repoRoot, ".sandcastle"), "garbage\n");
    expect(classifyBridge(repoRoot)).toEqual({ kind: "regular-file" });
  });
});

describe("repairBridge", () => {
  let workDir: string;
  let repoRoot: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tide-bridge-repair-"));
    repoRoot = join(workDir, "repo");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(join(repoRoot, ".tide"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function expectIntact(): void {
    const stat = lstatSync(join(repoRoot, ".sandcastle"));
    expect(stat.isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(repoRoot, ".sandcastle"))).toBe(".tide");
  }

  test("wrong-symlink-target → unlinks and re-symlinks at .tide", () => {
    symlinkSync("nope", join(repoRoot, ".sandcastle"), "dir");
    const state = classifyBridge(repoRoot);
    repairBridge(repoRoot, state);
    expectIntact();
  });

  test("real-dir-empty → rmdirs and re-symlinks at .tide", () => {
    mkdirSync(join(repoRoot, ".sandcastle"));
    mkdirSync(join(repoRoot, ".sandcastle", "worktrees"));
    mkdirSync(join(repoRoot, ".sandcastle", "logs"));
    const state = classifyBridge(repoRoot);
    repairBridge(repoRoot, state);
    expectIntact();
  });

  test("real-dir-with-content → rm -rfs and re-symlinks at .tide", () => {
    mkdirSync(join(repoRoot, ".sandcastle"));
    mkdirSync(join(repoRoot, ".sandcastle", "worktrees"));
    writeFileSync(
      join(repoRoot, ".sandcastle", "worktrees", "junk.patch"),
      "x\n"
    );
    const state = classifyBridge(repoRoot);
    repairBridge(repoRoot, state);
    expectIntact();
  });

  test("regular-file → unlinks and re-symlinks at .tide", () => {
    writeFileSync(join(repoRoot, ".sandcastle"), "junk\n");
    const state = classifyBridge(repoRoot);
    repairBridge(repoRoot, state);
    expectIntact();
  });

  test("creates .tide directory if missing before symlinking", () => {
    rmSync(join(repoRoot, ".tide"), { recursive: true });
    writeFileSync(join(repoRoot, ".sandcastle"), "junk\n");
    const state = classifyBridge(repoRoot);
    repairBridge(repoRoot, state);
    expectIntact();
  });

  test("throws on intact (caller invariant)", () => {
    symlinkSync(".tide", join(repoRoot, ".sandcastle"), "dir");
    const state = classifyBridge(repoRoot);
    expect(() => {
      repairBridge(repoRoot, state);
    }).toThrow();
  });

  test("throws on missing (caller invariant)", () => {
    const state: BridgeState = { kind: "missing" };
    expect(() => {
      repairBridge(repoRoot, state);
    }).toThrow();
  });
});

describe("createBridgeIfMissing", () => {
  let workDir: string;
  let repoRoot: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tide-bridge-create-"));
    repoRoot = join(workDir, "repo");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(join(repoRoot, ".tide"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("creates symlink when state is missing", () => {
    createBridgeIfMissing(repoRoot);
    const stat = lstatSync(join(repoRoot, ".sandcastle"));
    expect(stat.isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(repoRoot, ".sandcastle"))).toBe(".tide");
  });

  test("creates .tide as well if missing", () => {
    rmSync(join(repoRoot, ".tide"), { recursive: true });
    createBridgeIfMissing(repoRoot);
    const stat = lstatSync(join(repoRoot, ".sandcastle"));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  test("no-ops when state is intact", () => {
    symlinkSync(".tide", join(repoRoot, ".sandcastle"), "dir");
    createBridgeIfMissing(repoRoot);
    expect(readlinkSync(join(repoRoot, ".sandcastle"))).toBe(".tide");
  });

  test("throws with `tide setup` hint when state is wrong-symlink-target", () => {
    symlinkSync("nope", join(repoRoot, ".sandcastle"), "dir");
    expect(() => {
      createBridgeIfMissing(repoRoot);
    }).toThrow(/tide setup/);
  });

  test("throws with `tide setup` hint when state is real-dir-empty", () => {
    mkdirSync(join(repoRoot, ".sandcastle"));
    expect(() => {
      createBridgeIfMissing(repoRoot);
    }).toThrow(/tide setup/);
  });

  test("throws with `tide setup` hint when state is real-dir-with-content", () => {
    mkdirSync(join(repoRoot, ".sandcastle"));
    writeFileSync(join(repoRoot, ".sandcastle", "junk"), "x\n");
    expect(() => {
      createBridgeIfMissing(repoRoot);
    }).toThrow(/tide setup/);
  });

  test("throws with `tide setup` hint when state is regular-file", () => {
    writeFileSync(join(repoRoot, ".sandcastle"), "junk\n");
    expect(() => {
      createBridgeIfMissing(repoRoot);
    }).toThrow(/tide setup/);
  });
});

describe("describeBridgeForUser", () => {
  test("returns a non-empty string for every variant", () => {
    const variants: BridgeState[] = [
      { kind: "missing" },
      { kind: "intact" },
      { kind: "wrong-symlink-target", target: "/somewhere/else" },
      { kind: "real-dir-empty" },
      { kind: "real-dir-with-content", entries: ["worktrees", "logs"] },
      { kind: "regular-file" },
    ];
    for (const v of variants) {
      const desc = describeBridgeForUser(v);
      expect(desc.length).toBeGreaterThan(0);
    }
  });

  test("real-dir-with-content description includes the entries list", () => {
    const desc = describeBridgeForUser({
      kind: "real-dir-with-content",
      entries: ["worktrees", "logs", "patches"],
    });
    expect(desc).toContain("worktrees");
    expect(desc).toContain("logs");
    expect(desc).toContain("patches");
  });
});
