import { confirm, intro, isCancel, log, outro, spinner } from "@clack/prompts";
import { join, relative } from "node:path";
import { discoverRepoRoot } from "../repo-discovery/index.ts";
import { loadConfig } from "../config-loader/index.ts";
import { loadEnv } from "../env-loader/index.ts";
import {
  provisionInReviewState as defaultProvisionInReviewState,
  setupLabels as defaultSetupLabels,
  type LinearContext,
  type ProvisionInReviewStateResult,
  type SetupLabelResult,
} from "../linear/index.ts";
import {
  classifyBridge,
  createBridgeIfMissing,
  describeBridgeForUser,
  repairBridge,
} from "../sandcastle-bridge/index.ts";
import {
  writeTemplates,
  type WriteResult,
  type WriteTarget,
} from "../template-writer/index.ts";
import configTsRaw from "./setup-templates/tide/config.ts" with { type: "text" };
import dockerfile from "./setup-templates/tide/Dockerfile" with { type: "text" };
import promptMd from "./setup-templates/tide/prompt.md" with { type: "text" };
import promptStandaloneMd from "./setup-templates/tide/prompt-standalone.md" with { type: "text" };
import envExample from "./setup-templates/tide/.env.example" with { type: "text" };
import gitignore from "./setup-templates/tide/.gitignore" with { type: "text" };
import tideToPrdSkillMd from "./setup-templates/claude-skills/tide-to-prd/SKILL.md" with { type: "text" };
import tideToIssuesSkillMd from "./setup-templates/claude-skills/tide-to-issues/SKILL.md" with { type: "text" };
import tideTriageSkillMd from "./setup-templates/claude-skills/tide-triage/SKILL.md" with { type: "text" };
import tideTriageAgentBriefMd from "./setup-templates/claude-skills/tide-triage/AGENT-BRIEF.md" with { type: "text" };
import tideTriageOutOfScopeMd from "./setup-templates/claude-skills/tide-triage/OUT-OF-SCOPE.md" with { type: "text" };

const configTs = configTsRaw as unknown as string;

/**
 * `.tide/` scaffold targets. The user is expected to hand-edit `config.ts`,
 * `prompt.md`, etc. after first creation, so the policy is `skip-if-exists`.
 */
const TIDE_SCAFFOLD: readonly { relPath: string; content: string }[] = [
  { relPath: ".tide/config.ts", content: configTs },
  { relPath: ".tide/Dockerfile", content: dockerfile },
  { relPath: ".tide/prompt.md", content: promptMd },
  { relPath: ".tide/prompt-standalone.md", content: promptStandaloneMd },
  { relPath: ".tide/.env.example", content: envExample },
  { relPath: ".tide/.gitignore", content: gitignore },
];

/**
 * Bundled-skill targets. tide owns these bytes — re-running setup overwrites
 * any local edit (silently if identical). Forks live under a different name
 * (e.g. `.claude/skills/my-to-prd/`), which tide leaves alone.
 */
const BUNDLED_SKILLS: readonly { relPath: string; content: string }[] = [
  {
    relPath: ".claude/skills/tide-to-prd/SKILL.md",
    content: tideToPrdSkillMd,
  },
  {
    relPath: ".claude/skills/tide-to-issues/SKILL.md",
    content: tideToIssuesSkillMd,
  },
  {
    relPath: ".claude/skills/tide-triage/SKILL.md",
    content: tideTriageSkillMd,
  },
  {
    relPath: ".claude/skills/tide-triage/AGENT-BRIEF.md",
    content: tideTriageAgentBriefMd,
  },
  {
    relPath: ".claude/skills/tide-triage/OUT-OF-SCOPE.md",
    content: tideTriageOutOfScopeMd,
  },
];

/**
 * Test seam — defaults to the real `linear.setupLabels`. Tests stub this to
 * avoid hitting the Linear API.
 */
export type SetupLabelsFn = (ctx: LinearContext) => Promise<SetupLabelResult[]>;

/**
 * Test seam — defaults to the real `linear.provisionInReviewState`. Tests
 * stub this to avoid hitting the Linear API.
 */
export type ProvisionInReviewStateFn = (
  ctx: LinearContext
) => Promise<ProvisionInReviewStateResult>;

