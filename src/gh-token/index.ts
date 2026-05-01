import { spawn } from "node:child_process";

export interface GetGhTokenOptions {
  /** Repo root used as `cwd` for the `gh` invocation. */
  repoRoot: string;
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

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

const AUTH_HINT =
  "Run `gh auth login` (or `gh auth refresh`) on the host and retry.";

/**
 * Shells out to `gh auth token --hostname github.com`, returns the trimmed
 * token. Throws on non-zero exit or empty stdout, with a hint pointing at
 * `gh auth login`.
 *
 * Hostname is pinned to github.com to match the rest of tide's implicit
 * github.com assumption (Linear URL builder, gh-identity error messaging).
 */
export async function getGhToken(
  options: GetGhTokenOptions,
  runner: Runner = defaultRunner
): Promise<string> {
  const result = await runner(
    "gh",
    ["auth", "token", "--hostname", "github.com"],
    options.repoRoot
  );
  if (result.exitCode !== 0) {
    const stderrTrimmed = result.stderr.trim();
    throw new Error(
      `tide: \`gh auth token\` failed (exit ${String(result.exitCode)})${stderrTrimmed === "" ? "" : `: ${stderrTrimmed}`}. ${AUTH_HINT}`
    );
  }

  const token = result.stdout.trim();
  if (token === "") {
    throw new Error(
      `tide: \`gh auth token\` returned empty stdout. ${AUTH_HINT}`
    );
  }

  return token;
}
