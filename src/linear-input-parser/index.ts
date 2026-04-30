// Pure parser for Linear issue input. Accepts:
//   - bare identifier ("MEC-680")
//   - full Linear issue URL ("https://linear.app/<workspace>/issue/MEC-680/...")
//   - lowercase variants ("mec-680")
//   - whitespace around either form
// Returns the canonical uppercase identifier ("MEC-680") or null when the
// input is empty / does not contain a recognisable Linear issue identifier.
//
// Non-issue Linear URLs (e.g. project, settings, view pages) return null.

// A Linear identifier is `<TEAM>-<NUMBER>`, where TEAM is 1-10 alpha chars and
// NUMBER is one or more digits. We anchor parsing on this shape so arbitrary
// strings that happen to contain a dash and a number do not match.
const ID_RE = /\b([A-Za-z]{1,10})-(\d+)\b/;

// Linear issue URLs always include `/issue/<IDENT>` somewhere in the path.
// Anything else under linear.app (project, view, settings, ...) is rejected.
const URL_ISSUE_RE = /linear\.app\/[^\s]*\/issue\/([A-Za-z]{1,10}-\d+)/i;

export function parseLinearInput(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // URL path: must look like a Linear issue URL specifically. This rejects
  // links to projects, settings, views, etc.
  if (/linear\.app\//i.test(trimmed)) {
    const m = URL_ISSUE_RE.exec(trimmed);
    if (!m) return null;
    const ident = m[1];
    if (ident === undefined) return null;
    return ident.toUpperCase();
  }

  // Bare identifier. Reject anything wrapping the identifier in extra text
  // (we want "MEC-680", not "see MEC-680 for details") -- callers paste a
  // single token, and validating strict-equality keeps the contract honest.
  const m = ID_RE.exec(trimmed);
  if (!m) return null;
  const team = m[1];
  const num = m[2];
  if (team === undefined || num === undefined) return null;
  // Require the whole string to be the identifier (after trimming).
  const candidate = `${team}-${num}`;
  if (candidate.toUpperCase() !== trimmed.toUpperCase()) return null;
  return candidate.toUpperCase();
}
