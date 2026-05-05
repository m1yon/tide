// Bundled summarizer-agent prompts + pure prompt-arg builder for the
// BLOCKED and agent-FAIL Linear comment paths.
//
// Architecturally mirrors `pr-submission/index.ts`: prompt strings ship as
// TypeScript constants (not user-editable like `.tide/prompt.md`), and
// `buildSummarizerPromptArgs` is the pure function that returns the
// `{{KEY}}` substitution map. `renderSummarizerPrompt` is a thin convenience
// helper that applies the substitutions in one shot.
//
// Triggers:
//   - `blocked` — working agent emitted `<promise>BLOCKED</promise>`. Frame
//     the comment as "agent gave up gracefully; here's why."
//   - `fail`    — working agent emitted no DONE signal AND no commits, OR
//     committed without DONE, OR DONE'd without committing. Frame the
//     comment as "agent did not finish cleanly; here's what we know."
//
// The summarizer's output is posted *verbatim* as the Linear comment body.
// The conciseness contract lives entirely in the prompt — no closing tag,
// no file write, no post-processing on tide's side.

import { applyPromptTemplate } from "../pr-submission/index.ts";
import { EMPTY_BODY_PLACEHOLDER } from "../prompt-args/index.ts";

const EMPTY_TRANSCRIPT_PLACEHOLDER = "_(no transcript captured)_";

export type SummarizerPromptKind = "blocked" | "fail";

export interface SummarizerPromptInput {
  /** Linear identifier of the sub-issue being summarized (e.g. "ENG-7"). */
  issueIdentifier: string;
  issueTitle: string;
  /** Markdown body of the sub-issue. Empty string is acceptable. */
  issueBody: string;
  /** Linear identifier of the parent PRD (e.g. "ENG-1"). */
  parentIdentifier: string;
  parentTitle: string;
  /** Markdown body of the parent PRD. Empty string is acceptable. */
  parentBody: string;
  /** Working agent's transcript text (typically the trailing assistant
   * message extracted from the iteration's log file). Empty string is
   * acceptable — the placeholder ensures the rendered prompt remains valid. */
  transcript: string;
}

export type SummarizerPromptArgs = Record<string, string>;

const BLOCKED_SUMMARY_PROMPT = `You are reviewing a coding agent's transcript to write a Linear comment explaining why a sub-issue is blocked. Your output will be posted *verbatim* as the comment body — there is no further processing or editing on the host side.

# Context

- Sub-issue: {{ISSUE_ID}} — {{ISSUE_TITLE}}
- Parent PRD: {{PARENT_ID}} — {{PARENT_TITLE}}

## Sub-issue body

{{ISSUE_BODY}}

## Parent PRD body

{{PARENT_BODY}}

## Working agent's final transcript

{{TRANSCRIPT}}

# What to write

The working agent emitted \`<promise>BLOCKED</promise>\` — it gracefully gave up because of an obstacle outside its control (missing context, failing tests it couldn't fix, an external dependency, etc.).

Write a concise Linear comment — a few sentences, at most a short paragraph — that:

1. States plainly that the sub-issue was flipped to \`ready-for-human\`.
2. Explains *what* blocked the agent, in the agent's own framing where useful.
3. Suggests the *next decision* a human should make to unblock the work, when that's clear from the transcript.

Do not enumerate every tool call the agent made. Do not paste the transcript. Do not include a closing signal. Output only the comment text.`;

const FAIL_SUMMARY_PROMPT = `You are reviewing a coding agent's transcript to write a Linear comment explaining why a sub-issue did not finish cleanly. Your output will be posted *verbatim* as the comment body — there is no further processing or editing on the host side.

# Context

- Sub-issue: {{ISSUE_ID}} — {{ISSUE_TITLE}}
- Parent PRD: {{PARENT_ID}} — {{PARENT_TITLE}}

## Sub-issue body

{{ISSUE_BODY}}

## Parent PRD body

{{PARENT_BODY}}

## Working agent's final transcript

{{TRANSCRIPT}}

# What to write

The working agent did not exit cleanly. Specifically: it failed to emit \`<promise>DONE</promise>\` *and* commit at least one change. The most likely shapes are:

- the agent ran out of iterations without signaling completion;
- the agent emitted DONE but never committed;
- the agent committed but never emitted DONE.

Write a concise Linear comment — a few sentences, at most a short paragraph — that:

1. States plainly that the sub-issue was flipped to \`ready-for-human\` after an agent-FAIL outcome.
2. Explains the most plausible *cause* given the transcript (e.g. "agent looped on a flaky test", "agent forgot to commit before signalling done", "agent ran out of iterations mid-edit").
3. Suggests the *next decision* a human should make — usually one of: re-run after a fix, take over manually, or split the sub-issue.

Do not enumerate every tool call the agent made. Do not paste the transcript. Do not include a closing signal. Output only the comment text.`;

export { BLOCKED_SUMMARY_PROMPT, FAIL_SUMMARY_PROMPT };

/**
 * Pure: build the `{{KEY}}` substitution map for the bundled summarizer
 * prompt template. Empty body / transcript fields render as stable
 * placeholders so the rendered prompt's section structure stays intact.
 */
export function buildSummarizerPromptArgs(
  input: SummarizerPromptInput
): SummarizerPromptArgs {
  return {
    ISSUE_ID: input.issueIdentifier,
    ISSUE_TITLE: input.issueTitle,
    ISSUE_BODY:
      input.issueBody.trim() === "" ? EMPTY_BODY_PLACEHOLDER : input.issueBody,
    PARENT_ID: input.parentIdentifier,
    PARENT_TITLE: input.parentTitle,
    PARENT_BODY:
      input.parentBody.trim() === ""
        ? EMPTY_BODY_PLACEHOLDER
        : input.parentBody,
    TRANSCRIPT:
      input.transcript.trim() === ""
        ? EMPTY_TRANSCRIPT_PLACEHOLDER
        : input.transcript,
  };
}

/**
 * Render the bundled BLOCKED / FAIL summarizer prompt with all placeholders
 * substituted. Convenience wrapper around `buildSummarizerPromptArgs` plus
 * the template apply step.
 */
export function renderSummarizerPrompt(
  kind: SummarizerPromptKind,
  input: SummarizerPromptInput
): string {
  const template =
    kind === "blocked" ? BLOCKED_SUMMARY_PROMPT : FAIL_SUMMARY_PROMPT;
  return applyPromptTemplate(template, buildSummarizerPromptArgs(input));
}
