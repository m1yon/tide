You are working on GitHub issue {{ISSUE_ID}} in the parent PRD {{PARENT_ID}}.

Branch: {{BRANCH}}

## Parent PRD

{{PRD_CONTENT}}

## Issue: {{ISSUE_TITLE}}

{{ISSUE_CONTENT}}

## CONTEXT

Here are the last 10 RALPH commits:

<recent-commits>

!`git log --oneline --grep="RALPH" -10`

</recent-commits>

## Instructions

1. **Explore** — Explore the repo and fill your context window with relevant information that will allow you to complete the task. Pay extra attention to test files that touch the relevant parts of the code.
2. **Plan** — smallest viable change.
3. **Execute** — solve the issue above. If applicable, use RGR to complete the task:
   1. RED: write one test
   2. GREEN: write the implementation to pass that test
   3. REPEAT until done
   4. REFACTOR the code
4. **Verify** — run the project's test suite. If any test fails, fix it before committing. If a failure is unrelated/unfixable, comment on the issue and stop (don't close).
5. **Commit** — single commit. Ensure any configured pre-commit hooks (lint, format, etc.) ran successfully; if they didn't fire, run the project's setup command and retry. If still not firing, comment on the issue flagging the user and stop (don't close). Commit message MUST:
   1. Start with `RALPH:` prefix
   2. Include task completed + PRD reference
   3. Include key decisions made
   4. Include files changed
   5. Include blockers or notes for next iteration
   6. Be concise.
6. **Close** — close the issue with a comment explaining what was done.

## Rules

- Work on **only** this sub-issue (#{{ISSUE_ID}}). Do not pick up sibling issues, even if you spot related work.
- Do not close the issue until you have committed the fix.
- Do not leave commented-out code or TODO comments in committed code.
- If you are blocked (missing context, failing tests you cannot fix, external dependency), leave a comment on the issue and stop — do not close it.

# Ending the iteration

Emit `<promise>COMPLETE</promise>` when this sub-issue is fully done (committed and closed). The runner will then move on to the next sub-issue in dependency order.
