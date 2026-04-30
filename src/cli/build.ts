import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultImageName } from "@ai-hero/sandcastle/sandboxes/docker";
import { loadConfig } from "../config-loader/index.ts";
import { discoverRepoRoot } from "../repo-discovery/index.ts";

/**
 * Streams a child process's stdout/stderr through to the supplied sinks
 * and resolves with the exit code. Used by `tide build` so the docker
 * build's progress is visible while it runs.
 */
export type StreamingRunner = (
  cmd: string,
  args: readonly string[],
  options: {
    cwd: string;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
  }
) => Promise<number>;

const defaultRunner: StreamingRunner = (cmd, args, options) =>
  new Promise<number>((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      options.onStdout(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      options.onStderr(chunk.toString("utf8"));
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      resolvePromise(code ?? 0);
    });
  });

export interface BuildOptions {
  /** Repo root override (defaults to repo-discovery from cwd). */
  repoRoot?: string;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  /** Process runner. Tests stub this to avoid spawning docker. */
  runner?: StreamingRunner;
}

/**
 * Force-rebuilds the docker image used by `tide run`.
 *
 * Discovers the repo root, asserts `<repoRoot>/.tide/Dockerfile` exists,
 * sanity-checks `<repoRoot>/.tide/config.ts` parses, then shells out to
 * `docker build -t <defaultImageName(repoRoot)> -f <abs-dockerfile> <repoRoot>`.
 * The build context is the repo root so any path under the repo is COPYable.
 *
 * Returns 0 on success, non-zero on the first failure encountered. Docker's
 * stdout/stderr are forwarded so the user sees progress and any error stream.
 */
export async function build(options: BuildOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = options.stderr ?? ((s: string) => process.stderr.write(s));
  const runner = options.runner ?? defaultRunner;

  let repoRoot: string;
  try {
    repoRoot = options.repoRoot ?? discoverRepoRoot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`${msg}\n`);
    return 1;
  }

  const dockerfilePath = join(repoRoot, ".tide", "Dockerfile");
  if (!existsSync(dockerfilePath)) {
    stderr(`tide build: Dockerfile not found at ${dockerfilePath}\n`);
    return 1;
  }

  // Sanity-check the config parses; no field is consumed by `tide build`
  // directly, but a malformed config is a setup error worth catching here
  // rather than later in `tide run`.
  try {
    await loadConfig({ repoRoot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`tide build: ${msg}\n`);
    return 1;
  }

  const imageName = defaultImageName(repoRoot);
  const absoluteDockerfile = resolve(dockerfilePath);

  stdout(`tide build: building ${imageName} from ${absoluteDockerfile}\n`);

  const exitCode = await runner(
    "docker",
    ["build", "-t", imageName, "-f", absoluteDockerfile, repoRoot],
    {
      cwd: repoRoot,
      onStdout: stdout,
      onStderr: stderr,
    }
  );

  if (exitCode !== 0) {
    stderr(`tide build: docker build failed (exit ${String(exitCode)})\n`);
    return exitCode;
  }

  stdout(`tide build: built ${imageName}\n`);
  return 0;
}
