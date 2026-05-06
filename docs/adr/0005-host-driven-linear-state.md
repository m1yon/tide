# Host-driven Linear state transitions

> Status: **partially superseded by ADR-0009** for parent (**PRD** / **Standalone Issue**) end-state handling. Linear writes are still host-driven, but the parent's terminal host-side transition is now to _In Review_ post-PR-submission, not directly to _Done_. **Sub-issue** handling under this ADR — DONE → _Done_ host-side per iteration — is unchanged.

Every Linear write tide makes — workflow-state transitions, label flips, comments — is issued by the tide host process, not by the agent inside the sandbox. The sandbox stays Linear-blind: `LINEAR_API_KEY` is host-only and is not forwarded into the docker environment, in contrast with `GH_TOKEN` (per ADR-0003) which the agent does need for branch and PR work.

## Considered

- **Agent-driven transitions.** Mirror today's pattern of `gh issue close` from inside the sandbox: inject `LINEAR_API_KEY` and let the agent's iteration prompt instruct it to transition state on its own way out. Rejected: state transitions are tide's bookkeeping, not the agent's domain. The agent's contract is "make the change"; observing the verdict and updating the tracker is the orchestrator's. Agent-driven transitions also force every prompt to remember the call (a recurring failure mode in the GitHub-issue-close flow), and they widen the credential surface inside the sandbox for no offsetting benefit.
- **Single binary signal, infer rest from commits.** Keep the existing `<promise>COMPLETE</promise>` and have tide infer DONE vs BLOCKED from commit presence. Rejected: "no commits + COMPLETE" is genuinely ambiguous between "cleanly nothing to do" and "blocked, gave up" — and tide is now the one transitioning state on the basis of the difference.

## Consequences

The agent's exit vocabulary is two explicit signals: `<promise>DONE</promise>` and `<promise>BLOCKED</promise>`. Tide host translates these into Linear writes — DONE transitions the sub-issue to the team's _completed_ workflow state; BLOCKED leaves the workflow state alone, swaps the sub-issue's `ready-for-agent` label for `ready-for-human`, and posts a Linear comment authored by a follow-up summarizer agent. Agent-driven FAIL (no commits + no signal) is treated as BLOCKED with a different summarizer prompt, since there is nothing the agent declared to summarize and the summarizer must infer from the transcript.

The runner switches from one-shot `run()` per iteration to sandcastle's reusable-sandbox pattern (`createSandbox` once per `tide run`, `sandbox.run(...)` per working-agent iteration and per summarizer invocation). The summarizer agent reads the working agent's transcript via the previous run's `logFilePath` and is given the Linear sub-issue and PRD bodies as additional prompt context. The summarizer's final assistant message is extracted host-side and posted verbatim as the Linear comment — no closing tag, no file write; the conciseness contract lives in the summarizer's prompt.

Infra failures (sandcastle threw, content fetch failed) abort the queue and do _not_ flip the label, because the issue itself is healthy and the user shouldn't have to un-flip a label to retry an unrelated transient failure.