/**
 * Test seam for the destructive bridge-repair confirm prompt. Returns true
 * when the user has consented to the repair, false otherwise (decline,
 * cancel, non-TTY). Tests stub this to bypass the clack TTY gate. The bridge
 * state has already been described to the user via `log.warn` by the time
 * this fires.
 */
export type ConfirmBridgeRepairFn = () => Promise<boolean>;

export interface SetupOptions {
  /** Repo root override (defaults to repo-discovery from cwd). */
  repoRoot?: string;
  /** Linear `setupLabels` injection (used by tests to stub the SDK). */
  setupLabels?: SetupLabelsFn;
  /** Linear `provisionInReviewState` injection (used by tests). */
  provisionInReviewState?: ProvisionInReviewStateFn;
  /** Bridge-repair confirm prompt (used by tests to bypass clack). */
  confirmBridgeRepair?: ConfirmBridgeRepairFn;
}

async function defaultConfirmBridgeRepair(): Promise<boolean> {
  const answer = await confirm({
    message:
      "Repair the sandcastle bridge? This will delete the above and recreate the symlink.",
    initialValue: false,
  });
  if (isCancel(answer)) return false;
  return answer;
}

interface SummaryRow {
  kind: "label" | "state" | "file";
  name: string;
}

function summaryRowFromFile(repoRoot: string, r: WriteResult): SummaryRow {
  return { kind: "file", name: relative(repoRoot, r.targetPath) };
}

function emitSummary(created: SummaryRow[], existing: SummaryRow[]): void {
  if (created.length > 0) {
    log.success(
      ["Created:", ...created.map((r) => `  - ${r.name} (${r.kind})`)].join(
        "\n"
      )
    );
  }
  if (existing.length > 0) {
    log.message(
      [
        "Already present:",
        ...existing.map((r) => `  - ${r.name} (${r.kind})`),
      ].join("\n")
    );
  }
}

/**
 * `tide setup` — idempotently provision everything tide expects on a tide-
 * managed repo:
 *  - the sandcastle bridge symlink
 *  - the `.tide/` scaffold (config.ts, Dockerfile, prompt.md,
 *    prompt-standalone.md, .env.example, .gitignore), skip-if-exists so
 *    user-edited files are preserved
 *  - the three canonical Linear labels (`prd`, `ready-for-agent`,
 *    `ready-for-human`)
 *  - the `"In Review"` workflow state, positioned strictly between
 *    "In Progress" and "Done"
 *
 * Reports per-resource whether it was created or was already present in a
 * single unified summary. Re-running on a fully provisioned repo is a no-op
 * that exits zero. Each step's failure is reported independently — a label
 * failure does not skip the state step, and vice versa.
 */
