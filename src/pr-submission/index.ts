// PR submission tail-step for `tide run`.
//
// After `runIssueQueue` succeeds, `tideRun` calls `runPrSubmission` to fire
// a single Sandcastle iteration whose only job is to open a PR via `gh pr
// create`. Success is verified host-side via `gh pr list --head <branch>`
// (the iteration produces no commit, so the runner's commit-based
// isFailedRun heuristic is not reused). The host-side `git push` previously
// performed here has moved to `runIssueQueue`, which pushes after every
// working-agent iteration (see ADR-0007); by the time this runs, every
// commit on the feature branch is already on origin.
//
// The bundled prompt template is interface-emphasizing (Ousterhout: the
// change callers see is the change that matters) and ships as a TypeScript
// string constant — not user-editable like `.tide/prompt.md`. Substitution
// is driven by `buildPrPromptArgs`, a pure function that returns the
// `{{KEY}}` map applied to the template.
//
// Scope: only the "opened" path. The "updated" path (re-run with an
// existing PR) is out of scope for this slice.

import { spawn } from "node:child_process";
import {
  createSandbox as defaultCreateSandbox,
  claudeCode,
  type CreateSandboxOptions,
  type Sandbox,
  type SandboxRunOptions,
} from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import type { TideConfig } from "../config-loader/index.ts";
import type { GhRepo } from "../github/index.ts";
import { DONE_SIGNAL, type SandboxRunFn } from "../runner/index.ts";

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ShellRunner = (
  cmd: string,
  args: readonly string[],
  cwd: string
) => Promise<ShellResult>;

export interface SubIssueRef {
  number: number;
  title: string;
}

export interface RunPrSubmissionOptions {
  ghRepo: GhRepo;
  branch: string;
  baseBranch: string;
  /** Linear PRD identifier (e.g. "MEC-123"). Informational only — there is
   * no closing magic word emitted in the PR body. The PR↔PRD link is the
   * branch name alone. */
  parentIdentifier: string;
  parentTitle: string;
  /** Linear PRD URL. Informational only — surfaces in the body so reviewers
   * can click through. */
  parentUrl: string;
  // Topo-ordered sub-issues addressed by this PR. Surfaces in the rendered
  // prompt's Context section so the agent can scope its diff summary.
  subIssues: SubIssueRef[];
  repoRoot: string;
  config: TideConfig;
  // Env map intended for the docker sandbox. Caller is responsible for
  // stripping LINEAR_API_KEY (matches the queue runner's contract).
  sandboxEnv: Record<string, string>;
  // Test seams.
  shellRunner?: ShellRunner;
  /** Test seam — when provided, no real sandbox is created and the function
   * is called in place of `sandbox.run(...)`. Defaults to a real
   * `sandbox.run.bind(sandbox)` of a `Sandbox` built via `createSandbox`. */
  sandboxRun?: SandboxRunFn;
  /** Test seam — defaults to sandcastle's `createSandbox`. Only consulted
   * when `sandboxRun` is not provided. */
  createSandbox?: (opts: CreateSandboxOptions) => Promise<Sandbox>;
}

export interface PrSubmissionResult {
  url: string;
  action: "opened";
}

async function defaultShellRunner(
  cmd: string,
  args: readonly string[],
  cwd: string
): Promise<ShellResult> {
  return await new Promise<ShellResult>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
}

/**
 * Count how many commits `branch` is ahead of `baseBranch` via
 * `git rev-list --count <baseBranch>..<branch>`. Used host-side as the gate
 * before invoking the PR-submission iteration: a zero-commits branch can't
 * produce a meaningful PR.
 */
export async function countCommitsAhead(
  repoRoot: string,
  baseBranch: string,
  branch: string,
  shellRunner: ShellRunner = defaultShellRunner
): Promise<number> {
  const range = `${baseBranch}..${branch}`;
  const r = await shellRunner("git", ["rev-list", "--count", range], repoRoot);
  if (r.exitCode !== 0) {
    const stderr = r.stderr.trim();
    throw new Error(
      `tide: \`git rev-list --count ${range}\` failed (exit ${String(r.exitCode)})${stderr === "" ? "" : `: ${stderr}`}`
    );
  }
  const trimmed = r.stdout.trim();
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== trimmed) {
    throw new Error(
      `tide: \`git rev-list --count ${range}\` returned non-numeric output: ${trimmed}`
    );
  }
  return n;
}

