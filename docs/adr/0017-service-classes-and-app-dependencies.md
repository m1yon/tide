# Service classes and `AppDependencies` for testing

> Status: **establishes the codebase-wide testing architecture** referenced by `CLAUDE.md`'s "Avoid mocks and stubs … prefer real dependencies, in-memory fakes, or thin hand-written test doubles at module boundaries" rule. Supersedes the de-facto "per-function `?` test seam" pattern that grew across `src/runner/index.ts`, `src/cli/run.ts`, `src/cli/setup.ts`, `src/linear/index.ts`, `src/pr-submission/index.ts`, `src/pr-target/index.ts`, and `src/branch-override/index.ts`. No prior ADR formalised that pattern; this one replaces it.

The seam between tide's logic and every external system (Linear, the `gh` CLI, sandcastle/Docker, clack prompts) is now **one TypeScript `interface` per external system, implemented by two classes — a real one composing the third-party SDK or CLI, and an in-memory fake**. The four services bundle into a single `AppDependencies` value constructed once at the CLI's `bin` entry and threaded explicitly into `runCli(argv, deps)`. Tests construct an `AppDependencies` of fakes and call `runCli` directly. Production tests of pure-logic modules (`queue-build`, `dep-graph`, `prompt-args`, `transcript-extract`, `summarizer-prompts`, `template-writer`) keep their existing focused module-level tests — they own no I/O and need no fakes.

The pre-existing pattern was per-function dependency injection: every orchestration function exposed a bag of optional fields on its public options interface (`fetchIssueContent?`, `transitionToInProgress?`, `flipLabelToReadyForHuman?`, `sandcastleRun?`, `readFinalAssistantMessage?`, `shellRunner?`, `confirmRunQueue?`, `confirmCreatePr?`, `branchOverridePrompt?`, …), each defaulting to a real implementation. `RunIssueQueueOptions` carried 9 such seams; the options consumed by `cli/run.ts`'s post-pick orchestration carried 16. Test files (`runner/runner.test.ts`, 1996 lines; `cli/run.test.ts`, 3988 lines; `linear/index.test.ts`, 1762 lines) hand-wrote stub functions per call and threaded them in. The cost: every call-site advertised its test affordances in JSDoc on the production contract, and adding a new external dependency required adding optional seams to every layer that crossed the boundary. The bloat the user objected to was real — ~12,300 lines of test code against ~6,350 lines of production code, with the test-seam fields visible to anyone reading the production interfaces.

## Considered

- **Status quo: keep per-function `?` test seams.** Rejected. The pattern conflates two concerns — "what this function depends on" (the real arguments) and "where the test plugs in" (the optional seam). The conflation lands in JSDoc on every public interface and grows linearly with the number of external operations. With four external systems and ~30 distinct operations across them, the seam fields on orchestration options interfaces had become the dominant noise in the contract.

- **Single-class services without a TypeScript `interface` (rely on structural typing).** Rejected. A production-only class plus a fake duck-typed against it sounds compact, but the "implements" relationship is implicit: adding a method to the production class without updating the fake fails only at the test call-site, not at the fake's declaration. The interface costs three named entities (`LinearService`, `LinearSdkService`, `InMemoryLinearService`) but pays for itself the first time a method is added — the compiler reports the missing method on the fake's class declaration, not buried inside a test. The user's Go background is the deciding context: explicit interface + multiple impls is the idiom they expect.

- **Inheritance between the real service and the fake (e.g. a shared `BaseLinearService` with abstract I/O methods).** Rejected. Inheritance forces the fake and the real impl to share a code shape, which is exactly the wrong thing — they diverge in I/O strategy and converge only in domain shape. Composition (each class holds its own dependencies as fields, shares helper _functions_ when needed) keeps the two implementations decoupled. The codebase rule going forward is `implements` only — never `extends` between service classes.

- **Object-with-function-fields services (e.g. `const linearGateway = { fetchIssueContent: () => ..., transitionToDone: () => ..., ... }`).** Rejected. Function-field objects re-create the per-function-seam pattern at one level of indirection — each method is independently swappable, and the "instance" never owns its `(apiKey, teamKey, repoName)` state. Class instances let construction happen once at boot and method calls assume the encapsulated state is in place. The user explicitly named single-shot construction as the goal.

