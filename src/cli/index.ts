#!/usr/bin/env bun

import type { AppDependencies } from "../app-dependencies/index.ts";
import { runCli } from "./run-cli.ts";

/**
 * Production `bin` shim. Reads `process.argv`, constructs the real
 * `AppDependencies` (placeholder values until Phases 1-3 wire in
 * `LinearService`, `GhService`, and `SandcastleService`), invokes
 * `runCli`, and forwards the resolved exit code to `process.exit`.
 * Anything more than env reads + dependency construction belongs in
 * `runCli`, not here.
 */
const deps: AppDependencies = {
  linear: undefined,
  gh: undefined,
  sandcastle: undefined,
};

if (import.meta.main) {
  void runCli(process.argv.slice(2), deps).then((code) => {
    process.exit(code);
  });
}
