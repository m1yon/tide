// PR target branch — resolves the branch the eventual PR merges into,
// surfaced to the agent as `{{BASE_BRANCH}}` and passed to `gh pr create
// --base`. Mirrors `branch-override`'s shape (pure decision + clack UI seam)
// so the prompt is unit-testable without rendering UI.
//
// The module splits into two pieces:
//
//   * `decidePrTarget` — pure decision. When the user's current branch
//     matches `origin/HEAD` (and `origin/HEAD` is set) we proceed silently
//     with that branch (the typical "invoked from trunk" path). Otherwise
//     the caller is told a prompt is needed and is handed `origin/HEAD` as
//     the prompt's default (or `undefined` when `origin/HEAD` is unset, in
//     which case the prompt fires with no default).
//
//   * `promptPrTarget` — clack `select` + `text` UI seam. When a default
//     exists, renders a `select` between `[origin/HEAD]` (default cursor)
//     and a "Type another..." escape hatch that spawns a `text` prompt.
//     When no default exists, goes straight to the `text` prompt. A
//     user-typed branch must resolve to a local ref (via `verifyRef`,
//     defaulting to `git rev-parse --verify`); failure re-prompts with the
//     `git fetch && git checkout` hint and never silently proceeds with a
//     remote-only ref.
//
// See ADR-0016. The split exists because the pre-ADR `tide run` conflated
// the user's HEAD ("current branch") with the PR target into a single
// `resolveBaseBranch` capture, which silently broke the **Branch override**
// path: a user picking their hand-named branch as the feature got
// `featureBranch === baseBranch`, the rev-list gate skipped PR creation,
// and the override-active warning never fired.

import { spawn } from "node:child_process";
import {
  isCancel as defaultIsCancel,
  select as defaultSelect,
  text as defaultText,
} from "@clack/prompts";

export type PrTargetDecision =
  | { kind: "silent"; branch: string }
  | { kind: "needs-prompt"; defaultBranch?: string };

export interface DecidePrTargetInput {
  /** The user's current branch (`git rev-parse --abbrev-ref HEAD`). */
  currentBranch: string;
  /** The remote's default branch (`git rev-parse --abbrev-ref origin/HEAD`,
   * with the `origin/` prefix stripped) or `undefined` when `origin/HEAD` is
   * unset. */
  originHead: string | undefined;
}

/**
 * Pure decision: silent when the user's current branch matches `origin/HEAD`
 * (and `origin/HEAD` is set); otherwise the caller is told a prompt is
 * needed and `origin/HEAD` is exposed as the prompt's default (or
 * `undefined` when `origin/HEAD` is unset).
 */
export function decidePrTarget(input: DecidePrTargetInput): PrTargetDecision {
  if (
    input.originHead !== undefined &&
    input.currentBranch === input.originHead
  ) {
    return { kind: "silent", branch: input.originHead };
  }
  return { kind: "needs-prompt", defaultBranch: input.originHead };
}

export type PrTargetOutcome =
  | { kind: "chosen"; branch: string }
  | { kind: "cancelled" };

export interface PromptPrTargetInput {
  /** `origin/HEAD` resolved at run start, or `undefined` when unset.
   * Surfaces as the select's default; `undefined` skips the select layer
   * and goes straight to the text prompt. */
  defaultBranch: string | undefined;
  /** Repo root passed to the local-ref verify step. */
  repoRoot: string;
}

/** Test seam for `@clack/prompts.select`. */
export type SelectFn = typeof defaultSelect;
/** Test seam for `@clack/prompts.text`. */
export type TextFn = typeof defaultText;
/** Test seam for `@clack/prompts.isCancel`. Narrowed to `boolean`. */
export type IsCancelFn = (value: unknown) => boolean;
/** Test seam for the local-ref verify step. Resolves to `true` when the
 * branch resolves locally, `false` otherwise. Defaults to running
 * `git rev-parse --verify <branch>` in `repoRoot`. */
export type VerifyRefFn = (
  repoRoot: string,
  branch: string
) => Promise<boolean>;

async function defaultVerifyRef(
  repoRoot: string,
  branch: string
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["rev-parse", "--verify", branch], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", () => {
      resolve(false);
    });
    child.on("close", (code) => {
      resolve(code === 0);
    });
  });
}

/**
 * Render the PR-target prompt. When `defaultBranch` is defined, presents a
 * `select` between `[origin/HEAD]` (default cursor) and a "Type another..."
 * escape hatch that spawns a `text` prompt; when undefined, goes straight to
 * the `text` prompt with no default. A user-typed branch is verified via
 * `verifyRef`; failure re-prompts with the `git fetch && git checkout` hint.
 */
export async function promptPrTarget(
  input: PromptPrTargetInput,
  selectFn: SelectFn = defaultSelect,
  textFn: TextFn = defaultText,
  isCancelFn: IsCancelFn = defaultIsCancel,
  verifyRefFn: VerifyRefFn = defaultVerifyRef
): Promise<PrTargetOutcome> {
  // Use a per-call symbol so the "type another" sentinel cannot collide with
  // any user-typed branch name and survives a stub-returned cancel signal
  // (clack's cancel symbol is a different reference).
  const typeAnotherSentinel = Symbol("pr-target.type-another");

  if (input.defaultBranch !== undefined) {
    const choice = await selectFn<string | symbol>({
      message: "Pick the PR target branch:",
      options: [
        {
          value: input.defaultBranch,
          label: `${input.defaultBranch} (origin/HEAD)`,
        },
        {
          value: typeAnotherSentinel,
          label: "Type another...",
        },
      ],
      initialValue: input.defaultBranch,
    });
    if (isCancelFn(choice)) return { kind: "cancelled" };
    if (typeof choice === "string") {
      return { kind: "chosen", branch: choice };
    }
    // Fall through to the text prompt: user picked "Type another..." (or a
    // stubbed select returned the second option's symbol value).
  }

  let promptMessage = "PR target branch (must resolve locally):";
  for (;;) {
    const typed = await textFn({
      message: promptMessage,
    });
    if (isCancelFn(typed)) return { kind: "cancelled" };
    const branch = (typed as string).trim();
    if (branch === "") {
      promptMessage = "Branch name cannot be empty. Try again:";
      continue;
    }
    const ok = await verifyRefFn(input.repoRoot, branch);
    if (ok) return { kind: "chosen", branch };
    promptMessage = `\`${branch}\` does not resolve locally. Run \`git fetch && git checkout ${branch}\` then re-enter:`;
  }
}
