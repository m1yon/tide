// Interactive clack prompts:
//   - pickParent: single-select over the parent / standalone tree, sorted by
//     issue-number desc, formatted "#NN <title> (X subs)" (suffix omitted for
//     standalones).
//   - resolveLinearIssue: "create new" vs "use existing" select, then either
//     create via the Linear SDK or paste-with-revalidate to fetch an existing
//     issue. Loops on Linear-create failure so the user can switch to "paste
//     existing" without re-running the whole flow.

import { select, text, isCancel, cancel, spinner, log } from "@clack/prompts";
import type { TreeNode } from "../github/index.ts";
import {
  createIssueForParent,
  fetchExistingIssue,
  type LinearContext,
  type LinearResult,
  type ParentForLinear,
} from "../linear/index.ts";
import { parseLinearInput } from "../linear-input-parser/index.ts";

export async function pickParent(tree: TreeNode[]): Promise<TreeNode> {
  const sorted = [...tree].sort((a, b) => b.root.number - a.root.number);
  const options = sorted.map((node) => {
    const subCount = node.subs.length;
    const suffix = subCount > 0 ? ` (${String(subCount)} subs)` : "";
    return {
      value: node.root.number,
      label: `#${String(node.root.number)} ${node.root.title}${suffix}`,
    };
  });

  const picked = await select({
    message: "Pick a parent issue (or standalone):",
    options,
  });

  if (isCancel(picked)) {
    cancel("Cancelled.");
    process.exit(0);
  }

  const found = tree.find((n) => n.root.number === picked);
  if (!found) {
    // Should be impossible: picked is one of the values we passed in.
    throw new Error(
      `Internal error: picked issue ${String(picked)} not in tree`
    );
  }
  return found;
}

// Loops until either (a) the user successfully creates a new Linear issue,
// (b) the user successfully fetches an existing one, or (c) they cancel.
//
// On a Linear-create failure the user is bounced back to the create-vs-existing
// select, not aborted. On bad existing-paste input the text prompt re-prompts
// inline.
export async function resolveLinearIssue(
  ctx: LinearContext,
  parent: ParentForLinear
): Promise<LinearResult> {
  for (;;) {
    const choice = await select<"create" | "existing">({
      message: "Linear issue:",
      options: [
        { value: "create", label: "Create new Linear issue" },
        {
          value: "existing",
          label: "Use existing Linear issue (paste ID or URL)",
        },
      ],
    });
    if (isCancel(choice)) {
      cancel("Cancelled.");
      process.exit(0);
    }

    if (choice === "create") {
      const sp = spinner();
      sp.start("Creating Linear issue");
      try {
        const result = await createIssueForParent(ctx, parent);
        sp.stop(`Linear issue created: ${result.identifier}`);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sp.stop("Linear create failed");
        log.error(msg);
        // Loop back to the create-vs-existing select.
        continue;
      }
    }

    // Existing path: text input with inline re-validation.
    const raw = await text({
      message: "Paste Linear ID or URL:",
      placeholder: "MEC-680 or https://linear.app/.../issue/MEC-680/...",
      validate: (value) => {
        const parsed = parseLinearInput(value ?? "");
        if (!parsed) {
          return "Not a valid Linear identifier or issue URL. Try `MEC-680` or a full Linear issue URL.";
        }
        return undefined;
      },
    });
    if (isCancel(raw)) {
      cancel("Cancelled.");
      process.exit(0);
    }
    const identifier = parseLinearInput(raw);
    if (identifier === null) {
      // Should be impossible: validate() above only allows parseable input.
      log.error("Internal error: validated input failed to parse.");
      continue;
    }

    const sp = spinner();
    sp.start(`Fetching Linear issue ${identifier}`);
    try {
      const result = await fetchExistingIssue(ctx, identifier);
      sp.stop(`Linear issue resolved: ${result.identifier}`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sp.stop("Linear fetch failed");
      log.error(msg);
      // Loop back to the top so the user can try a different ID or switch to
      // "create new".
      continue;
    }
  }
}
