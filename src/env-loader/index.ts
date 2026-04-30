import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Universal env keys that every `.tide/.env` must define.
 *
 * `LINEAR_API_KEY` is consumed host-side by the CLI; `ANTHROPIC_API_KEY` is
 * forwarded into the docker sandbox. Every other key in `.tide/.env` is also
 * forwarded.
 */
export const REQUIRED_ENV_KEYS = [
  "LINEAR_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

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
  if (missing.length > 0) {
    throw new Error(
      `tide: ${envPath} is missing required key(s): ${missing.join(", ")}`
    );
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
