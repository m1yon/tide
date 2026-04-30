import { spawn } from "node:child_process";

export interface GhIdentity {
  owner: string;
  repo: string;
}

export interface GetGhIdentityOptions {
  /** Repo root used as `cwd` for the `gh` invocation. */
  repoRoot: string;
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a child process, capturing stdout and stderr.
 *
 * Exposed via the `runner` parameter on `getGhIdentity` so tests can stub it.
 */
async function defaultRunner(
  cmd: string,
  args: readonly string[],
  cwd: string
): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve, reject) => {
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

export type Runner = (
  cmd: string,
  args: readonly string[],
  cwd: string
) => Promise<ExecResult>;

/**
 * Shells out to `gh repo view --json owner,name`, parses the JSON, and
 * returns `{ owner, repo }`. Throws when `gh` exits non-zero or the JSON
 * does not match the expected shape.
 *
 * Inferred-not-configured: we never accept owner/repo from config; the
 * git remote (via `gh`) is the source of truth.
 */
export async function getGhIdentity(
  options: GetGhIdentityOptions,
  runner: Runner = defaultRunner
): Promise<GhIdentity> {
  const result = await runner(
    "gh",
    ["repo", "view", "--json", "owner,name"],
    options.repoRoot
  );
  if (result.exitCode !== 0) {
    const stderrTrimmed = result.stderr.trim();
    throw new Error(
      `tide: \`gh repo view\` failed (exit ${String(result.exitCode)})${stderrTrimmed === "" ? "" : `: ${stderrTrimmed}`}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `tide: \`gh repo view\` produced non-JSON output: ${result.stdout.trim()}`
    );
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`tide: \`gh repo view\` returned a non-object payload`);
  }
  const obj = parsed as Record<string, unknown>;

  const ownerField: unknown = obj.owner;
  const nameField: unknown = obj.name;

  let owner: string;
  if (typeof ownerField === "string") {
    owner = ownerField;
  } else if (
    ownerField !== null &&
    typeof ownerField === "object" &&
    "login" in ownerField &&
    typeof (ownerField as Record<"login", unknown>).login === "string"
  ) {
    owner = (ownerField as Record<"login", string>).login;
  } else {
    throw new Error(
      `tide: \`gh repo view\` payload missing owner. Is the remote on github.com?`
    );
  }

  if (typeof nameField !== "string") {
    throw new Error(
      `tide: \`gh repo view\` payload missing name. Is the remote on github.com?`
    );
  }

  return { owner, repo: nameField };
}
