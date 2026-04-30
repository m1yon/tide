#!/usr/bin/env bun

import { build } from "./build.ts";
import { doctor } from "./doctor.ts";
import { init } from "./init.ts";

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
  init     Scaffold a minimal .tide/ directory in the current repo
  doctor   Check that the local environment is ready to run tide
  build    Force-rebuild the docker image used by tide run

Options:
  --version    Print the tide version
  --help, -h   Print this help message

Run \`tide <command> --help\` for command-specific help (once subcommands ship).
`;

type Subcommand = "run" | "init" | "doctor" | "build";

const SUBCOMMANDS: readonly Subcommand[] = ["run", "init", "doctor", "build"];

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

function printHelp(): void {
  process.stdout.write(HELP_TEXT);
}

function printVersion(): void {
  process.stdout.write(`${version}\n`);
}

function notImplemented(name: Subcommand): never {
  process.stderr.write(`tide ${name}: not yet implemented\n`);
  process.exit(1);
}

export function run(argv: readonly string[]): number | Promise<number> {
  const args = argv.slice(2);

  if (args.length === 0) {
    printHelp();
    return 0;
  }

  const first = args[0];
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
    if (first === "init") {
      return init();
    }
    if (first === "doctor") {
      return doctor();
    }
    if (first === "build") {
      return build();
    }
    notImplemented(first);
  }

  process.stderr.write(`tide: unknown command "${first}"\n\n`);
  process.stderr.write(HELP_TEXT);
  return 1;
}

if (import.meta.main) {
  const result = run(process.argv);
  if (typeof result === "number") {
    process.exit(result);
  } else {
    void result.then((code) => {
      process.exit(code);
    });
  }
}
