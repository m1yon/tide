# PR title as `[<linear-id>] <root-title>`, host-rendered

The PR opened by `runPrSubmission` carries the title `[<linear-id>] <root-title>`, where `<linear-id>` is the root **PRD** or **Standalone Issue** identifier and `<root-title>` is that root's Linear title with the leading **Repo prefix** stripped. The string is computed host-side from values already on `RunPrSubmissionOptions` and threaded into the PR-submission prompt as a single `{{PR_TITLE}}` placeholder. The agent runs `gh pr create --title "{{PR_TITLE}}"` verbatim and has no judgment to apply on the title.

This replaces the previous prompt-driven Conventional Commits title (`<type>(<scope>): <subject>`).

## Considered

- **Conventional Commits, agent-rendered (status quo).** Rejected. Two costs and no real benefit. (1) Repo has no commitlint, no release-please, no semantic-release — CC compliance was aspirational and unenforced, so there was nothing downstream that depended on the type/scope/subject shape. (2) Agent-rendered titles drift across runs (different scope choices, paraphrased subjects) for no observable upside, while a deterministic title is trivially testable as a pure function. The only thing CC bought was a habit; the habit was not load-bearing.

- **Bare `<linear-id> <root-title>` (no brackets).** Rejected. The bracketed form gives a strong, scannable visual signal in GitHub's PR list, Slack preview text, and `git log --oneline` after squash. Without brackets the identifier blends into prose; with brackets a reviewer pattern-matches "Linear ticket" instantly. The bracket idiom also already lives in this codebase via the **Repo prefix** on Linear titles, so the shape is familiar.

- **`<linear-id>: <root-title>`.** Rejected. Same scannability concern as bare form, plus a colon ambiguity — an awkward double-colon if the root title itself starts with a colon-bearing fragment.

- **`<linear-id>` as the Conventional Commits scope, e.g. `feat(PER-76): <subject>`.** Rejected. The issue framing is "prefix to the **beginning** of PR title", which CC-scope syntax doesn't satisfy — the type token comes first. Also doubles the cognitive load of every title (the scope slot is now overloaded with two semantics: package and Linear ticket).

- **Keep agent rendering, just constrain the format in the prompt.** Rejected. Once the title is fully determined by host-side values, every byte of model latitude is risk without reward. Pure-function `buildPrTitle({rootIdentifier, rootTitle, repoName}) → string` is cheap, deterministic, and unit-testable; an agent rendering the same string is none of those.

- **Carry the leading `[<repo>] ` **Repo prefix** through into the PR title.** Rejected. The **Repo prefix** exists to disambiguate which repo's queue a Linear issue belongs to (ADR-0012). In a GitHub PR title that disambiguation is already done by the surrounding repo context, so `[tide] [PER-76] <title>` is purely redundant noise. Stripping the **Repo prefix** before composing `{{PR_TITLE}}` keeps the PR title focused on the Linear identifier, which is the prefix that does carry information at the GitHub layer.

## Consequences

`buildPrPromptArgs` (`src/pr-submission/index.ts`) gains a `PR_TITLE` key alongside the existing `ROOT_*`, `*_BRANCH`, and `REPO_*` keys. The computation is a small pure helper (`buildPrTitle` or inlined) that:

1. Trims and collapses whitespace in `rootTitle` (matches the existing `sanitizeInline` treatment).
2. Strips a leading `[<repoName>] ` prefix if present (idempotent — never double-strips, never over-strips a different bracketed prefix).
3. Returns `[<rootIdentifier>] <stripped-and-sanitized-root-title>`.

The `# Title` section in `PR_PROMPT_TEMPLATE` collapses from a multi-paragraph Conventional Commits rule down to one line: `Use this exact title: {{PR_TITLE}}`. The example `gh pr create` snippet at the bottom of the template substitutes `{{PR_TITLE}}` into the `--title` value so the agent does not have to recompose it. Single-quoted form in the example to keep embedded apostrophes from breaking the snippet; the agent shell-escapes at runtime.

This decision pairs with **Commit reference** (ADR-0006): per-commit `ref <linear-id>` prefixes thread individual commits to the **Sub-issue** timeline in Linear, but those prefixes are discarded by GitHub's squash-merge. The PR title is the only Linear-identifier carrier that survives a squash into `master`, so the title shape now does double duty — human-scannable on the PR, and the entire `git log` linkage on the merged commit. Linear's GitHub integration is unaffected: the branch name remains the sole PR↔PRD link per ADR-0006, and the title's identifier is informational only (Linear would auto-detect it either way, but the integration does not need it to).

Migration: the change is unobservable on existing PRs (already opened with the old format). New PRs from the next `tide run` onward use the new format. No backfill, no flag.
