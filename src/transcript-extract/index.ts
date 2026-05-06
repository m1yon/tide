// Pure module: extract the agent's final assistant-message text from a
// Sandcastle log file written in `{ type: "file" }` mode.
//
// Sandcastle's `FileDisplay` writes one line per display call:
//
//   - `display.text(chunk)`        → `<chunk>\n`              (assistant text)
//   - `display.toolCall(n, args)`  → `<n>(<args>)\n`          (tool calls;
//                                                              only Bash,
//                                                              WebSearch,
//                                                              WebFetch, and
//                                                              Agent are
//                                                              surfaced for
//                                                              Claude — see
//                                                              `TOOL_ARG_FIELDS`
//                                                              in sandcastle's
//                                                              AgentProvider)
//   - `display.status(msg, sev)`   → `<msg-without-[name]>\n` (status lines:
//                                                              "Agent started",
//                                                              "Agent stopped",
//                                                              iteration banners,
//                                                              etc.)
//   - `display.spinner(msg, eff)`  → `<msg>...\n` then `<msg> done (Xs)\n`
//   - `display.summary(...)`       → multi-line summary block
//   - `display.taskLog(...)`       → multi-line task block
//
// The "final assistant-message text" we want is the trailing block of
// `display.text` output that comes after the last tool call, within the
// final iteration's `Agent started` → `Agent stopped` window. This is what a
// summarizer agent should consume to write a one-paragraph reason for a
// BLOCKED / agent-FAIL outcome.
//
// The extraction is heuristic: tool args may span multiple lines (Bash with
// a heredoc, for example), in which case the embedded content gets
// classified as text and folded into the trailing message. That's tolerable
// — the summarizer's prompt already includes the issue + PRD bodies as
// authoritative context, so extra tool-arg noise is unlikely to mislead it.

const AGENT_STARTED = "Agent started";
const AGENT_STOPPED = "Agent stopped";

/**
 * Tool names Sandcastle surfaces for the Claude provider. Lines beginning
 * with `<name>(` mark the start of a tool call in the log. Other Claude
 * tools (Read, Edit, Glob, Grep, …) are not logged as tool calls — they
 * simply don't appear in the transcript file.
 */
const CLAUDE_TOOL_CALL_RE = /^(?:Bash|WebSearch|WebFetch|Agent)\(/;

/**
 * Slice the log to the final iteration's transcript window — everything
 * between the last `Agent started` line and the next `Agent stopped` line.
 * If `Agent stopped` is missing (truncated / mid-stream log), slice to end
 * of file. If `Agent started` is missing, fall through with the original
 * content so callers don't choke on hand-rolled fixtures.
 */
function sliceFinalIteration(content: string): string {
  const lastStartIdx = content.lastIndexOf(AGENT_STARTED);
  if (lastStartIdx < 0) return content;
  const afterStart = content.slice(lastStartIdx + AGENT_STARTED.length);
  const stopIdx = afterStart.indexOf(AGENT_STOPPED);
  const slice = stopIdx >= 0 ? afterStart.slice(0, stopIdx) : afterStart;
  // Drop the leading newline that follows the "Agent started" marker.
  return slice.replace(/^\r?\n/, "");
}

/**
 * Return the agent's final assistant-message text from a Sandcastle log
 * file's content. Returns the trimmed text after the last tool call within
 * the final iteration's transcript, or the whole transcript if there are no
 * tool calls.
 */
export function extractFinalAssistantMessage(content: string): string {
  const transcript = sliceFinalIteration(content);
  const lines = transcript.split("\n");

  let lastToolCallLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (CLAUDE_TOOL_CALL_RE.test(lines[i] ?? "")) {
      lastToolCallLine = i;
    }
  }

  const finalLines =
    lastToolCallLine >= 0 ? lines.slice(lastToolCallLine + 1) : lines;
  return finalLines.join("\n").trim();
}

/**
 * Read a Sandcastle log file from disk and return the extracted final
 * assistant-message text. Surfaced as a thin wrapper so callers don't need
 * to repeat the file IO at every call-site.
 */
export async function readFinalAssistantMessage(
  logFilePath: string
): Promise<string> {
  const content = await Bun.file(logFilePath).text();
  return extractFinalAssistantMessage(content);
}