- **Per-command "accept interfaces" narrowing (each command typed with `Pick<AppDependencies, "linear" | "gh">` etc.).** Rejected. "Accept interfaces, return structs" is Go advice for _exported library surfaces_; for _internal dispatch within one application_, narrowing the type at every call-site is busywork that makes adding a new dependency a multi-file edit. The whole `AppDependencies` bundle is threaded through the orchestration layer; commands take what they need from it inline.

- **Subprocess-based e2e harness (spawn `bun src/cli/index.ts ...` with fakes injected via env vars or a `TIDE_TEST_MODE=1` switch).** Rejected. The fake-selection logic would have to live in production code, exactly the smell — production paths that exist only for tests. Subprocess boot also adds startup overhead per test (hundreds of ms) and makes failure traces harder to follow. A programmatic `runCli(argv, deps)` entry with a thin `bin` shim above it gets the same coverage with no production-side concession; the shim itself is small enough that its argv/exit-code behaviour can be covered by one focused test on the shim alone.

- **Big-bang migration (introduce all four services and delete all `?` seams in one PR).** Rejected. The change touches every orchestration file. Phasing per external system keeps each PR mechanically reviewable and lets the codebase ship green between phases.

- **Soft cutover per service (introduce a `LinearService` while keeping the per-function `?` seams in callers, deprecate gradually).** Rejected. Two parallel seams on the same external system is the worst-of-both-worlds case — public contracts get _bigger_ during the transition. Hard cutover per service is cleaner: in the same PR that introduces `LinearService`, all Linear-related `?` fields disappear from callers' option interfaces.

- **Smallest-service-first phasing (start with `PromptService`, with its 5 clack-prompt seams, to validate the pattern at low risk).** Considered seriously. Rejected in favour of starting with `LinearService` because the pattern is fully sketched (the Q2 / Q3 grilling produced the complete `LinearService` shape) and the LOC reduction from migrating Linear first is large enough — the 1,762-line `linear/index.test.ts` and 9 seam fields across 5 files — that delaying it costs more than starting elsewhere saves. The risk argument cuts both ways: if the pattern is wrong, we'd rather find out on the largest migration than commit to it across three smaller ones first.

