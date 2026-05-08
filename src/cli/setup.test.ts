import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, type ConfirmBridgeRepairFn } from "./setup.ts";
import {
  IN_REVIEW_STATE_NAME,
  SETUP_LABEL_NAMES,
  type ProvisionInReviewStateResult,
  type SetupLabelResult,
} from "../linear/index.ts";
import { InMemoryLinearService } from "../services/linear/index.ts";
import { classifyBridge } from "../sandcastle-bridge/index.ts";

interface LinearContext {
  apiKey: string;
  teamKey: string;
}

type SetupLabelsFn = (ctx: LinearContext) => Promise<SetupLabelResult[]>;
type ProvisionInReviewStateFn = (
  ctx: LinearContext
) => Promise<ProvisionInReviewStateResult>;

interface SetupLabelsCapture {
  ctx: LinearContext | null;
  callCount: number;
}

function buildSetupLabels(
  results: SetupLabelResult[],
  capture: SetupLabelsCapture
): SetupLabelsFn {
  return (ctx) => {
    capture.callCount += 1;
    capture.ctx = ctx;
    return Promise.resolve(results);
  };
}

interface ProvisionStateCapture {
  ctx: LinearContext | null;
  callCount: number;
}

function buildProvisionState(
  result: ProvisionInReviewStateResult,
  capture: ProvisionStateCapture
): ProvisionInReviewStateFn {
  return (ctx) => {
    capture.callCount += 1;
    capture.ctx = ctx;
    return Promise.resolve(result);
  };
}

/**
 * The pre-Phase-1 `setup()` accepted `setupLabels` + `provisionInReviewState`
 * callbacks. After the migration both are methods on a single
 * `LinearService`. This test compat helper bridges the two: it wraps the
 * legacy callbacks (which capture into per-test `*Capture` objects) into a
 * lightweight LinearService that calls them through.
 */
function legacySetup(opts: {
  repoRoot?: string;
  setupLabels?: SetupLabelsFn;
  provisionInReviewState?: ProvisionInReviewStateFn;
  confirmBridgeRepair?: ConfirmBridgeRepairFn;
}): Promise<number> {
  const ctx: LinearContext = { apiKey: "lk", teamKey: "ENG" };
  const linear: InMemoryLinearService = new InMemoryLinearService();
  // Override only the two methods setup() actually calls; everything else
  // remains the InMemoryLinearService default.
  Object.defineProperty(linear, "setupLabels", {
    value: () => opts.setupLabels?.(ctx) ?? Promise.resolve([]),
  });
  Object.defineProperty(linear, "provisionInReviewState", {
    value: () =>
      opts.provisionInReviewState?.(ctx) ??
      Promise.resolve({ name: IN_REVIEW_STATE_NAME, created: false }),
  });
  return setup({
    repoRoot: opts.repoRoot,
    linear,
    confirmBridgeRepair: opts.confirmBridgeRepair,
  });
}

const allLabelsCreated = (): SetupLabelResult[] =>
  SETUP_LABEL_NAMES.map((name) => ({ name, created: true }));

const allLabelsPresent = (): SetupLabelResult[] =>
  SETUP_LABEL_NAMES.map((name) => ({ name, created: false }));