/**
 * Capture the current branch via `git rev-parse --abbrev-ref HEAD`. Throws
 * with a clear message on detached HEAD ("HEAD") so the caller can fail fast
 * before any Sandcastle work runs.
 */
export async function resolveBaseBranch(
  repoRoot: string,
  shellRunner: ShellRunner = defaultShellRunner
): Promise<string> {
  const r = await shellRunner(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    repoRoot
  );
  if (r.exitCode !== 0) {
    const stderr = r.stderr.trim();
    throw new Error(
      `tide: \`git rev-parse --abbrev-ref HEAD\` failed (exit ${String(r.exitCode)})${stderr === "" ? "" : `: ${stderr}`}`
    );
  }
  const branch = r.stdout.trim();
  if (branch === "" || branch === "HEAD") {
    throw new Error(
      "tide: detached HEAD detected. Check out a branch before running `tide run`."
    );
  }
  return branch;
}

// Bundled, interface-emphasizing PR template. Renders five body sections
// (🚩 The Problem · 💡 The Solution · 🏗 Interface Movements · 📦 Package
// Breakdowns · 🧹 Housekeeping & Secondary Changes) plus a Conventional
// Commits title rule. The agent classifies changed identifiers as
// public/private using the rules in the `Interface Movements` section and
// populates the table only with public surface that actually moved.
//
// No closing magic word is emitted (neither GitHub `Closes #` nor Linear
// `Fixes`). The PR↔PRD link is the branch name alone — Linear's GitHub
// integration auto-transitions the PRD on merge by matching the branch.
//
// Single-phase: no `<sub>Files-changed:</sub>` anchor links — those would
// require a two-phase create-then-edit flow to inject post-creation URLs.
const PR_PROMPT_TEMPLATE = `You are submitting a pull request for parent PRD {{PARENT_ID}}: {{PARENT_TITLE}}.

The current working branch is \`{{SOURCE_BRANCH}}\` (already pushed to origin). Open a pull request against the base branch \`{{TARGET_BRANCH}}\` for the repository \`{{REPO_OWNER}}/{{REPO_NAME}}\`.

# Context

- Parent PRD: {{PARENT_ID}} ({{PARENT_URL}})
- Sub-issues addressed (in order):
{{SUB_ISSUES}}

# Title

Use Conventional Commits: \`<type>(<scope>): <subject>\`.

- \`<type>\` is one of \`feat\`, \`fix\`, \`chore\`, \`docs\`, \`refactor\`, \`test\`, \`build\`, \`ci\`, \`perf\`, \`style\`. Pick the type that best matches the headline change in the diff.
- \`<scope>\` is the package or area touched. Optional — omit it for multi-package PRDs that span scopes.
- \`<subject>\` is a concise, imperative-mood summary derived from the diff.

Examples: \`feat(runner): add per-iteration timeout\` or \`refactor: extract pr-submission module\`.

# Body — sections in this exact order

Render the body as the sections below, in order, with the exact emoji headers shown. Do not emit any issue-closing keyword (neither GitHub nor Linear) anywhere in the body. The branch name alone links the PR to the Linear PRD; Linear's GitHub integration auto-transitions the PRD on merge.

## 🚩 The Problem

2–4 bullets. What was wrong, missing, or painful before this change. Frame from the user's or caller's point of view, not the implementer's.

## 💡 The Solution

2–4 bullets. What changed at the conceptual level. Where it applies, name the operation explicitly:

- **Deepen** — add functionality behind an existing interface.
- **Widen** — broaden an interface to handle a new shape of input/output.
- **Extract** — pull a chunk into a new module with its own boundary.

## 🏗 Interface Movements

A markdown table with columns: \`Symbol | Old location | New location | Notes\`.

Populate the table only with **public** surface that actually moved. Public means anything a caller outside this PR's diff could observe:

- TypeScript / JavaScript: any symbol exported via \`export\` from a package or a public module entry point. Internal helpers (un-exported, or under an \`_internal\` re-export) are private.
- HTTP / RPC: any route, method, request/response field, or status code reachable from outside the service.
- CLI: any command, sub-command, flag, or environment variable.
- Config: any key in user-facing config files (\`.tide/config.ts\`, \`package.json\`'s public fields, etc.).

If nothing public moved, write \`_(no public surface moved)_\` instead of an empty table.

## 📦 Package Breakdowns

For each package or top-level directory that changed, add a \`<details>\` block:

    <details>
    <summary><code>src/&lt;package&gt;/</code> — one-line summary</summary>

    - bullet describing the change in this package
    - another bullet

    </details>

Group by directory, not by file. Order packages so a reviewer can walk through them naturally — entry points first, then leaf modules, then tests.

## 🧹 Housekeeping & Secondary Changes

Anything that is not part of the headline change but ships in the same PR: dependency bumps, formatting passes, comment cleanups, test refactors, docs touch-ups. One bullet per item. If there is none, write \`_(none)_\`.

Do not include \`<sub>Files-changed:</sub>\` anchor links — the bundled template uses a single-phase \`gh pr create\` and does not inject post-creation URLs.

# How to submit

Run \`gh pr create\` against the right base. A safe invocation:

    gh pr create \\
      --repo {{REPO_OWNER}}/{{REPO_NAME}} \\
      --base {{TARGET_BRANCH}} \\
      --head {{SOURCE_BRANCH}} \\
      --title "<your title here>" \\
      --body-file <(cat <<'PR_BODY_EOF'
    <your fully-rendered body here, with no closing magic word>
    PR_BODY_EOF
    )

When the PR has been opened successfully, emit <promise>DONE</promise> and exit. Do not edit any files in the working tree.
`;

