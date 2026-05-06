You are working on Linear sub-issue {{ISSUE_ID}} in the parent PRD {{PARENT_ID}}.

Branch: {{SOURCE_BRANCH}} (PR will merge into {{TARGET_BRANCH}})

## Parent PRD

{{PRD_CONTENT}}

## Sub-issue: {{ISSUE_TITLE}}

{{ISSUE_CONTENT}}

## CONTEXT

Recent commits on this feature branch (since it diverged from `{{TARGET_BRANCH}}`):

<recent-commits>

!`git log {{TARGET_BRANCH}}..HEAD --oneline`

</recent-commits>

## Instructions

1. **Explore** — Explore the repo and fill your context window with relevant information that will allow you to complete the task. Pay extra attention to test files that touch the relevant parts of the code.
2. **Plan** — smallest viable change.
3. **Execute** — solve the sub-issue above. If applicable, use RGR to complete the task:
   1. RED: write one test
   2. GREEN: write the implementation to pass that test
   3. REPEAT until done
   4. REFACTOR the code
4. **Verify** — run the project's test suite. If any test fails, fix it before committing. If a failure is unrelated/unfixable, emit `<promise>BLOCKED</promise>` (see "Ending the iteration").
5. **Commit** — single commit. Ensure any configured pre-commit hooks (lint, format, etc.) ran successfully; if they didn't fire, run the project's setup command and retry. If still not firing, emit `<promise>BLOCKED</promise>`. The commit message MUST:
   1. Start with `ref {{ISSUE_ID}}` (Linear's non-closing magic word — surfaces the commit on the sub-issue's timeline without forcing a state transition)
   2. Summarise what was done in one short line
   3. Be concise. The host will transition the sub-issue to _Done_ when you emit DONE.

## Rules

- Work on **only** this sub-issue ({{ISSUE_ID}}). Do not pick up sibling sub-issues, even if you spot related work.
- Every commit on this branch is prefixed with `ref {{ISSUE_ID}}`. The host (tide), not you, transitions the sub-issue's Linear state.
- Do not leave commented-out code or TODO comments in committed code.
- Do **not** call `gh issue close`, `linear` CLI commands, or any other state-mutating Linear/GitHub command. The host owns those writes.
- If you are blocked (missing context, failing tests you cannot fix, external dependency), emit `<promise>BLOCKED</promise>` instead of DONE.

# Ending the iteration

Emit one of two signals on the very last line of your response, exactly:

- `<promise>DONE</promise>` — sub-issue is fully implemented and committed. The host will transition it to _Done_ in Linear.
- `<promise>BLOCKED</promise>` — you are gracefully stuck (missing context, failing tests you cannot fix, external dependency, etc.). Explain what's blocking you in your final message; the host will summarise and flag the sub-issue for human review. Do **not** emit DONE on a partial or speculative completion.
