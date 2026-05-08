/**
 * Bundle of services tide depends on for any operation that crosses an
 * external boundary. Constructed exactly once — in `src/cli/index.ts` for
 * production runs, in the e2e harness's `buildTestDeps` factory for tests
 * — and threaded explicitly through `runCli(argv, deps)`. Per-phase
 * migrations replace each placeholder with a real service interface.
 *
 * Phase 1 (this slice) wires `linear: LinearService`. Phases 2-3 replace
 * each remaining `unknown` with a service interface (`SandcastleService`,
 * `GhService`).
 */

import type { LinearService } from "../services/linear/index.ts";

export interface AppDependencies {
  linear: LinearService;
  gh: unknown;
  sandcastle: unknown;
}
