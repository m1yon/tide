import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Strictly-required env keys.
 *
 * `LINEAR_API_KEY` is consumed host-side by the CLI; every other key in
 * `.tide/.env` is forwarded into the docker sandbox.
 */
export const REQUIRED_ENV_KEYS = ["LINEAR_API_KEY"] as const;

/**
 * Auth credential for the in-sandbox `claude` CLI. At least one of these
 * must be set in `.tide/.env`. Both are valid; both are forwarded if both
 * are set, and the `claude` CLI picks.
 */
export const CLAUDE_AUTH_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/**
 * Keys that tide manages itself and the user must not set in `.tide/.env`.
 *
 * `GH_TOKEN` is fetched host-side from `gh auth token` and injected into the
 * sandbox by tide (see ADR 0003). Allowing the user to override it would
 * introduce a second source that drifts on rotation.
 */
export const FORBIDDEN_ENV_KEYS = ["GH_TOKEN"] as const;

export interface LoadEnvOptions {
  /** Repo root containing `.tide/.env`. */
  repoRoot: string;
}

/**
 * Parses `<repoRoot>/.tide/.env` into a `Record<string, string>`.
 *
 * Throws when:
 * - the file is missing
 * - any line is malformed (missing `=` or empty key)
 * - any of `REQUIRED_ENV_KEYS` is absent
 * - none of `CLAUDE_AUTH_KEYS` is set
 *
 * Repo-specific keys pass through unchanged.
 */
export function loadEnv(options: LoadEnvOptions): Record<string, string> {
  const envPath = join(options.repoRoot, ".tide", ".env");
  if (!existsSync(envPath)) {
    throw new Error(`tide: env file not found at ${envPath}`);
  }

  const raw = readFileSync(envPath, "utf8");
  const env = parseEnvText(raw, envPath);

  const missing = REQUIRED_ENV_KEYS.filter((k) => !(k in env));
  const hasAuth = CLAUDE_AUTH_KEYS.some((k) => k in env);
  const forbidden = FORBIDDEN_ENV_KEYS.filter((k) => k in env);

  const errors: string[] = [];
  if (missing.length > 0) {
    errors.push(
      `tide: ${envPath} is missing required key(s): ${missing.join(", ")}`
    );
  }
  if (!hasAuth) {
    errors.push(
      `tide: ${envPath} must define ${CLAUDE_AUTH_KEYS.join(" or ")}`
    );
  }
  for (const key of forbidden) {
    errors.push(
      `tide: ${envPath} sets ${key}; tide manages this — remove it from .tide/.env`
    );
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  return env;
}

/**
 * Pure parser for `.env` text. Exported for unit tests; surfaced as a
 * separate function so file I/O is not in the test path.
 *
 * Supported syntax:
 * - `KEY=value` lines
 * - blank lines
 * - `# comment` lines (full-line comments only)
 * - surrounding double or single quotes around the value (stripped, no escape processing)
 *
 * Anything else (a non-blank line without `=`, or a line whose key is empty)
 * throws with line-number context.
 */
export function parseEnvText(
  text: string,
  contextPath = "<env>"
): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();

    if (line === "") continue;
    if (line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) {
      throw new Error(
        `tide: malformed line ${String(i + 1)} in ${contextPath}: missing "=" (got: ${JSON.stringify(rawLine)})`
      );
    }
    const key = line.slice(0, eq).trim();
    if (key === "") {
      throw new Error(
        `tide: malformed line ${String(i + 1)} in ${contextPath}: empty key (got: ${JSON.stringify(rawLine)})`
      );
    }

    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }

    out[key] = value;
  }
  return out;
}