export interface BuildPrPromptArgsInput {
  /** Linear PRD identifier (e.g. "MEC-123"). */
  parentIdentifier: string;
  parentTitle: string;
  /** Linear PRD URL. */
  parentUrl: string;
  branch: string;
  baseBranch: string;
  repoOwner: string;
  repoName: string;
  subIssues: SubIssueRef[];
}

export type PrPromptArgsRecord = Record<string, string | number>;

const SUB_ISSUES_NONE = "_(none)_";

// Collapse internal whitespace runs (including embedded newlines and
// carriage returns) to a single space, then trim. Keeps user-controlled
// titles from breaking the markdown structure of the rendered prompt.
function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderSubIssues(subs: readonly SubIssueRef[]): string {
  if (subs.length === 0) return SUB_ISSUES_NONE;
  return subs
    .map((s) => `- #${String(s.number)} ${sanitizeInline(s.title)}`)
    .join("\n");
}

/**
 * Pure: build the `{{KEY}}` substitution map for the bundled PR prompt
 * template. Returns numbers as numbers and strings as strings so the
 * record matches the shape Sandcastle's `promptArgs` accepts. Titles are
 * inlined (newlines collapsed, trimmed) to keep template substitution from
 * breaking the surrounding markdown.
 */
export function buildPrPromptArgs(
  input: BuildPrPromptArgsInput
): PrPromptArgsRecord {
  return {
    PARENT_ID: input.parentIdentifier,
    PARENT_TITLE: sanitizeInline(input.parentTitle),
    PARENT_URL: input.parentUrl,
    SOURCE_BRANCH: input.branch,
    TARGET_BRANCH: input.baseBranch,
    REPO_OWNER: input.repoOwner,
    REPO_NAME: input.repoName,
    SUB_ISSUES: renderSubIssues(input.subIssues),
  };
}

/**
 * Substitute every `{{KEY}}` placeholder in `template` with `args[KEY]`.
 * Single regex pass, so a substituted value containing literal `{{...}}`
 * sequences (e.g. an agent transcript echoing other placeholders) is not
 * re-substituted into a value of a later-iterated key.
 */
export function applyPromptTemplate(
  template: string,
  args: Record<string, string | number>
): string {
  return template.replace(
    /\{\{([A-Z_]+)\}\}/g,
    (match: string, key: string) => {
      const value = args[key];
      return value === undefined ? match : String(value);
    }
  );
}

interface PrListItem {
  url: string;
  number: number;
}

