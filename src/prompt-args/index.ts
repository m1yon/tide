// Pure module: render the per-issue `promptArgs` record for a `run()` call.
//
// The six keys correspond to `{{KEY}}` placeholders in `.tide/prompt.md`:
//   - ISSUE_ID:      the Linear identifier of the sub-issue (e.g. "ENG-7")
//   - ISSUE_TITLE:   the issue's title string
//   - ISSUE_CONTENT: a markdown block with `Title`, `Body`, and `Comments`
//                    sub-sections (Comments omitted if there are none)
//   - PRD_CONTENT:   the parent PRD's raw markdown body
//   - PARENT_ID:     the parent PRD's Linear identifier (e.g. "ENG-1")
//   - BRANCH:        the Linear-derived branch name (used verbatim)
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
  parent: IssueContent;
  branch: string;
}

export type PromptArgsRecord = Record<string, string | number | boolean>;

const EMPTY_BODY_PLACEHOLDER = "_(no body)_";

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
  const { issue, parent, branch } = input;
  return {
    ISSUE_ID: issue.identifier,
    ISSUE_TITLE: issue.title,
    ISSUE_CONTENT: renderIssueContent(issue),
    PRD_CONTENT: parent.body,
    PARENT_ID: parent.identifier,
    BRANCH: branch,
  };
}
