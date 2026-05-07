import { intro, log, outro, spinner } from "@clack/prompts";
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

export interface SetupOptions {
  /** Repo root override (defaults to repo-discovery from cwd). */
  repoRoot?: string;
  /** Linear `setupLabels` injection (used by tests to stub the SDK). */
  setupLabels?: SetupLabelsFn;
  /** Linear `provisionInReviewState` injection (used by tests). */
  provisionInReviewState?: ProvisionInReviewStateFn;
}

/**
 * `tide setup` — idempotently provision everything tide expects on the
 * configured Linear team:
 *  - the three canonical labels (`prd`, `ready-for-agent`, `ready-for-human`)
 *  - the `"In Review"` workflow state, positioned strictly between
 *    "In Progress" and "Done"
 *
 * Reports per-resource whether it was created or was already present in a
 * single unified summary. Re-running on a fully provisioned team is a no-op
 * that exits zero. Each step's failure is reported independently — a label
 * failure does not skip the state step, and vice versa, so the summary
 * always tells the user what is and is not present on the team.
 */
export async function setup(options: SetupOptions = {}): Promise<number> {
  const setupLabelsFn = options.setupLabels ?? defaultSetupLabels;
  const provisionInReviewStateFn =
    options.provisionInReviewState ?? defaultProvisionInReviewState;

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

  let envMap: Record<string, string>;
  try {
    envMap = loadEnv({ repoRoot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(msg);
    outro("Aborted.");
    return 1;
  }

  const apiKey = envMap.LINEAR_API_KEY;
  if (typeof apiKey !== "string" || apiKey === "") {
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

  interface SummaryRow {
    kind: "label" | "state";
    name: string;
  }
  const created: SummaryRow[] = [];
  const existing: SummaryRow[] = [];
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