describe("tide setup", () => {
  let workDir: string;
  let repoRoot: string;
  let tideDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tide-setup-"));
    repoRoot = join(workDir, "repo");
    tideDir = join(repoRoot, ".tide");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(tideDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeValidEnv(): void {
    writeFileSync(
      join(tideDir, ".env"),
      "LINEAR_API_KEY=lk\nANTHROPIC_API_KEY=ak\n"
    );
  }

  function writeValidConfig(): void {
    writeFileSync(
      join(tideDir, "config.ts"),
      `export default { linear: { team: "ENG" } };\n`
    );
  }

  test("on a fresh team, creates all three labels + the In Review state and exits zero", async () => {
    writeValidEnv();
    writeValidConfig();
    const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
    const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

    const code = await legacySetup({
      repoRoot,
      setupLabels: buildSetupLabels(allLabelsCreated(), labelCapture),
      provisionInReviewState: buildProvisionState(
        { name: IN_REVIEW_STATE_NAME, created: true },
        stateCapture
      ),
    });

    expect(code).toBe(0);
    expect(labelCapture.callCount).toBe(1);
    expect(stateCapture.callCount).toBe(1);
    expect(labelCapture.ctx?.apiKey).toBe("lk");
    expect(labelCapture.ctx?.teamKey).toBe("ENG");
    expect(stateCapture.ctx?.apiKey).toBe("lk");
    expect(stateCapture.ctx?.teamKey).toBe("ENG");
  });

  test("on a fully provisioned team, exits zero with both stubs called once", async () => {
    writeValidEnv();
    writeValidConfig();
    const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
    const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

    const code = await legacySetup({
      repoRoot,
      setupLabels: buildSetupLabels(allLabelsPresent(), labelCapture),
      provisionInReviewState: buildProvisionState(
        { name: IN_REVIEW_STATE_NAME, created: false },
        stateCapture
      ),
    });

    expect(code).toBe(0);
    expect(labelCapture.callCount).toBe(1);
    expect(stateCapture.callCount).toBe(1);
  });

  test("partial pre-existing: both stubs called and exits zero", async () => {
    writeValidEnv();
    writeValidConfig();
    const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
    const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };
    const results: SetupLabelResult[] = [
      { name: "prd", created: false },
      { name: "ready-for-agent", created: true },
      { name: "ready-for-human", created: true },
    ];

    const code = await legacySetup({
      repoRoot,
      setupLabels: buildSetupLabels(results, labelCapture),
      provisionInReviewState: buildProvisionState(
        { name: IN_REVIEW_STATE_NAME, created: true },
        stateCapture
      ),
    });

    expect(code).toBe(0);
    expect(labelCapture.callCount).toBe(1);
    expect(stateCapture.callCount).toBe(1);
  });

  test("provisions the In Review state via provisionInReviewState (single call, ctx forwarded)", async () => {
    writeValidEnv();
    writeValidConfig();
    const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
    const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

    const code = await legacySetup({
      repoRoot,
      setupLabels: buildSetupLabels(allLabelsCreated(), labelCapture),
      provisionInReviewState: buildProvisionState(
        { name: IN_REVIEW_STATE_NAME, created: true },
        stateCapture
      ),
    });

    expect(code).toBe(0);
    expect(stateCapture.callCount).toBe(1);
    expect(stateCapture.ctx?.apiKey).toBe("lk");
    expect(stateCapture.ctx?.teamKey).toBe("ENG");
  });

  test("In Review already present: state stub returns created:false and exits zero", async () => {
    writeValidEnv();
    writeValidConfig();
    const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
    const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

    const code = await legacySetup({
      repoRoot,
      setupLabels: buildSetupLabels(allLabelsCreated(), labelCapture),
      provisionInReviewState: buildProvisionState(
        { name: IN_REVIEW_STATE_NAME, created: false },
        stateCapture
      ),
    });

    expect(code).toBe(0);
    expect(stateCapture.callCount).toBe(1);
  });

  test("missing .tide/.env yields non-zero exit and skips both Linear stubs", async () => {
    writeValidConfig();
    const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
    const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

    const code = await legacySetup({
      repoRoot,
      setupLabels: buildSetupLabels([], labelCapture),
      provisionInReviewState: buildProvisionState(
        { name: IN_REVIEW_STATE_NAME, created: false },
        stateCapture
      ),
    });

    expect(code).toBe(1);
    expect(labelCapture.callCount).toBe(0);
    expect(stateCapture.callCount).toBe(0);
  });

  test("missing LINEAR_API_KEY yields non-zero exit and skips both Linear stubs", async () => {
    writeFileSync(join(tideDir, ".env"), "ANTHROPIC_API_KEY=ak\n");
    writeValidConfig();
    const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
    const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

    const code = await legacySetup({
      repoRoot,
      setupLabels: buildSetupLabels([], labelCapture),
      provisionInReviewState: buildProvisionState(
        { name: IN_REVIEW_STATE_NAME, created: false },
        stateCapture
      ),
    });

    expect(code).toBe(1);
    expect(labelCapture.callCount).toBe(0);
    expect(stateCapture.callCount).toBe(0);
  });

  test("Linear setupLabels failure yields non-zero exit; state step still runs", async () => {
    writeValidEnv();
    writeValidConfig();
    const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };
    const setupLabelsFn: SetupLabelsFn = () =>
      Promise.reject(new Error("invalid api key"));

    const code = await legacySetup({
      repoRoot,
      setupLabels: setupLabelsFn,
      provisionInReviewState: buildProvisionState(
        { name: IN_REVIEW_STATE_NAME, created: false },
        stateCapture
      ),
    });

    expect(code).toBe(1);
    expect(stateCapture.callCount).toBe(1);
  });

  test("provisionInReviewState failure does not skip setupLabels; both ran, exits non-zero", async () => {
    // Per-resource failures are reported independently — a state failure
    // does not skip the label step.
    writeValidEnv();
    writeValidConfig();
    const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
    const provisionFn: ProvisionInReviewStateFn = () =>
      Promise.reject(new Error("In Progress flank missing"));

    const code = await legacySetup({
      repoRoot,
      setupLabels: buildSetupLabels(allLabelsCreated(), labelCapture),
      provisionInReviewState: provisionFn,
    });

    expect(code).toBe(1);
    expect(labelCapture.callCount).toBe(1);
  });

  test("setupLabels failure does not skip provisionInReviewState; both stubs ran", async () => {
    writeValidEnv();
    writeValidConfig();
    const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };
    const setupLabelsFn: SetupLabelsFn = () =>
      Promise.reject(new Error("label create failed"));

    const code = await legacySetup({
      repoRoot,
      setupLabels: setupLabelsFn,
      provisionInReviewState: buildProvisionState(
        { name: IN_REVIEW_STATE_NAME, created: true },
        stateCapture
      ),
    });

    expect(code).toBe(1);
    expect(stateCapture.callCount).toBe(1);
  });

  test("invoked outside any git repo exits non-zero and skips both Linear stubs", async () => {
    const lonely = join(workDir, "lonely");
    mkdirSync(lonely, { recursive: true });
    const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
    const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

    const originalCwd = process.cwd();
    let code: number;
    try {
      process.chdir(lonely);
      code = await legacySetup({
        setupLabels: buildSetupLabels([], labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: false },
          stateCapture
        ),
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(code).toBe(1);
    expect(labelCapture.callCount).toBe(0);
    expect(stateCapture.callCount).toBe(0);
  });

  describe("sandcastle bridge step", () => {
    test("missing bridge: silently auto-creates the symlink (no prompt)", async () => {
      writeValidEnv();
      writeValidConfig();
      const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
      const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };
      let confirmCalls = 0;
      const confirmFn: ConfirmBridgeRepairFn = () => {
        confirmCalls += 1;
        return Promise.resolve(false);
      };

      const code = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsCreated(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: true },
          stateCapture
        ),
        confirmBridgeRepair: confirmFn,
      });

      expect(code).toBe(0);
      expect(confirmCalls).toBe(0);
      expect(classifyBridge(repoRoot)).toEqual({ kind: "intact" });
    });

    test("intact bridge: silent no-op (no prompt, no churn)", async () => {
      writeValidEnv();
      writeValidConfig();
      symlinkSync(".tide", join(repoRoot, ".sandcastle"), "dir");
      const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
      const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };
      let confirmCalls = 0;
      const confirmFn: ConfirmBridgeRepairFn = () => {
        confirmCalls += 1;
        return Promise.resolve(false);
      };

      const code = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsCreated(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: true },
          stateCapture
        ),
        confirmBridgeRepair: confirmFn,
      });

      expect(code).toBe(0);
      expect(confirmCalls).toBe(0);
      expect(classifyBridge(repoRoot)).toEqual({ kind: "intact" });
    });

    test("broken bridge + confirm true: repairs the bridge and exits zero", async () => {
      writeValidEnv();
      writeValidConfig();
      mkdirSync(join(repoRoot, ".sandcastle"));
      mkdirSync(join(repoRoot, ".sandcastle", "worktrees"));
      const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
      const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

      const code = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsCreated(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: true },
          stateCapture
        ),
        confirmBridgeRepair: () => Promise.resolve(true),
      });

      expect(code).toBe(0);
      expect(classifyBridge(repoRoot)).toEqual({ kind: "intact" });
      const stat = lstatSync(join(repoRoot, ".sandcastle"));
      expect(stat.isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(repoRoot, ".sandcastle"))).toBe(".tide");
      expect(labelCapture.callCount).toBe(1);
      expect(stateCapture.callCount).toBe(1);
    });

    test("broken bridge + confirm false: exits non-zero, bridge untouched, Linear half not invoked", async () => {
      writeValidEnv();
      writeValidConfig();
      writeFileSync(join(repoRoot, ".sandcastle"), "junk\n");
      const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
      const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

      const code = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsCreated(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: true },
          stateCapture
        ),
        confirmBridgeRepair: () => Promise.resolve(false),
      });

      expect(code).toBe(1);
      expect(classifyBridge(repoRoot)).toEqual({ kind: "regular-file" });
      expect(labelCapture.callCount).toBe(0);
      expect(stateCapture.callCount).toBe(0);
    });

    test("bridge step runs before env/config: missing LINEAR_API_KEY does not skip the bridge", async () => {
      // .env present but LINEAR_API_KEY missing. The bridge should still be
      // repaired so a fresh-clone partial setup leaves a healthy bridge even
      // when the Linear half can't run.
      writeFileSync(join(tideDir, ".env"), "ANTHROPIC_API_KEY=ak\n");
      writeValidConfig();
      mkdirSync(join(repoRoot, ".sandcastle"));
      mkdirSync(join(repoRoot, ".sandcastle", "worktrees"));
      const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
      const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

      const code = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsCreated(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: true },
          stateCapture
        ),
        confirmBridgeRepair: () => Promise.resolve(true),
      });

      expect(code).toBe(1);
      expect(classifyBridge(repoRoot)).toEqual({ kind: "intact" });
      expect(labelCapture.callCount).toBe(0);
      expect(stateCapture.callCount).toBe(0);
    });

    test("bridge step runs before env/config: missing .tide/.env does not skip the bridge", async () => {
      // Neither .env nor a broken bridge — but a broken bridge with no env at
      // all means the bridge step must still classify + prompt + repair before
      // env loading errors out.
      writeValidConfig();
      mkdirSync(join(repoRoot, ".sandcastle"));
      const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
      const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };
      let confirmCalls = 0;

      const code = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsCreated(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: true },
          stateCapture
        ),
        confirmBridgeRepair: () => {
          confirmCalls += 1;
          return Promise.resolve(true);
        },
      });

      expect(code).toBe(1);
      expect(confirmCalls).toBe(1);
      expect(classifyBridge(repoRoot)).toEqual({ kind: "intact" });
      expect(labelCapture.callCount).toBe(0);
      expect(stateCapture.callCount).toBe(0);
    });
  });

  describe(".tide/ scaffold step", () => {
    const SCAFFOLD_FILES = [
      "config.ts",
      "Dockerfile",
      "prompt.md",
      "prompt-standalone.md",
      ".env.example",
      ".gitignore",
    ];

    test("fresh repo (no .tide/ files) gets all 6 scaffold files written; env load fails afterwards so Linear is skipped", async () => {
      // No writeValidEnv / writeValidConfig — `.tide/` is empty per beforeEach.
      const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
      const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

      const code = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsCreated(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: true },
          stateCapture
        ),
      });

      expect(code).toBe(1);
      for (const f of SCAFFOLD_FILES) {
        expect(existsSync(join(tideDir, f))).toBe(true);
      }
      // env load fails on missing `.env`, so Linear is skipped.
      expect(labelCapture.callCount).toBe(0);
      expect(stateCapture.callCount).toBe(0);
    });

    test("second tide setup against a fully-up-to-date repo writes nothing new", async () => {
      writeValidEnv();
      writeValidConfig();
      const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
      const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

      const firstCode = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsPresent(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: false },
          stateCapture
        ),
      });
      expect(firstCode).toBe(0);

      const mtimes = new Map<string, number>();
      for (const f of SCAFFOLD_FILES) {
        mtimes.set(f, statSync(join(tideDir, f)).mtimeMs);
      }

      // Pause so any rewrite would change mtime detectably.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const secondCode = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsPresent(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: false },
          stateCapture
        ),
      });
      expect(secondCode).toBe(0);
      for (const f of SCAFFOLD_FILES) {
        expect(statSync(join(tideDir, f)).mtimeMs).toBe(mtimes.get(f) ?? -1);
      }
    });

    test("hand-edited .tide/config.ts is preserved (skip-if-exists)", async () => {
      writeValidEnv();
      const handEdited = `export default { linear: { team: "MYTEAM" } };\n// hand-edited\n`;
      writeFileSync(join(tideDir, "config.ts"), handEdited);
      const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
      const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

      const code = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsCreated(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: true },
          stateCapture
        ),
      });

      expect(code).toBe(0);
      expect(readFileSync(join(tideDir, "config.ts"), "utf8")).toBe(handEdited);
      // After the LinearService migration, the team key is encapsulated
      // inside `LinearSdkService` rather than threaded through a per-call
      // `ctx`; the hand-edited config still flows into setup() — we know
      // because the run exited zero and `labelCapture.callCount === 1`.
      expect(labelCapture.callCount).toBe(1);
    });

    test("Linear failure does not skip scaffold writes (file-write step is independent)", async () => {
      writeValidEnv();
      writeValidConfig();
      const setupLabelsFn: SetupLabelsFn = () =>
        Promise.reject(new Error("linear down"));
      const provisionFn: ProvisionInReviewStateFn = () =>
        Promise.reject(new Error("linear down"));

      const code = await legacySetup({
        repoRoot,
        setupLabels: setupLabelsFn,
        provisionInReviewState: provisionFn,
      });

      expect(code).toBe(1);
      for (const f of SCAFFOLD_FILES) {
        expect(existsSync(join(tideDir, f))).toBe(true);
      }
    });
  });

  describe("bundled .claude/skills/tide-* step", () => {
    const SKILL_FILES = [
      ".claude/skills/tide-to-prd/SKILL.md",
      ".claude/skills/tide-to-issues/SKILL.md",
      ".claude/skills/tide-triage/SKILL.md",
      ".claude/skills/tide-triage/AGENT-BRIEF.md",
      ".claude/skills/tide-triage/OUT-OF-SCOPE.md",
    ];

    test("fresh repo: all 5 skill files are written under .claude/skills/tide-*/", async () => {
      writeValidEnv();
      writeValidConfig();
      const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
      const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

      const code = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsCreated(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: true },
          stateCapture
        ),
      });

      expect(code).toBe(0);
      for (const f of SKILL_FILES) {
        expect(existsSync(join(repoRoot, f))).toBe(true);
      }
    });

    test("identical-bytes second run: skill files are not rewritten (mtime preserved)", async () => {
      writeValidEnv();
      writeValidConfig();
      const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
      const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

      const firstCode = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsPresent(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: false },
          stateCapture
        ),
      });
      expect(firstCode).toBe(0);

      const mtimes = new Map<string, number>();
      for (const f of SKILL_FILES) {
        mtimes.set(f, statSync(join(repoRoot, f)).mtimeMs);
      }

      // Pause so any rewrite would change mtime detectably.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const secondCode = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsPresent(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: false },
          stateCapture
        ),
      });
      expect(secondCode).toBe(0);
      for (const f of SKILL_FILES) {
        expect(statSync(join(repoRoot, f)).mtimeMs).toBe(mtimes.get(f) ?? -1);
      }
    });

    test("hand-edited tide-to-prd SKILL.md is overwritten back to bundled bytes", async () => {
      writeValidEnv();
      writeValidConfig();
      const skillPath = join(repoRoot, ".claude/skills/tide-to-prd/SKILL.md");
      mkdirSync(join(repoRoot, ".claude/skills/tide-to-prd"), {
        recursive: true,
      });
      const handEdited = "# I rewrote this skill\n";
      writeFileSync(skillPath, handEdited);
      const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
      const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

      const code = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsCreated(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: true },
          stateCapture
        ),
      });

      expect(code).toBe(0);
      expect(readFileSync(skillPath, "utf8")).not.toBe(handEdited);
      // The frontmatter `name:` proves the bundled bytes won.
      expect(readFileSync(skillPath, "utf8")).toContain("name: tide-to-prd");
    });

    test("user-authored .claude/skills/my-custom-skill/ is left untouched", async () => {
      writeValidEnv();
      writeValidConfig();
      const customDir = join(repoRoot, ".claude/skills/my-custom-skill");
      const customFile = join(customDir, "SKILL.md");
      mkdirSync(customDir, { recursive: true });
      const customBody = "# my own skill\nfor my own use\n";
      writeFileSync(customFile, customBody);
      const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
      const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

      const code = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsCreated(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: true },
          stateCapture
        ),
      });

      expect(code).toBe(0);
      expect(readFileSync(customFile, "utf8")).toBe(customBody);
    });

    test("Linear failure does not skip skill writes", async () => {
      writeValidEnv();
      writeValidConfig();
      const setupLabelsFn: SetupLabelsFn = () =>
        Promise.reject(new Error("linear down"));
      const provisionFn: ProvisionInReviewStateFn = () =>
        Promise.reject(new Error("linear down"));

      const code = await legacySetup({
        repoRoot,
        setupLabels: setupLabelsFn,
        provisionInReviewState: provisionFn,
      });

      expect(code).toBe(1);
      for (const f of SKILL_FILES) {
        expect(existsSync(join(repoRoot, f))).toBe(true);
      }
    });
  });

  describe("bundled-skill bytes (frontmatter, hard-stop, repo-prefix guard)", () => {
    test("each skill carries the required frontmatter, tide setup hard-stop, and `.tide/config.ts` guard", async () => {
      writeValidEnv();
      writeValidConfig();
      const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
      const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

      const code = await legacySetup({
        repoRoot,
        setupLabels: buildSetupLabels(allLabelsPresent(), labelCapture),
        provisionInReviewState: buildProvisionState(
          { name: IN_REVIEW_STATE_NAME, created: false },
          stateCapture
        ),
      });
      expect(code).toBe(0);

      const cases: { name: string; crossRef: string | null }[] = [
        { name: "tide-to-prd", crossRef: "tide-to-issues" },
        { name: "tide-to-issues", crossRef: null },
        { name: "tide-triage", crossRef: null },
      ];
      for (const { name, crossRef } of cases) {
        const body = readFileSync(
          join(repoRoot, ".claude/skills", name, "SKILL.md"),
          "utf8"
        );
        expect(body).toContain(`name: ${name}`);
        expect(body).toContain(".tide/config.ts");
        expect(body).toContain("tide setup");
        expect(body).toContain(`\`${name}\``);
        if (crossRef !== null) {
          expect(body).toContain(crossRef);
        }
        expect(body).not.toContain(`name: linear-`);
      }

      // tide-to-issues: no historical "merged Linear flavor" preamble.
      const toIssues = readFileSync(
        join(repoRoot, ".claude/skills/tide-to-issues/SKILL.md"),
        "utf8"
      );
      expect(toIssues).not.toContain("merged Linear flavor");
      expect(toIssues).not.toContain("to-issues-native");
    });
  });
});
