/**
 * Bundle of services tide depends on for any operation that crosses an
 * external boundary. Constructed exactly once — in `src/cli/index.ts` for
 * production runs, in the e2e harness's `buildTestDeps` factory for tests
 * — and threaded explicitly through `runCli(argv, deps)`. Per-phase
 * migrations replace each placeholder with a real service interface.
 *
 * Phase 0 (this slice) introduces only the bundle's shape. The three
 * fields are typed `unknown` to make accidental dereferencing a type
 * error and to signal that no production code may touch them yet.
 * Phases 1-3 replace each `unknown` with a service interface
 * (`LinearService`, `SandcastleService`, `GhService`).
 */
export interface AppDependencies {
  linear: unknown;
  gh: unknown;
  sandcastle: unknown;
}
