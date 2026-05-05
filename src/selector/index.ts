// Interactive clack selector for the Linear-native flow.
//
//   - pickPRD: render the list of PRDs returned by `linear.listPRDs` as a
//     clack `select`. Each option is rendered as
//       `{identifier} {title} — {n} ready-for-agent, {m} ready-for-human`
//     in the order the caller passed in (caller is responsible for ordering;
//     `linear.listPRDs` returns them sorted by `updatedAt` desc).
//
// There is no "[Create new Linear PRD]" path: PRDs must be authored in
// Linear's UI before `tide run`.

import { select, isCancel, cancel } from "@clack/prompts";
import type { PRD } from "../linear/index.ts";

/**
 * Render a clack select over `prds`. Returns the picked PRD; on user cancel,
 * prints "Cancelled." and exits the process with code 0.
 *
 * Pre-condition: `prds.length > 0`. The caller is responsible for handling
 * the empty case (no PRDs to pick from is its own UI flow).
 */
export async function pickPRD(prds: readonly PRD[]): Promise<PRD> {
  const options = prds.map((prd, i) => ({
    value: i,
    label: `${prd.identifier} ${prd.title} — ${String(prd.readyForAgentCount)} ready-for-agent, ${String(prd.readyForHumanCount)} ready-for-human`,
  }));

  const choice = await select<number>({
    message: "Pick a Linear PRD:",
    options,
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  const prd = prds[choice];
  if (!prd) {
    // Should be impossible: choice is one of the values we passed in.
    throw new Error(
      `Internal error: picked PRD index ${String(choice)} not in list`
    );
  }
  return prd;
}
