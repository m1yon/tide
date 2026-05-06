// Substitution + shape tests for the bundled summarizer prompts. Mirrors
// `pr-submission/index.test.ts`'s pattern: snapshot the rendered prompt for
// each trigger, plus pin the contract on the pure prompt-arg builder.

import { describe, expect, test } from "bun:test";
import {
  BLOCKED_SUMMARY_PROMPT,
  FAIL_SUMMARY_PROMPT,
  buildSummarizerPromptArgs,
  renderSummarizerPrompt,
  type SummarizerPromptKind,
} from "./index.ts";

const baseInput = {
  issueIdentifier: "ENG-7",
  issueTitle: "Wire up the runner",
  issueBody: "Implement the orchestrator.",
  parentIdentifier: "ENG-1",
  parentTitle: "Linear-native runner",
  parentBody: "Migrate the runner to Linear as the source of truth.",
  transcript: "I tried two approaches but the test suite still fails.",
};

describe("buildSummarizerPromptArgs", () => {
  test("returns the full set of substitution keys", () => {
    const args = buildSummarizerPromptArgs(baseInput);
    expect(Object.keys(args).sort()).toEqual(
      [
        "ISSUE_ID",
        "ISSUE_TITLE",
        "ISSUE_BODY",
        "PARENT_ID",
        "PARENT_TITLE",
        "PARENT_BODY",
        "TRANSCRIPT",
      ].sort()
    );
    expect(args.ISSUE_ID).toBe("ENG-7");
    expect(args.PARENT_ID).toBe("ENG-1");
    expect(args.TRANSCRIPT).toBe(
      "I tried two approaches but the test suite still fails."
    );
  });

  test("renders empty body / transcript with stable placeholders so the structure stays intact", () => {
    const args = buildSummarizerPromptArgs({
      ...baseInput,
      issueBody: "",
      parentBody: "",
      transcript: "",
    });
    expect(args.ISSUE_BODY).toBe("_(no body)_");
    expect(args.PARENT_BODY).toBe("_(no body)_");
    expect(args.TRANSCRIPT).toBe("_(no transcript captured)_");
  });
});

describe("renderSummarizerPrompt — BLOCKED trigger", () => {
  test("substitutes every {{KEY}} placeholder", () => {
    const rendered = renderSummarizerPrompt("blocked", baseInput);
    expect(rendered).toContain("ENG-7");
    expect(rendered).toContain("Wire up the runner");
    expect(rendered).toContain("Implement the orchestrator.");
    expect(rendered).toContain("ENG-1");
    expect(rendered).toContain("Linear-native runner");
    expect(rendered).toContain(
      "Migrate the runner to Linear as the source of truth."
    );
    expect(rendered).toContain(
      "I tried two approaches but the test suite still fails."
    );
    // Sanity: no unsubstituted placeholders remain.
    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  test("instructs the summarizer that its output IS the comment, and asks for brevity", () => {
    expect(BLOCKED_SUMMARY_PROMPT).toMatch(/Linear comment/i);
    expect(BLOCKED_SUMMARY_PROMPT).toMatch(
      /concise|brief|short|few sentences/i
    );
  });

  test("frames the trigger as BLOCKED (graceful give-up)", () => {
    expect(BLOCKED_SUMMARY_PROMPT).toMatch(/blocked/i);
  });
});

describe("renderSummarizerPrompt — FAIL trigger", () => {
  test("substitutes every {{KEY}} placeholder", () => {
    const rendered = renderSummarizerPrompt("fail", baseInput);
    expect(rendered).toContain("ENG-7");
    expect(rendered).toContain("ENG-1");
    expect(rendered).toContain(
      "I tried two approaches but the test suite still fails."
    );
    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  test("frames the trigger as agent-FAIL (no signal / no commits)", () => {
    expect(FAIL_SUMMARY_PROMPT).toMatch(/fail|did not signal|did not commit/i);
  });

  test("BLOCKED and FAIL prompts diverge in framing", () => {
    expect(BLOCKED_SUMMARY_PROMPT).not.toBe(FAIL_SUMMARY_PROMPT);
  });
});

describe("kind enumeration", () => {
  test("only `blocked` and `fail` are valid kinds", () => {
    const kinds: SummarizerPromptKind[] = ["blocked", "fail"];
    for (const kind of kinds) {
      // Just smoke-test that both kinds render without throwing.
      expect(() => renderSummarizerPrompt(kind, baseInput)).not.toThrow();
    }
  });
});
