import { discoverRepoRoot } from "../repo-discovery/index.ts";
import { loadConfig } from "../config-loader/index.ts";
import { loadEnv } from "../env-loader/index.ts";
import {
  setupLabels as defaultSetupLabels,
  type LinearContext,
  type SetupLabelResult,
} from "../linear/index.ts";

/**
 * Test seam — defaults to the real `linear.setupLabels`. Tests stub this to
 * avoid hitting the Linear API.
 */
export type SetupLabelsFn = (ctx: LinearContext) => Promise<SetupLabelResult[]>;

export interface SetupOptions {
  /** Repo root override (defaults to repo-discovery from cwd). */
  repoRoot?: string;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  /** Linear `setupLabels` injection (used by tests to stub the SDK). */
  setupLabels?: SetupLabelsFn;
}

/**
 * `tide setup` — idempotently create the three Linear labels required by the
 * Linear-native flow on the configured team. Reports per-label whether it was
 * created or was already present. Re-running on a fully provisioned team is a
 * no-op that exits zero.
 */
export async function setup(options: SetupOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = options.stderr ?? ((s: string) => process.stderr.write(s));
  const setupLabelsFn = options.setupLabels ?? defaultSetupLabels;

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

  let results: SetupLabelResult[];
  try {
    results = await setupLabelsFn(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`tide setup: ${msg}\n`);
    return 1;
  }

  const created = results.filter((r) => r.created);
  const existing = results.filter((r) => !r.created);

  stdout(`tide setup: Linear team "${teamKey}"\n`);
  if (created.length > 0) {
    stdout(`  created:\n`);
    for (const r of created) stdout(`    - ${r.name}\n`);
  }
  if (existing.length > 0) {
    stdout(`  already present:\n`);
    for (const r of existing) stdout(`    - ${r.name}\n`);
  }
  if (created.length === 0) {
    stdout(`tide setup: nothing to do — all labels already present.\n`);
  } else {
    stdout(`tide setup: created ${String(created.length)} label(s).\n`);
  }
  return 0;
}
