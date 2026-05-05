// Table-driven unit tests for `extractFinalAssistantMessage`. Each case
// builds a representative Sandcastle log file in memory (the file display
// appends a fixed-shape line per status / spinner / text / tool-call) and
// asserts the extractor returns the agent's trailing assistant text — i.e.
// everything after the last tool call within the final iteration's
// `Agent started` → `Agent stopped` window.
//
// The extractor is purely heuristic: it relies on the file display's known
// line shapes and on the four Claude tool names that Sandcastle surfaces in
// the log (`Bash`, `WebSearch`, `WebFetch`, `Agent`). Other tool calls (Read,
// Edit, Glob, …) never appear in the file, so they don't need a separate
// branch in the parser.

import { describe, expect, test } from "bun:test";
import { extractFinalAssistantMessage } from "./index.ts";

interface Case {
  name: string;
  input: string;
  expected: string;
}

const cases: Case[] = [
  {
    name: "empty content → empty string",
    input: "",
    expected: "",
  },
  {
    name: "single text chunk between Agent started and Agent stopped",
    input: [
      "--- Run started: 2026-05-05T12:00:00.000Z ---",
      "Iteration 1/3",
      "Agent started",
      "I made the edit and committed it.",
      "<promise>DONE</promise>",
      "Agent stopped",
      "Agent signaled completion after 1 iteration(s).",
    ].join("\n"),
    expected: [
      "I made the edit and committed it.",
      "<promise>DONE</promise>",
    ].join("\n"),
  },
  {
    name: "trailing text after the last tool call",
    input: [
      "Agent started",
      "Looking at the failing test now.",
      "Bash(bun test src/runner)",
      "The runner test fails because the new option isn't wired through.",
      "Edit applied. Committing.",
      "<promise>BLOCKED</promise>",
      "Agent stopped",
    ].join("\n"),
    expected: [
      "The runner test fails because the new option isn't wired through.",
      "Edit applied. Committing.",
      "<promise>BLOCKED</promise>",
    ].join("\n"),
  },
  {
    name: "multiple tool calls — only the trailing block is returned",
    input: [
      "Agent started",
      "First, I'll inspect the file.",
      "Bash(ls -la)",
      "Now let me read it.",
      "Bash(cat README.md)",
      "Done — final answer here.",
      "Agent stopped",
    ].join("\n"),
    expected: "Done — final answer here.",
  },
  {
    name: "no tool calls at all → returns the whole transcript span",
    input: [
      "Agent started",
      "I considered the problem and have a one-line answer.",
      "Agent stopped",
    ].join("\n"),
    expected: "I considered the problem and have a one-line answer.",
  },
  {
    name: "tool call with arguments containing parens still terminates correctly",
    input: [
      "Agent started",
      "Bash(echo (hi))",
      "Final wrap-up text.",
      "Agent stopped",
    ].join("\n"),
    expected: "Final wrap-up text.",
  },
  {
    name: "multi-iteration log — only the last iteration's trailing message is returned",
    input: [
      "--- Run started: 2026-05-05T12:00:00.000Z ---",
      "Iteration 1/2",
      "Agent started",
      "First iteration text.",
      "Bash(ls)",
      "Mid-iteration commentary.",
      "Agent stopped",
      "Iteration 2/2",
      "Agent started",
      "Bash(git status)",
      "Second iteration final answer.",
      "<promise>DONE</promise>",
      "Agent stopped",
    ].join("\n"),
    expected: [
      "Second iteration final answer.",
      "<promise>DONE</promise>",
    ].join("\n"),
  },
  {
    name: "trailing whitespace and blank lines are trimmed",
    input: [
      "Agent started",
      "Bash(ls)",
      "",
      "Final message text.",
      "",
      "",
      "Agent stopped",
      "",
    ].join("\n"),
    expected: "Final message text.",
  },
  {
    name: "WebFetch tool call delimiter is recognized",
    input: [
      "Agent started",
      "WebFetch(https://example.com)",
      "Body fetched and analyzed.",
      "Agent stopped",
    ].join("\n"),
    expected: "Body fetched and analyzed.",
  },
  {
    name: "WebSearch and Agent tool calls are recognized",
    input: [
      "Agent started",
      "WebSearch(some query)",
      "Agent(spawn a worker)",
      "All sub-agents complete; here is the conclusion.",
      "Agent stopped",
    ].join("\n"),
    expected: "All sub-agents complete; here is the conclusion.",
  },
  {
    name: "no Agent stopped marker → falls back to content from last Agent started to end",
    input: [
      "Agent started",
      "I'm in the middle of work and the log got truncated mid-stream.",
      "Bash(ls)",
      "Cleanup line that should be the final message.",
    ].join("\n"),
    expected: "Cleanup line that should be the final message.",
  },
];

describe("extractFinalAssistantMessage", () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(extractFinalAssistantMessage(c.input)).toBe(c.expected);
    });
  }
});