- **Domain-language naming for the role: `Gateway` (DDD), `Adapter` (hex), `Repository` (less apt — these are not aggregate stores), `Port`.** Rejected. The user picked `Service`; everything else is jargon-loaded with implications ("Gateway" suggests a single network endpoint; "Adapter" suggests a strict shape translation; "Port" suggests an architectural style this codebase doesn't otherwise commit to). `Service` is plain English and reads as "the thing that talks to <X>".

## Consequences

Four services land in tide. Each has the same shape:

- **Interface.** `LinearService`, `GhService`, `SandcastleService`, `PromptService`. Methods take only domain-shaped arguments and return only domain-shaped values. No `LinearContext`, no raw `RunOptions` from sandcastle, no `ShellResult` exit codes — those translate inside the real implementation.
- **Real class.** `LinearSdkService`, `GhCliService`, `SandcastleService` (the real one shares the base name; the third-party module is composed inside it), `ClackPromptService`. Each composes the third-party SDK or CLI in its constructor — no inheritance from the SDK's classes, no inheritance shared between services. Per-instance state (API key, team key, repo name) is a constructor argument and lives as a `private readonly` field.
- **In-memory fake class.** `InMemoryLinearService`, `InMemoryGhService`, `InMemorySandcastleService`, `ScriptedPromptService` (named for its scripted-answer semantics). Each implements the same interface and adds _additional_ observation methods — `transitionsOf(issueId)`, `commentsOn(issueId)`, `prsCreated()`, `iterationsRun()`, etc. — that are NOT on the interface. Tests reference the concrete fake type when asserting; production code references the interface only.

The four services bundle:

```ts
export interface AppDependencies {
  linear: LinearService;
  gh: GhService;
  sandcastle: SandcastleService;
  prompts: PromptService;
}
```

`AppDependencies` is constructed exactly once. In production, `src/cli/index.ts` instantiates the four real classes from `process.env` and `tide.config.ts`, builds the bundle, and calls `runCli(process.argv.slice(2), deps)`. In tests, the e2e harness constructs the four in-memory fakes, builds the bundle, and calls `runCli([...], deps)` directly — no subprocess, no Bun cold-start, no env-var dance.

The split between `bin` shim and `runCli` is pragmatic: `src/cli/index.ts` becomes ~30 lines (env reads, real-service construction, `runCli` call, `process.exit(code)`); the dispatch logic — argv parsing, command routing, error rendering — moves into `src/cli/run-cli.ts` as `runCli(argv, deps)`. The shim has a small focused test of its own; everything else is exercised through `runCli`.

The phased rollout is six PRs:

1. **Phase 0 — harness skeleton.** `AppDependencies` placeholder type with `unknown` fields; `runCli` shim; `withTempRepo(async (repoRoot) => ...)` helper that runs `git init` + first commit in a temp directory; `cli/index.ts` boot. Existing `?` seams untouched. No tests change.
2. **Phase 1 — `LinearService`.** Interface + `LinearSdkService` + `InMemoryLinearService` land. All Linear `?` seams (`fetchIssueContent?`, `fetchSubIssues?`, `transitionTo*?`, `flipLabelToReadyForHuman?`, `postComment?`, `assertInReviewStatePresent?`, `setupLabels?`, `provisionInReviewState?`) disappear from `RunIssueQueueOptions`, the `cli/run.ts` post-pick options, `cli/setup.ts`, `cli/doctor.ts`. `LinearContext` exits the public surface — encapsulated inside `LinearSdkService`. `linear/index.test.ts` shrinks to a focused SDK-translation suite (~300 lines target). `runner.test.ts` and `run.test.ts` keep their structure but their hand-written Linear stubs become `new InMemoryLinearService(...)`.
3. **Phase 2 — `SandcastleService`.** `sandcastleRun?`, `createWorktree?`, `readFinalAssistantMessage?` removed. The fake is a scripted-result queue: tests pre-load `RunResult`s in iteration order, the fake hands them out per `run()` call.
4. **Phase 3 — `GhService`.** `gh`-targeting `ShellRunner?`, `countCommitsAhead?` removed. The fake holds an in-memory PR registry.
5. **Phase 4 — `PromptService`.** Five clack-prompt seams (`confirmRunQueue?`, `confirmCreatePr?`, `branchOverridePrompt?`, `prTargetPrompt?`, `confirmBranchSwitch?`) removed. The fake answers from a pre-loaded scripted-answer map keyed by prompt ID.
6. **Phase 5 — first real e2e tests.** `cli/run.e2e.test.ts` lands with: happy-path PRD with two sub-issues, BLOCKED path, agent-FAIL path, infra abort, queue rebuild absorbing a mid-run sub-issue, branch override, PR target prompt. Each scenario ~30–60 lines.
7. **Phase 6 — orchestration test cleanup.** With e2e coverage, `runner/runner.test.ts` and `cli/run.test.ts` get audited. Anything covered by e2e is deleted; anything testing internal dispatch with no orchestration value is deleted; anything testing pure logic that e2e doesn't reach (rare) stays as a focused module test. Realistic outcome: those two files together drop from ~6,000 LOC to <500 LOC.

Across the rollout, the 4-PR window between Phase 0 and Phase 5 has no e2e coverage — only the migrated module tests. This is acceptable because each phase is a mechanical refactor of seams (test-coverage-preserving by construction): the same scenarios are tested before and after the migration, just with a single fake instead of multiple stubs. The risk is concentrated at Phase 1 (Linear, biggest blast radius); Phases 2–4 follow the established pattern.

The pure-logic modules — `queue-build`, `dep-graph`, `prompt-args`, `transcript-extract`, `summarizer-prompts`, `template-writer`, plus the pure functions remaining in `linear/` (`pickWorkflowStateByType`, `pickWorkflowStateByName`, `repoTitlePrefix`) — keep their existing focused tests. They have no I/O, no service dependency, no DI bloat to remove. Tests of non-exported helpers within those modules are not introduced; helper coverage rides on the exported function's tests.

`CONTEXT.md` is **not** updated by this ADR. The terms introduced (`LinearService`, `AppDependencies`, etc.) are implementation vocabulary, not domain language; per the project's domain-docs rule, the glossary stays implementation-free. Future ADRs that change service shape (adding a fifth external system, changing the fake-construction shape) supersede this one in the relevant section rather than amending in place.

Migration is zero on disk for users of tide — no config changes, no `.tide/` shape changes, no behaviour change at the CLI surface. The whole rollout is internal restructuring.
