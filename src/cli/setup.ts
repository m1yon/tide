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
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
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
  const stdout = options.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = options.stderr ?? ((s: string) => process.stderr.write(s));
  const setupLabelsFn = options.setupLabels ?? defaultSetupLabels;
  const provisionInReviewStateFn =
    options.provisionInReviewState ?? defaultProvisionInReviewState;

  let repoRoot: string;
  try {
    repoRoot = options.repoRoot ?? discoverRepoRoot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  let envMap: Record<string, string>;
  try {
    envMap = loadEnv({ repoRoot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  const apiKey = envMap.LINEAR_API_KEY;
  if (typeof apiKey !== "string" || apiKey === "") {
    stderr(`tide: LINEAR_API_KEY is empty in .tide/.env\n`);
    return 1;
  }

  let teamKey: string;
  try {
    const config = await loadConfig({ repoRoot });
    teamKey = config.linear.team;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  const ctx: LinearContext = { apiKey, teamKey };

  // Run the two provisioning steps independently so a failure in one is
  // surfaced without skipping the other. The user gets a single unified
  // report and a non-zero exit if anything failed.
  let labelResults: SetupLabelResult[] | undefined;
  let labelError: string | undefined;
  try {
    labelResults = await setupLabelsFn(ctx);
  } catch (err) {
    labelError = err instanceof Error ? err.message : String(err);
  }

  let stateResult: ProvisionInReviewStateResult | undefined;
  let stateError: string | undefined;
  try {
    stateResult = await provisionInReviewStateFn(ctx);
  } catch (err) {
    stateError = err instanceof Error ? err.message : String(err);
  }

  stdout(`tide setup: Linear team "${teamKey}"\n`);

  interface SummaryRow {
    kind: "label" | "state";
    name: string;
    created: boolean;
  }
  const created: SummaryRow[] = [];
  const existing: SummaryRow[] = [];
  if (labelResults !== undefined) {
    for (const r of labelResults) {
      (r.created ? created : existing).push({
        kind: "label",
        name: r.name,
        created: r.created,
      });
    }
  }
  if (stateResult !== undefined) {
    (stateResult.created ? created : existing).push({
      kind: "state",
      name: stateResult.name,
      created: stateResult.created,
    });
  }

  if (created.length > 0) {
    stdout(`  created:\n`);
    for (const r of created) {
      stdout(`    - ${r.name} (${r.kind})\n`);
    }
  }
  if (existing.length > 0) {
    stdout(`  already present:\n`);
    for (const r of existing) {
      stdout(`    - ${r.name} (${r.kind})\n`);
    }
  }

  if (labelError !== undefined) {
    stderr(`tide setup: label provisioning failed: ${labelError}\n`);
  }
  if (stateError !== undefined) {
    stderr(`tide setup: workflow-state provisioning failed: ${stateError}\n`);
  }
  if (labelError !== undefined || stateError !== undefined) {
    return 1;
  }

  if (created.length === 0) {
    stdout(`tide setup: nothing to do — all resources already present.\n`);
  } else {
    stdout(`tide setup: created ${String(created.length)} resource(s).\n`);
  }
  return 0;
}
