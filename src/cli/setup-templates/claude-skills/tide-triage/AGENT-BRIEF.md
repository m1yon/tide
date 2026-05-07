# Agent brief — how to triage one issue

Use this as your reading order when you pick up a single issue from the `Triage` queue. The goal is one decision per issue, taken without asking the user any question that is answerable by reading the issue itself.

## Read in this order

1. **Title.** Often the title alone tells you which bucket this is. A vague "X is broken" with no repro is almost always `needs-info`. A precise "swap `lodash.merge` for the native spread in `src/foo/bar.ts`" is almost always `ready-for-agent`.
2. **Body.** Look for: a clear problem statement, a clear acceptance shape (what would "done" look like?), and concrete file/module references. The presence of all three usually means `ready-for-agent`. The absence of any one usually means `needs-info`.
3. **Comments.** A long comment thread on a `Triage`-state issue usually means the reporter and a maintainer have already been pinging back and forth — read the most recent comment first and let it tell you whether the issue has converged.
4. **Linked PRs.** A `Triage`-state issue with an attached merged PR is almost always `wontfix` (it's already done) or `needs-human` (cleanup/follow-up needed). A `Triage`-state issue with an open PR usually means the work is in flight and the issue is itself the PR's tracking artefact.

## Decide on these axes

- **Who's the next actor?** If it's the reporter (clarification, repro, more info) → `needs-info`. If it's an agent (specified, scoped, file-level) → `ready-for-agent`. If it's a human maintainer (ambiguous, design-shaped, security-shaped) → `ready-for-human`. If nobody (out of scope) → `wontfix`.
- **Is the scope one iteration?** If the issue would obviously decompose into several sub-issues, it is a PRD candidate, not a `ready-for-agent` candidate. Do _not_ promote it to `ready-for-agent` — instead, label it `needs-human` with a comment "this looks like a PRD; consider running `/tide-to-prd`" and let the human decide.
- **Is the title prefixed?** Every triaged issue must end up with a `[<repo>] ` title prefix (ADR-0012). If you decide on any non-`wontfix` outcome and the title is missing the prefix, prepend it before the label/state write.

## Don't ask the human if you can avoid it

The whole point of triage is to drain `Triage`-state items without forcing a human in the loop on every one. If the issue is genuinely ambiguous, your default is `needs-info` (with a specific question posted as a comment), not "stop and ask the user". Your job is the triage decision; the human's job is the next step on whichever branch you picked.

## When you do need to ask the user

Three exceptions:

- The issue references private context you don't have access to (a Slack thread, a customer escalation) and the decision genuinely depends on it.
- Multiple plausible decisions tie and the user has stated preference matters.
- You think the issue should be reshaped into a PRD; surface that as a question rather than auto-promoting.
