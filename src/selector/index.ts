// Interactive clack selector for the Linear-native flow.
//
//   - pickRoot: render the list of PRDs and Standalone Issues returned by
//     `linear.listPRDs` / `linear.listStandaloneIssues` as a single clack
//     `select`. PRDs are grouped first, then Standalone Issues. Each row is
//     prefixed with `[PRD]` or `[Issue]` so the kind is unambiguous in logs
//     and screen-readers.
//
// There is no "[Create new Linear PRD]" path: PRDs and Standalone Issues
// must be authored in Linear's UI before `tide run`.

import { select, isCancel, cancel } from "@clack/prompts";
import type { PRD, StandaloneIssue } from "../linear/index.ts";

export type RootRef =
  | { kind: "prd"; prd: PRD }
  | { kind: "standalone"; issue: StandaloneIssue };

export interface PickRootInput {
  prds: readonly PRD[];
  standaloneIssues: readonly StandaloneIssue[];
}

interface OptionEntry {
  ref: RootRef;
  label: string;
}

/**
 * Render a clack select grouping PRDs first, then Standalone Issues.
 * Returns the picked root as a tagged union; on user cancel, prints
 * "Cancelled." and exits the process with code 0.
 *
 * Pre-condition: at least one of `prds` / `standaloneIssues` is non-empty.
 * The caller is responsible for handling the empty case (no roots to pick
 * from is its own UI flow).
 */
export async function pickRoot(input: PickRootInput): Promise<RootRef> {
  const entries: OptionEntry[] = [];
  for (const prd of input.prds) {
    entries.push({
      ref: { kind: "prd", prd },
      label: `[PRD] ${prd.identifier} ${prd.title} — ${String(prd.readyForAgentCount)} ready-for-agent, ${String(prd.readyForHumanCount)} ready-for-human`,
    });
  }
  for (const issue of input.standaloneIssues) {
    entries.push({
      ref: { kind: "standalone", issue },
      label: `[Issue] ${issue.identifier} ${issue.title}`,
    });
  }

  const options = entries.map((e, i) => ({ value: i, label: e.label }));

  const choice = await select<number>({
    message: "Pick a Linear root (PRD or Standalone Issue):",
    options,
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  const entry = entries[choice];
  if (!entry) {
    // Should be impossible: choice is one of the values we passed in.
    throw new Error(
      `Internal error: picked root index ${String(choice)} not in list`
    );
  }
  return entry.ref;
}
