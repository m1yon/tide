// Pure module: render the per-issue `promptArgs` record for a `run()` call.
//
// The keys correspond to `{{KEY}}` placeholders in the prompt template:
//   - ISSUE_ID:       the Linear identifier of the in-scope issue
//   - ISSUE_TITLE:    the issue's title string
//   - ISSUE_CONTENT:  a markdown block with `Title`, `Body`, and `Comments`
//                     sub-sections (Comments omitted if there are none)
//   - PRD_CONTENT:    the parent PRD's raw markdown body (PRD root only)
//   - PARENT_ID:      the parent PRD's Linear identifier (PRD root only)
//   - FEATURE_BRANCH: the Feature worktree's branch (the branch the agent
//                     commits to)
//   - BASE_BRANCH:    the user's PR target branch
//
// `parent` is optional. When omitted (Standalone Issue root), `PRD_CONTENT`
// and `PARENT_ID` are omitted from the rendered args.
//
// `FEATURE_BRANCH` / `BASE_BRANCH` are tide-owned and supersede sandcastle's
// built-in `{{SOURCE_BRANCH}}` / `{{TARGET_BRANCH}}` placeholders, whose
// meanings flip between the `branch` and `merge-to-head` strategies. See
// ADR-0014.
//
// Markdown special characters in body / comments pass through unmodified
// (no escaping). An empty body still renders the `Body` sub-section with a
// placeholder so the structure is stable across issues.

export interface IssueContent {
  identifier: string;
  title: string;
  body: string;
  comments: string[];
}

export interface BuildPromptArgsInput {
  issue: IssueContent;
  parent?: IssueContent;
  /** The Feature worktree's branch — the branch the agent commits to. */
  featureBranch: string;
  /** The user's PR target branch. */
  baseBranch: string;
}

export type PromptArgsRecord = Record<string, string | number | boolean>;

export const EMPTY_BODY_PLACEHOLDER = "_(no body)_";

function renderIssueContent(issue: IssueContent): string {
  const parts: string[] = [];
  parts.push("### Title");
  parts.push("");
  parts.push(issue.title);
  parts.push("");
  parts.push("### Body");
  parts.push("");
  parts.push(issue.body.trim() === "" ? EMPTY_BODY_PLACEHOLDER : issue.body);
  if (issue.comments.length > 0) {
    parts.push("");
    parts.push("### Comments");
    parts.push("");
    for (let i = 0; i < issue.comments.length; i++) {
      if (i > 0) parts.push("");
      parts.push(`#### Comment ${String(i + 1)}`);
      parts.push("");
      const c = issue.comments[i];
      if (c !== undefined) parts.push(c);
    }
  }
  return parts.join("\n");
}

export function buildPromptArgs(input: BuildPromptArgsInput): PromptArgsRecord {
  const { issue, parent, featureBranch, baseBranch } = input;
  const args: PromptArgsRecord = {
    ISSUE_ID: issue.identifier,
    ISSUE_TITLE: issue.title,
    ISSUE_CONTENT: renderIssueContent(issue),
    FEATURE_BRANCH: featureBranch,
    BASE_BRANCH: baseBranch,
  };
  if (parent !== undefined) {
    args.PRD_CONTENT = parent.body;
    args.PARENT_ID = parent.identifier;
  }
  return args;
}
