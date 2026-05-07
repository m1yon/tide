// Branch override — escape hatch that lets `tide run` proceed from a
// feature branch that doesn't match the picked root's Linear-auto-generated
// `branchName`. Replaces the prior pre-flight gate that errored out when
// the user's current branch was the picked root's feature branch.
//
// The module splits into two pieces:
//
//   * `decideBranchOverride` — pure decision. When the user's current
//     branch already matches Linear's `branchName` the override is silent
//     (the path "I'm on the right branch already" doesn't waste a
//     keystroke). Otherwise the caller is told the prompt is needed and is
//     handed both candidate branches.
//
//   * `promptBranchOverride` — clack-`select` UI seam. Renders Linear's
//     branch (default cursor) and the user's current branch (second), then
//     resolves to either the chosen branch or a cancellation. Split from
//     the decision so the comparison is unit-testable without rendering
//     UI, and so the cli/run path can swap the UI for a stub in tests.
//
// The chosen value becomes the Feature worktree's branch (PER-79). When
// the chosen branch differs from Linear's `branchName`, the caller treats
// that as the override having been "taken" — Linear's GitHub integration
// cannot match the PR's branch back to the root on merge, so the host
// emits an end-of-run warning that the root won't auto-transition to Done.

import {
  isCancel as defaultIsCancel,
  select as defaultSelect,
} from "@clack/prompts";

export type BranchOverrideDecision =
  | { kind: "silent"; branch: string }
  | { kind: "needs-prompt"; linearBranch: string; currentBranch: string };

export interface DecideBranchOverrideInput {
  /** The branch the user invoked `tide run` from (`git rev-parse --abbrev-ref HEAD`). */
  currentBranch: string;
  /** The picked root's Linear-auto-generated `branchName`. */
  pickedBranchName: string;
}

/**
 * Pure decision: when the user's current branch matches the picked root's
 * branch we proceed silently with Linear's branch; otherwise we need the
 * clack prompt to disambiguate.
 */
export function decideBranchOverride(
  input: DecideBranchOverrideInput
): BranchOverrideDecision {
  if (input.currentBranch === input.pickedBranchName) {
    return { kind: "silent", branch: input.pickedBranchName };
  }
  return {
    kind: "needs-prompt",
    linearBranch: input.pickedBranchName,
    currentBranch: input.currentBranch,
  };
}

export type BranchOverrideOutcome =
  | { kind: "chosen"; branch: string }
  | { kind: "cancelled" };

export interface PromptBranchOverrideInput {
  linearBranch: string;
  currentBranch: string;
}

/** Test seam for `@clack/prompts.select`. Re-exports clack's exact type so
 * the production default can be substituted with a stub in unit tests. */
export type SelectFn = typeof defaultSelect;

/** Test seam for `@clack/prompts.isCancel`. Narrowed to `boolean` to keep
 * call sites simple; the symbol-marker inspection happens inside the seam. */
export type IsCancelFn = (value: unknown) => boolean;

/**
 * Render the clack `select` for the override prompt. Two options: Linear's
 * branch (default cursor) and the user's current branch (second). Returns
 * the picked branch or a cancellation; the caller decides how to surface
 * the cancel (typically an early clean-cancel exit before any Linear
 * write).
 */
export async function promptBranchOverride(
  input: PromptBranchOverrideInput,
  selectFn: SelectFn = defaultSelect,
  isCancelFn: IsCancelFn = defaultIsCancel
): Promise<BranchOverrideOutcome> {
  const choice = await selectFn<string>({
    message: "Pick the feature branch:",
    options: [
      {
        value: input.linearBranch,
        label: `${input.linearBranch} (Linear)`,
      },
      {
        value: input.currentBranch,
        label: `${input.currentBranch} (current)`,
      },
    ],
    initialValue: input.linearBranch,
  });
  if (isCancelFn(choice)) {
    return { kind: "cancelled" };
  }
  return { kind: "chosen", branch: choice as string };
}
