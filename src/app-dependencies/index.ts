/**
 * Bundle of services tide depends on for any operation that crosses an
 * external boundary. Constructed exactly once — in `src/cli/index.ts` for
 * production runs, in the e2e harness's `buildTestDeps` factory for tests
 * — and threaded explicitly through `runCli(argv, deps)`. Per-phase
 * migrations replace each placeholder with a real service interface.
 *
 * Phase 1 (PER-91) wired `linear: LinearService`. Phase 2 (PER-92) wires
 * `sandcastle: SandcastleService`. Phase 3 will replace the remaining
 * `unknown` with `gh: GhService`.
 */

import type { LinearService } from "../services/linear/index.ts";
import type { SandcastleService } from "../services/sandcastle/index.ts";

export interface AppDependencies {
  linear: LinearService;
  sandcastle: SandcastleService;
  gh: unknown;
}
