#!/usr/bin/env bun

import type { AppDependencies } from "../app-dependencies/index.ts";
import { InMemoryLinearService } from "../services/linear/index.ts";
import { SandcastleSdkService } from "../services/sandcastle/index.ts";
import { runCli } from "./run-cli.ts";

/**
 * Production `bin` shim. Reads `process.argv`, constructs the real
 * `AppDependencies`, invokes `runCli`, and forwards the resolved exit
 * code to `process.exit`. Anything more than env reads + dependency
 * construction belongs in `runCli`, not here.
 *
 * The Linear service is currently a placeholder fake at the bin level —
 * each command constructs its own `LinearSdkService` inline from
 * `<repoRoot>/.tide/.env` and `<repoRoot>/.tide/config.ts`. Phase 5
 * hoists construction into this shim once the e2e harness is in place;
 * until then, `deps.linear` is a no-op stand-in to satisfy the typed
 * shape of `AppDependencies`. Sandcastle is constructed here — the SDK
 * service composes sandcastle's `run`, `createWorktree`, and the
 * transcript-extract reader; constructor takes no arguments and the
 * resulting instance is stateless across commands. Gh remains a
 * placeholder `unknown` value until Phase 3.
 */
const deps: AppDependencies = {
  linear: new InMemoryLinearService(),
  sandcastle: new SandcastleSdkService(),
  gh: undefined,
};

if (import.meta.main) {
  void runCli(process.argv.slice(2), deps).then((code) => {
    process.exit(code);
  });
}