function parsePrList(stdout: string): PrListItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `tide: \`gh pr list\` produced non-JSON output: ${stdout.trim()}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`tide: \`gh pr list\` returned a non-array payload.`);
  }
  const out: PrListItem[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const url = obj.url;
    const number = obj.number;
    if (typeof url === "string" && typeof number === "number") {
      out.push({ url, number });
    }
  }
  return out;
}

/**
 * Fire a single Sandcastle iteration whose only job is to open the PR via
 * `gh pr create`, and verify the result by listing PRs for the branch on
 * the host. The branch is already on origin by the time this runs — the
 * runner pushes after every iteration per ADR-0007. Throws on iteration
 * error or empty post-iteration PR list.
 */
export async function runPrSubmission(
  options: RunPrSubmissionOptions
): Promise<PrSubmissionResult> {
  const {
    ghRepo,
    branch,
    baseBranch,
    parentIdentifier,
    parentTitle,
    parentUrl,
    subIssues,
    repoRoot,
    config,
    sandboxEnv,
    shellRunner = defaultShellRunner,
  } = options;
  const createSandboxFn = options.createSandbox ?? defaultCreateSandbox;

  // Step 1: fire the sandcastle iteration with the bundled, interface-
  // emphasizing prompt. Inline `prompt` (not `promptFile`) — the template
  // ships in tide source and is not user-editable. Uses the reusable-sandbox
  // pattern (`createSandbox` + `sandbox.run`) to match the runner's API.
  const promptArgs = buildPrPromptArgs({
    parentIdentifier,
    parentTitle,
    parentUrl,
    branch,
    baseBranch,
    repoOwner: ghRepo.owner,
    repoName: ghRepo.repo,
    subIssues,
  });
  const prompt = applyPromptTemplate(PR_PROMPT_TEMPLATE, promptArgs);

  // When tests inject `sandboxRun`, no real sandbox is created or closed.
  // Production callers omit it and we build a one-shot sandbox here.
  let sandbox: Sandbox | undefined;
  let sandboxRun: SandboxRunFn;
  if (options.sandboxRun !== undefined) {
    sandboxRun = options.sandboxRun;
  } else {
    sandbox = await createSandboxFn({
      branch,
      baseBranch,
      cwd: repoRoot,
      sandbox: docker({
        mounts: config.sandbox.mounts,
        env: sandboxEnv,
      }),
      hooks: {
        sandbox: {
          onSandboxReady: config.hooks.onSandboxReady,
        },
      },
    });
    sandboxRun = sandbox.run.bind(sandbox);
  }

  try {
    // The iteration produces no commit by design — its output is observable
    // via `gh pr list` below, not via the SandboxRunResult, so we discard
    // the result. Registering DONE_SIGNAL is informational: maxIterations=1
    // already caps the loop, but matching the runner's exit vocabulary
    // keeps the agent's prompt instructions consistent.
    await sandboxRun({
      name: "tide-pr",
      agent: claudeCode("claude-opus-4-7"),
      prompt,
      maxIterations: 1,
      logging: { type: "stdout" },
      completionSignal: [DONE_SIGNAL],
    } satisfies SandboxRunOptions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`tide: PR submission iteration threw: ${msg}`, {
      cause: err,
    });
  } finally {
    if (sandbox !== undefined) {
      await sandbox.close().catch(() => {
        /* swallow close errors — best-effort cleanup */
      });
    }
  }

  // Step 2: verify host-side that a PR now exists for the branch.
  const listResult = await shellRunner(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      `${ghRepo.owner}/${ghRepo.repo}`,
      "--head",
      branch,
      "--json",
      "number,url",
    ],
    repoRoot
  );
  if (listResult.exitCode !== 0) {
    const stderr = listResult.stderr.trim();
    throw new Error(
      `tide: \`gh pr list --head ${branch}\` failed (exit ${String(listResult.exitCode)})${stderr === "" ? "" : `: ${stderr}`}`
    );
  }

  const prs = parsePrList(listResult.stdout);
  const first = prs[0];
  if (first === undefined) {
    throw new Error(
      `tide: PR submission iteration completed but no PR was found on origin for branch ${branch}. Inspect the iteration log and re-run.`
    );
  }

  return { url: first.url, action: "opened" };
}
