import type { AppDependencies } from "../app-dependencies/index.ts";
import { build } from "./build.ts";
import { doctor } from "./doctor.ts";
import { tideRun } from "./run.ts";
import { setup } from "./setup.ts";

// VERSION is replaced at compile time via `bun build --compile --define`.
// When running uncompiled (`bun run src/cli/index.ts`), the substitution does
// not occur and we fall back to "dev".
declare const VERSION: string | undefined;
const version: string = typeof VERSION === "string" ? VERSION : "dev";

const HELP_TEXT = `tide — global CLI for Sandcastle-driven, Linear-rooted PRD runs

Usage:
  tide <command> [options]

Commands:
  run      Run the PRD-rooted, Linear-tracked agent flow for the current repo
  setup    Provision the sandcastle bridge, .tide/ scaffold, and Linear labels + workflow state
  doctor   Check that the local environment is ready to run tide
  build    Force-rebuild the docker image used by tide run

Options:
  --version    Print the tide version
  --help, -h   Print this help message

Run \`tide <command> --help\` for command-specific help (once subcommands ship).
`;

type Subcommand = "run" | "setup" | "doctor" | "build";

const SUBCOMMANDS: readonly Subcommand[] = ["run", "setup", "doctor", "build"];

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

function printHelp(): void {
  process.stdout.write(HELP_TEXT);
}

function printVersion(): void {
  process.stdout.write(`${version}\n`);
}

/**
 * Programmatic CLI entry. Owns argv parsing, command dispatch, and the
 * `Promise<number>` exit-code contract. The `bin` shim in `index.ts`
 * is responsible for reading `process.argv`, constructing the
 * production `AppDependencies`, calling this function, and forwarding
 * the resolved exit code to `process.exit`. Tests construct fake
 * services and call this function directly — no subprocess.
 *
 * The `argv` argument is the user-typed arguments only — i.e.
 * `process.argv.slice(2)` — not the full `process.argv`.
 *
 * `deps` is currently unused — Phase 0 introduces only the bundle's
 * shape. Subsequent phases thread `deps.linear`, `deps.gh`, and
 * `deps.sandcastle` into `tideRun` and the per-command entry points.
 */
export async function runCli(
  argv: readonly string[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  deps: AppDependencies
): Promise<number> {
  if (argv.length === 0) {
    printHelp();
    return 0;
  }

  const first = argv[0];
  if (first === undefined) {
    printHelp();
    return 0;
  }

  if (first === "--version" || first === "-v") {
    printVersion();
    return 0;
  }

  if (first === "--help" || first === "-h") {
    printHelp();
    return 0;
  }

  if (isSubcommand(first)) {
    if (first === "setup") {
      return await setup();
    }
    if (first === "doctor") {
      return await doctor();
    }
    if (first === "build") {
      return await build();
    }
    return await tideRun();
  }

  process.stderr.write(`tide: unknown command "${first}"\n\n`);
  process.stderr.write(HELP_TEXT);
  return 1;
}
