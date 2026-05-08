import { spawn } from "node:child_process";
import { intro, log, outro } from "@clack/prompts";
import { discoverRepoRoot } from "../repo-discovery/index.ts";
import { loadConfig } from "../config-loader/index.ts";
import { loadEnv } from "../env-loader/index.ts";
import { getGhIdentity } from "../gh-identity/index.ts";
import {
  LinearSdkService,
  type LinearService,
} from "../services/linear/index.ts";
import {
  classifyBridge as defaultClassifyBridge,
  describeBridgeForUser,
  type BridgeState,
} from "../sandcastle-bridge/index.ts";

declare const VERSION: string | undefined;
const version: string = typeof VERSION === "string" ? VERSION : "dev";

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type Runner = (
  cmd: string,
  args: readonly string[],
  cwd?: string
) => Promise<ExecResult>;

const defaultRunner: Runner = (cmd, args, cwd) =>
  new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });

/**
 * Inspects the on-disk shape of the sandcastle bridge. Pulled out as a test
 * seam so doctor tests can assert ordering against the runner's call log
 * without setting up filesystem fixtures for every state.
 */
export type ClassifyBridgeFn = (repoRoot: string) => BridgeState;

export interface DoctorOptions {
  /** Repo root override (defaults to repo-discovery from cwd). */
  repoRoot?: string;
  /** Process runner (used by tests to stub gh + docker). */
  runner?: Runner;
  /** Linear-facing service. Tests inject an `InMemoryLinearService`;
   * production constructs a `LinearSdkService` inline once env+config
   * load. Optional only because the production path cannot construct it
   * before env+config have been loaded. */
  linear?: LinearService;
  /** Sandcastle bridge classification (used by tests to stub on-disk shape). */
  classifyBridge?: ClassifyBridgeFn;
}

interface CheckResult {
  ok: boolean;
  hint?: string;
}

interface Step {
  name: string;
  run: () => Promise<CheckResult> | CheckResult;
}

/**
 * Runs the full preflight matrix in fixed order, printing each step's status.
 * Exits zero when every step passes; non-zero otherwise. The first failure
 * is annotated with a remediation hint.
 */
export async function doctor(options: DoctorOptions = {}): Promise<number> {
  const runner = options.runner ?? defaultRunner;
  const classifyBridgeFn = options.classifyBridge ?? defaultClassifyBridge;

  intro("tide doctor");

  let repoRoot: string;
  try {
    repoRoot = options.repoRoot ?? discoverRepoRoot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(msg);
    outro("Aborted.");
    return 1;
  }

  // We resolve env and config lazily so each step's failure is reported in
  // isolation. The cached results are reused by later steps when available.
  let envCache: Record<string, string> | null = null;
  let teamKeyCache: string | null = null;
  // Cached LinearService — built on demand from envCache + teamKeyCache,
  // or supplied directly via `options.linear`. Used by the "Linear API"
  // and "Linear In Review state" checks. Even when injected via options,
  // the service is only consulted once env + config have loaded, so a
  // missing .tide/.env / .tide/config.ts still surfaces as a skip rather
  // than spuriously calling Linear.
  let linearCache: LinearService | null = null;

  function getLinearService(): LinearService | null {
    if (envCache === null || teamKeyCache === null) return null;
    const apiKey = envCache.LINEAR_API_KEY;
    if (typeof apiKey !== "string" || apiKey === "") return null;
    if (linearCache !== null) return linearCache;
    linearCache =
      options.linear ??
      new LinearSdkService({
        apiKey,
        teamKey: teamKeyCache,
        repoName: "",
      });
    return linearCache;
  }

  const steps: Step[] = [
    {
      // Check #1 by design: zero preconditions (no env, no config, no Linear,
      // no GitHub) and a broken bridge invalidates the path assumptions every
      // later check makes about `.sandcastle/`. Detect-only — repair lives in
      // `tide setup`. See ADR-0011.
      name: "sandcastle bridge",
      run: () => {
        const state = classifyBridgeFn(repoRoot);
        if (state.kind === "intact" || state.kind === "missing") {
          return { ok: true };
        }
        return {
          ok: false,
          hint: `${describeBridgeForUser(state)} Run \`tide setup\` to repair.`,
        };
      },
    },
    {
      name: "gh auth",
      run: async () => {
        const result = await runner("gh", ["auth", "status"]);
        if (result.exitCode !== 0) {
          return {
            ok: false,
            hint: "Run `gh auth login` to authenticate with GitHub.",
          };
        }
        return { ok: true };
      },
    },
    {
      name: ".tide/.env",
      run: () => {
        try {
          envCache = loadEnv({ repoRoot });
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            hint:
              err instanceof Error ? err.message : "Could not load .tide/.env.",
          };
        }
      },
    },
    {
      name: ".tide/config.ts",
      run: async () => {
        try {
          const config = await loadConfig({ repoRoot });
          teamKeyCache = config.linear.team;
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            hint:
              err instanceof Error
                ? err.message
                : "Could not load .tide/config.ts.",
          };
        }
      },
    },
    {
      name: "docker daemon",
      run: async () => {
        const result = await runner("docker", ["info"]);
        if (result.exitCode !== 0) {
          return {
            ok: false,
            hint: "Docker daemon is not reachable. Start Docker Desktop or `systemctl start docker`.",
          };
        }
        return { ok: true };
      },
    },
    {
      name: "Linear API",
      run: async () => {
        const linear = getLinearService();
        if (linear === null) {
          if (envCache === null) {
            return {
              ok: false,
              hint: "Skipped — .tide/.env did not load.",
            };
          }
          const apiKey = envCache.LINEAR_API_KEY;
          if (typeof apiKey !== "string" || apiKey === "") {
            return {
              ok: false,
              hint: "LINEAR_API_KEY in .tide/.env is empty.",
            };
          }
          // Fall through: the service couldn't be built but env is in
          // place — config/teamKey must be missing.
          return {
            ok: false,
            hint: "Skipped — Linear team key is unavailable.",
          };
        }
        try {
          await linear.viewer();
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            hint: `Linear viewer query failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    },
    {
      name: 'Linear "In Review" state',
      run: async () => {
        const linear = getLinearService();
        if (linear === null) {
          return {
            ok: false,
            hint: "Skipped — .tide/.env or .tide/config.ts did not load.",
          };
        }
        try {
          await linear.assertInReviewStatePresent();
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            hint: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
    {
      name: "gh repo identity",
      run: async () => {
        try {
          await getGhIdentity({ repoRoot }, async (cmd, args, cwd) =>
            runner(cmd, args, cwd)
          );
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            hint:
              err instanceof Error
                ? err.message
                : "gh repo view failed; ensure the repo's git remote points to github.com.",
          };
        }
      },
    },
    {
      name: `tide version (${version})`,
      run: () => ({ ok: true }),
    },
  ];

  let firstFailureHint: string | null = null;
  let failed = false;
  for (const step of steps) {
    let result: CheckResult;
    try {
      result = await step.run();
    } catch (err) {
      result = {
        ok: false,
        hint: err instanceof Error ? err.message : String(err),
      };
    }

    if (result.ok) {
      log.success(step.name);
    } else {
      log.error(
        result.hint !== undefined ? `${step.name}: ${result.hint}` : step.name
      );
      if (!failed && result.hint !== undefined) {
        firstFailureHint = result.hint;
      }
      failed = true;
    }
  }

  if (failed) {
    outro(
      firstFailureHint !== null
        ? `tide doctor: ${firstFailureHint}`
        : "tide doctor: one or more checks failed."
    );
    return 1;
  }

  outro("tide doctor: all checks passed.");
  return 0;
}
