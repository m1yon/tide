import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setup,
  type ProvisionInReviewStateFn,
  type SetupLabelsFn,
} from "./setup.ts";
import {
  IN_REVIEW_STATE_NAME,
  SETUP_LABEL_NAMES,
  type LinearContext,
  type ProvisionInReviewStateResult,
  type SetupLabelResult,
} from "../linear/index.ts";

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

    const code = await setup({
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

    const code = await setup({
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

    const code = await setup({
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

    const code = await setup({
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

    const code = await setup({
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

    const code = await setup({
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

    const code = await setup({
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

  test("missing .tide/config.ts yields non-zero exit and skips both Linear stubs", async () => {
    writeValidEnv();
    const labelCapture: SetupLabelsCapture = { ctx: null, callCount: 0 };
    const stateCapture: ProvisionStateCapture = { ctx: null, callCount: 0 };

    const code = await setup({
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

    const code = await setup({
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

    const code = await setup({
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

    const code = await setup({
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
      code = await setup({
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
});
