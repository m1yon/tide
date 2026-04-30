import { describe, it, expect } from "bun:test";
import { buildPromptArgs, type IssueContent } from "./index.ts";

const baseParent: IssueContent = {
  number: 100,
  title: "PRD: example feature",
  body: "This PRD describes the example feature.",
  comments: [],
};

describe("buildPromptArgs", () => {
  it("renders an issue with title, body, and a single comment with all six keys present", () => {
    const issue: IssueContent = {
      number: 104,
      title: "Sub-issue four",
      body: "Implement the runner.",
      comments: ["Looks good to me."],
    };
    const args = buildPromptArgs({
      issue,
      parent: baseParent,
      branch: "feature/mec-1-foo",
    });

    // All six keys present.
    expect(Object.keys(args).sort()).toEqual(
      [
        "BRANCH",
        "ISSUE_CONTENT",
        "ISSUE_ID",
        "ISSUE_TITLE",
        "PARENT_ID",
        "PRD_CONTENT",
      ].sort()
    );

    // Numeric IDs pass through as plain integers (per spec).
    expect(args.ISSUE_ID).toBe(104);
    expect(args.PARENT_ID).toBe(100);
    expect(args.ISSUE_TITLE).toBe("Sub-issue four");
    expect(args.BRANCH).toBe("feature/mec-1-foo");
    expect(args.PRD_CONTENT).toBe("This PRD describes the example feature.");

    // ISSUE_CONTENT markdown structure.
    const content = args.ISSUE_CONTENT as string;
    expect(content).toContain("### Title");
    expect(content).toContain("Sub-issue four");
    expect(content).toContain("### Body");
    expect(content).toContain("Implement the runner.");
    expect(content).toContain("### Comments");
    expect(content).toContain("Looks good to me.");

    // Sub-sections appear in Title -> Body -> Comments order.
    const titleIdx = content.indexOf("### Title");
    const bodyIdx = content.indexOf("### Body");
    const commentsIdx = content.indexOf("### Comments");
    expect(titleIdx).toBeLessThan(bodyIdx);
    expect(bodyIdx).toBeLessThan(commentsIdx);
  });

  it("retains the Body sub-section with a placeholder when the body is empty", () => {
    const issue: IssueContent = {
      number: 200,
      title: "Empty body issue",
      body: "",
      comments: [],
    };
    const args = buildPromptArgs({
      issue,
      parent: baseParent,
      branch: "feature/mec-2-bar",
    });
    const content = args.ISSUE_CONTENT as string;
    expect(content).toContain("### Body");
    // The placeholder is present so the structure is stable.
    expect(content).toMatch(/### Body\s+\n\s*_\(no body\)_/);
  });

  it("omits the Comments sub-section entirely when there are zero comments", () => {
    const issue: IssueContent = {
      number: 201,
      title: "No comments issue",
      body: "Body text.",
      comments: [],
    };
    const args = buildPromptArgs({
      issue,
      parent: baseParent,
      branch: "feature/mec-3-baz",
    });
    const content = args.ISSUE_CONTENT as string;
    expect(content).toContain("### Title");
    expect(content).toContain("### Body");
    expect(content).not.toContain("### Comments");
  });

  it("passes markdown special characters through verbatim (no escaping)", () => {
    const issue: IssueContent = {
      number: 202,
      title: "Markdown specials",
      body: "Body with `code`, **bold**, [link](url), and a list:\n- a\n- b",
      comments: ["A comment with > a quote and ## a header inside"],
    };
    const args = buildPromptArgs({
      issue,
      parent: baseParent,
      branch: "feature/mec-4-qux",
    });
    const content = args.ISSUE_CONTENT as string;
    expect(content).toContain("`code`");
    expect(content).toContain("**bold**");
    expect(content).toContain("[link](url)");
    expect(content).toContain("- a");
    expect(content).toContain("- b");
    expect(content).toContain("> a quote");
    expect(content).toContain("## a header inside");
  });
});