export async function setup(options: SetupOptions = {}): Promise<number> {
  const setupLabelsFn = options.setupLabels ?? defaultSetupLabels;
  const provisionInReviewStateFn =
    options.provisionInReviewState ?? defaultProvisionInReviewState;
  const confirmBridgeRepairFn =
    options.confirmBridgeRepair ?? defaultConfirmBridgeRepair;

  intro("tide setup");

  let repoRoot: string;
  try {
    repoRoot = options.repoRoot ?? discoverRepoRoot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(msg);
    outro("Aborted.");
    return 1;
  }

  // Step 1: sandcastle bridge. Runs before env/config so a fresh-clone setup
  // that fails on a missing LINEAR_API_KEY still leaves a healthy bridge. The
  // intact and missing states are silent (auto-create on missing); the four
  // broken states describe what's on disk and prompt before any destructive
  // action. Decline / cancel exits non-zero with the bridge untouched.
  const bridgeState = classifyBridge(repoRoot);
  if (bridgeState.kind === "missing") {
    try {
      createBridgeIfMissing(repoRoot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Sandcastle bridge: ${msg}`);
      outro("Aborted.");
      return 1;
    }
  } else if (bridgeState.kind !== "intact") {
    log.warn(describeBridgeForUser(bridgeState));
    const confirmed = await confirmBridgeRepairFn();
    if (!confirmed) {
      outro("Sandcastle bridge repair declined. Aborted.");
      return 1;
    }
    try {
      repairBridge(repoRoot, bridgeState);
      log.success("Sandcastle bridge repaired.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Sandcastle bridge repair failed: ${msg}`);
      outro("Aborted.");
      return 1;
    }
  }

  // Step 2: `.tide/` scaffold writes. Skip-if-exists so user-edited files
  // (config.ts, prompt.md) survive a re-run. Runs before env/config loading
  // so a brand-new repo gets the scaffold (including .env.example) on the
  // first `tide setup`, even though env loading will fail downstream.
  const scaffoldTargets: WriteTarget[] = TIDE_SCAFFOLD.map(
    ({ relPath, content }) => ({
      targetPath: join(repoRoot, relPath),
      content,
      policy: "skip-if-exists",
    })
  );
  const scaffoldResults = writeTemplates(scaffoldTargets);

  // Step 3: bundled-skill writes. tide owns these bytes — overwrite-silent-
  // if-identical means a no-op when the local file matches the embedded
  // version, an mtime-changing rewrite otherwise. The scope is bounded to
  // the `tide-*/` namespace under `.claude/skills/`; user-authored skills
  // outside that prefix are never touched.
  const skillTargets: WriteTarget[] = BUNDLED_SKILLS.map(
    ({ relPath, content }) => ({
      targetPath: join(repoRoot, relPath),
      content,
      policy: "overwrite-silent-if-identical",
    })
  );
  const skillResults = writeTemplates(skillTargets);

  const created: SummaryRow[] = [];
  const existing: SummaryRow[] = [];
  for (const r of [...scaffoldResults, ...skillResults]) {
    const row = summaryRowFromFile(repoRoot, r);
    if (r.outcome === "created" || r.outcome === "overwritten") {
      created.push(row);
    } else {
      existing.push(row);
    }
  }

  let envMap: Record<string, string>;
  try {
    envMap = loadEnv({ repoRoot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitSummary(created, existing);
    log.error(msg);
    outro("Aborted.");
    return 1;
  }

  const apiKey = envMap.LINEAR_API_KEY;
  if (typeof apiKey !== "string" || apiKey === "") {
    emitSummary(created, existing);
    log.error("LINEAR_API_KEY is empty in .tide/.env");
    outro("Aborted.");
    return 1;
  }

  let teamKey: string;
  try {
    const config = await loadConfig({ repoRoot });
    teamKey = config.linear.team;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitSummary(created, existing);
    log.error(msg);
    outro("Aborted.");
    return 1;
  }

  const ctx: LinearContext = { apiKey, teamKey };

  log.info(`Linear team "${teamKey}"`);

  // Run the two provisioning steps independently so a failure in one is
  // surfaced without skipping the other. The user gets a single unified
  // report and a non-zero exit if anything failed.
  const labelSpin = spinner();
  labelSpin.start("Provisioning Linear labels");
  let labelResults: SetupLabelResult[] | undefined;
  let labelError: string | undefined;
  try {
    labelResults = await setupLabelsFn(ctx);
    labelSpin.stop("Linear labels checked");
  } catch (err) {
    labelError = err instanceof Error ? err.message : String(err);
    labelSpin.stop("Linear label provisioning failed");
  }

  const stateSpin = spinner();
  stateSpin.start('Provisioning "In Review" workflow state');
  let stateResult: ProvisionInReviewStateResult | undefined;
  let stateError: string | undefined;
  try {
    stateResult = await provisionInReviewStateFn(ctx);
    stateSpin.stop('"In Review" workflow state checked');
  } catch (err) {
    stateError = err instanceof Error ? err.message : String(err);
    stateSpin.stop('"In Review" workflow state provisioning failed');
  }

  if (labelResults !== undefined) {
    for (const r of labelResults) {
      (r.created ? created : existing).push({ kind: "label", name: r.name });
    }
  }
  if (stateResult !== undefined) {
    (stateResult.created ? created : existing).push({
      kind: "state",
      name: stateResult.name,
    });
  }

  emitSummary(created, existing);

  if (labelError !== undefined) {
    log.error(`label provisioning failed: ${labelError}`);
  }
  if (stateError !== undefined) {
    log.error(`workflow-state provisioning failed: ${stateError}`);
  }
  if (labelError !== undefined || stateError !== undefined) {
    outro("Setup completed with errors.");
    return 1;
  }

  if (created.length === 0) {
    outro("Nothing to do — all resources already present.");
  } else {
    outro(`Created ${String(created.length)} resource(s).`);
  }
  return 0;
}
